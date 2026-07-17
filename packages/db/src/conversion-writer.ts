import type { Kysely } from "kysely";
import type { Database } from "./schema";

/**
 * The poller-writer's ledger primitives (ADR-0002/0009). Append-only by construction: inserts
 * only, deduplicated by the unique partial index `wallet_entry_order_kind_status_idx
 * (order_id, kind, status)` — a re-read window re-offers the same rows and they no-op, while a
 * status advance (pending → confirmed → clawback) is a NEW immutable row. Every row that
 * actually lands must also be chained into the audit log via `appendAudit` (see audit.ts) —
 * the caller sequences that, keyed off this function's return.
 */
export interface WalletEntryInsert {
  cognitoSub: string;
  kind: "referrer_cashback" | "consumer_reward" | "adjustment" | "withdrawal";
  amountMinor: bigint;
  currency: string;
  orderId: string;
  recommendationId: string;
  status: "pending" | "confirmed" | "clawback";
}

/** INSERT ... ON CONFLICT DO NOTHING; true when a row was actually inserted. */
export async function appendWalletEntry(
  db: Kysely<Database>,
  entry: WalletEntryInsert,
): Promise<boolean> {
  const inserted = await db
    .insertInto("wallet_entry")
    .values({
      cognito_sub: entry.cognitoSub,
      kind: entry.kind,
      amount_minor: entry.amountMinor,
      currency: entry.currency,
      order_id: entry.orderId,
      recommendation_id: entry.recommendationId,
      status: entry.status,
    })
    .onConflict((oc) => oc.doNothing())
    .returning("id")
    .executeTakeFirst();
  return inserted !== undefined;
}
