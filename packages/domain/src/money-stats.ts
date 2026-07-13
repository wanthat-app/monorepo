/**
 * Platform-wide money KPI derivation over reward rows of the append-only `wallet_entry` ledger
 * (spec 2026-07-13). Same lifecycle model as `deriveBalances` (wallet.ts): a reward's rows share
 * `(currency, orderId, kind)` and the furthest-advanced status wins — pending < confirmed <
 * clawback, clawback contributes 0. Pure exact-bigint math; the caller fetches rows
 * (`@wanthat/db` `listRewardRows`) and pre-stamps each with its Asia/Jerusalem bucket `date`
 * (this module stays timezone- and IO-free).
 */

export interface MoneyStatsRow {
  kind: "referrer_cashback" | "consumer_reward";
  amountMinor: bigint;
  currency: string;
  orderId: string | null;
  status: "pending" | "confirmed" | "clawback";
  /** Asia/Jerusalem bucket of the row's created_at, YYYY-MM-DD (caller-computed). */
  date: string;
}

export interface MoneyCurrencyTotals {
  currency: string;
  /** All-time Σ of collapsed rewards at `confirmed`. */
  confirmedMinor: bigint;
  /** All-time Σ of collapsed rewards at `pending`. */
  pendingMinor: bigint;
  /** Σ of rewards whose collapsed status is confirmed AND whose confirmed row falls in the window. */
  confirmedInWindowMinor: bigint;
}

export interface DerivedMoneyStats {
  /** Per-currency totals, sorted by currency (deterministic wire order). */
  totals: MoneyCurrencyTotals[];
  /** Distinct orders (any reward row) first seen inside the window. */
  conversionsInWindow: number;
  /** Dense daily distinct-order counts over exactly the given dates. */
  dailyConversions: { date: string; count: number }[];
}

const STATUS_RANK = { pending: 0, confirmed: 1, clawback: 2 } as const;

/**
 * Derive the dashboard money KPIs. `dates` is the dense ascending 30-day axis (Jerusalem);
 * window membership is set membership in `dates`.
 */
export function deriveMoneyStats(rows: MoneyStatsRow[], dates: string[]): DerivedMoneyStats {
  const window = new Set(dates);

  // Collapse each reward's lifecycle rows to the furthest-advanced row (deriveBalances rule);
  // orphan rows (no orderId) stand alone. Track each distinct order's earliest-seen date.
  const rewards = new Map<string, MoneyStatsRow>();
  const orderFirstSeen = new Map<string, string>();
  let orphan = 0;
  for (const row of rows) {
    const key =
      row.orderId === null ? `orphan#${orphan++}` : `${row.currency}#${row.orderId}#${row.kind}`;
    const seen = rewards.get(key);
    if (!seen || STATUS_RANK[row.status] > STATUS_RANK[seen.status]) rewards.set(key, row);
    if (row.orderId !== null) {
      const first = orderFirstSeen.get(row.orderId);
      if (!first || row.date < first) orderFirstSeen.set(row.orderId, row.date);
    }
  }

  const perCurrency = new Map<string, MoneyCurrencyTotals>();
  const totalsFor = (currency: string): MoneyCurrencyTotals => {
    let totals = perCurrency.get(currency);
    if (!totals) {
      totals = { currency, confirmedMinor: 0n, pendingMinor: 0n, confirmedInWindowMinor: 0n };
      perCurrency.set(currency, totals);
    }
    return totals;
  };
  for (const reward of rewards.values()) {
    const totals = totalsFor(reward.currency);
    if (reward.status === "clawback") continue; // clawed back: contributes 0 (but keeps its currency row)
    if (reward.status === "confirmed") {
      totals.confirmedMinor += reward.amountMinor;
      // The winning row IS the confirmed row, so its date is the confirmation bucket.
      if (window.has(reward.date)) totals.confirmedInWindowMinor += reward.amountMinor;
    } else {
      totals.pendingMinor += reward.amountMinor;
    }
  }

  // Conversions: one per distinct order, on its earliest-seen bucket.
  const byDay = new Map(dates.map((d) => [d, 0]));
  let conversionsInWindow = 0;
  for (const first of orderFirstSeen.values()) {
    if (!window.has(first)) continue;
    conversionsInWindow += 1;
    byDay.set(first, (byDay.get(first) ?? 0) + 1);
  }

  return {
    totals: [...perCurrency.values()].sort((a, b) => a.currency.localeCompare(b.currency)),
    conversionsInWindow,
    dailyConversions: dates.map((date) => ({ date, count: byDay.get(date) ?? 0 })),
  };
}
