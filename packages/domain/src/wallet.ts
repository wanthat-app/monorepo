import type { WalletBalance, WalletEntryKind, WalletEntryStatus } from "@wanthat/contracts";

/**
 * Balance derivation over the append-only `wallet_entry` ledger (ADR-0002/0009). The ledger never
 * updates a row: a reward's lifecycle is a SEQUENCE of rows sharing `(orderId, kind)` — pending,
 * then confirmed, then possibly clawback — so the balance is derived, per reward, from the
 * furthest-advanced status only. Pure exact-bigint math; the caller fetches the rows
 * (`@wanthat/db` `listEntriesForSub`) and serialises per the Money wire rule.
 */

/** The subset of a `wallet_entry` row the derivation needs (db column casing already mapped). */
export interface LedgerRow {
  kind: WalletEntryKind;
  amountMinor: bigint;
  currency: string;
  orderId: string | null;
  status: WalletEntryStatus;
}

/** Lifecycle order (ADR-0009): the furthest status wins; clawback supersedes and contributes 0. */
const STATUS_RANK: Record<WalletEntryStatus, number> = { pending: 0, confirmed: 1, clawback: 2 };

interface CurrencyTotals {
  recommender: { confirmed: bigint; pending: bigint };
  buyer: { confirmed: bigint; pending: bigint };
  /** Non-reward movements folded straight into `available` (adjustments − withdrawals). */
  movements: bigint;
}

/**
 * Derive one `WalletBalance` per currency held (the contract in `contracts/wallet/balance.ts`):
 * `asRecommender`/`asBuyer` split reward earnings confirmed vs pending;
 * `available = Σ confirmed rewards + adjustments − withdrawals`. Output ordered by currency so
 * the wire shape is deterministic.
 */
export function deriveBalances(rows: LedgerRow[]): WalletBalance[] {
  const perCurrency = new Map<string, CurrencyTotals>();
  const totalsFor = (currency: string): CurrencyTotals => {
    let totals = perCurrency.get(currency);
    if (!totals) {
      totals = {
        recommender: { confirmed: 0n, pending: 0n },
        buyer: { confirmed: 0n, pending: 0n },
        movements: 0n,
      };
      perCurrency.set(currency, totals);
    }
    return totals;
  };

  // Collapse each reward's lifecycle rows to its furthest-advanced row, keyed per (orderId, kind).
  // A reward row with no orderId cannot be collapsed against anything, so it stands alone.
  const rewards = new Map<string, LedgerRow>();
  let orphan = 0;
  for (const row of rows) {
    switch (row.kind) {
      case "referrer_cashback":
      case "consumer_reward": {
        const key =
          row.orderId === null
            ? `orphan#${orphan++}`
            : `${row.currency}#${row.orderId}#${row.kind}`;
        const seen = rewards.get(key);
        if (!seen || STATUS_RANK[row.status] > STATUS_RANK[seen.status]) rewards.set(key, row);
        break;
      }
      case "adjustment":
        totalsFor(row.currency).movements += row.amountMinor;
        break;
      case "withdrawal":
        totalsFor(row.currency).movements -= row.amountMinor;
        break;
    }
  }

  for (const reward of rewards.values()) {
    if (reward.status === "clawback") continue; // clawed back: contributes 0 everywhere
    const totals = totalsFor(reward.currency);
    const bucket = reward.kind === "referrer_cashback" ? totals.recommender : totals.buyer;
    bucket[reward.status] += reward.amountMinor;
  }

  return [...perCurrency.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([currency, totals]) => ({
      asRecommender: {
        confirmed: { amountMinor: totals.recommender.confirmed, currency },
        pending: { amountMinor: totals.recommender.pending, currency },
      },
      asBuyer: {
        confirmed: { amountMinor: totals.buyer.confirmed, currency },
        pending: { amountMinor: totals.buyer.pending, currency },
      },
      available: {
        amountMinor: totals.recommender.confirmed + totals.buyer.confirmed + totals.movements,
        currency,
      },
    }));
}
