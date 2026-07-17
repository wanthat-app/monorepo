import type { LedgerRow } from "@wanthat/domain";
import type { Kysely } from "kysely";
import type { Database, WalletEntryTable } from "./schema";

/**
 * Wallet ledger reads for member-wallet (ADR-0002: reads are `wallet_reader`; only the ledger-writer appends).
 * `amount_minor` is Postgres bigint, which node-postgres returns as a string — every read maps it
 * back to a real `bigint` (money is exact, never a float). MVP volumes are bounded, so the balance
 * path fetches the sub's rows and derives in code (`@wanthat/domain` `deriveBalances`); SQL
 * aggregation is a future optimization.
 */

/** The whole ledger for one member, in derivation shape (unordered — the derivation doesn't care). */
export async function listEntriesForSub(db: Kysely<Database>, sub: string): Promise<LedgerRow[]> {
  const rows = await db
    .selectFrom("wallet_entry")
    .select(["kind", "amount_minor", "currency", "order_id", "status"])
    .where("cognito_sub", "=", sub)
    .execute();
  return rows.map((r) => ({
    kind: r.kind,
    amountMinor: BigInt(r.amount_minor),
    currency: r.currency,
    orderId: r.order_id,
    status: r.status,
  }));
}

/** Keyset cursor: strictly-before position in the `(created_at DESC, id DESC)` order. */
export interface WalletHistoryCursor {
  createdAt: Date;
  id: string;
}

export interface WalletHistoryItem {
  id: string;
  kind: WalletEntryTable["kind"];
  amountMinor: bigint;
  currency: string;
  recommendationId: string | null;
  status: "pending" | "confirmed" | "clawback";
  createdAt: Date;
}

export interface WalletHistoryPage {
  items: WalletHistoryItem[];
  nextCursor: WalletHistoryCursor | null;
}

/**
 * The member's ledger history, newest first — keyset pagination on `(created_at, id)` (`id`
 * breaks timestamp ties, the activity.ts ordering precedent). Fetches limit+1 to decide whether a
 * next page exists without a COUNT.
 */
export async function listWalletHistory(
  db: Kysely<Database>,
  sub: string,
  limit: number,
  cursor?: WalletHistoryCursor,
): Promise<WalletHistoryPage> {
  let query = db
    .selectFrom("wallet_entry")
    .select(["id", "kind", "amount_minor", "currency", "recommendation_id", "status", "created_at"])
    .where("cognito_sub", "=", sub)
    .orderBy("created_at", "desc")
    .orderBy("id", "desc")
    .limit(limit + 1);
  if (cursor) {
    query = query.where((eb) =>
      eb.or([
        eb("created_at", "<", cursor.createdAt),
        eb.and([eb("created_at", "=", cursor.createdAt), eb("id", "<", cursor.id)]),
      ]),
    );
  }

  const rows = await query.execute();
  const pageRows = rows.slice(0, limit);
  const items = pageRows.map((r) => ({
    id: String(r.id),
    kind: r.kind,
    amountMinor: BigInt(r.amount_minor),
    currency: r.currency,
    recommendationId: r.recommendation_id,
    status: r.status,
    createdAt: r.created_at,
  }));
  const last = items.at(-1);
  return {
    items,
    nextCursor: rows.length > limit && last ? { createdAt: last.createdAt, id: last.id } : null,
  };
}
