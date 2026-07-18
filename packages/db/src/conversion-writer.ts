import type { Kysely } from "kysely";
import { appendAudit } from "./audit";
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

/**
 * Atomic pair (2026-07-18): the wallet append and its audit witness commit in ONE Aurora
 * transaction — a failed audit rolls the money row back, so no ledger row can ever exist
 * unwitnessed. The idempotent no-op replay (unique-index conflict) appends NOTHING, so no
 * orphan audit entries either. This is the single intra-store exception to the
 * no-cross-table-transaction rule — that rule's target is cross-STORE coordination, which
 * stays forbidden. audit_append's advisory lock is xact-scoped, so the pair holds it only
 * until commit.
 */
export async function appendWalletEntryAudited(
  db: Kysely<Database>,
  entry: WalletEntryInsert,
  auditPayload: unknown,
): Promise<boolean> {
  return db.transaction().execute(async (trx) => {
    const inserted = await appendWalletEntry(trx, entry);
    if (inserted) await appendAudit(trx, auditPayload);
    return inserted;
  });
}

/**
 * The derived conversions projection (refactor PR-6): per recommendation, the ABSOLUTE number
 * of distinct converted orders — `count(DISTINCT order_id)` over its `referrer_cashback` rows
 * (served by the partial index `wallet_entry_recommendation_referrer_idx`, migration 0009).
 * Semantics parity with the retired once-per-order first-sight increment: one order counts once
 * however many status rows (pending → confirmed → clawback) it accumulates, and a clawback does
 * NOT subtract. The caller applies these as idempotent SETs on the DynamoDB stat, so the ledger
 * — not the counter — stays the source of truth and a lost application self-heals.
 *
 * Ids absent from the ledger answer 0 explicitly, so a SET can still repair a drifted counter.
 */
export async function conversionTotalsFor(
  db: Kysely<Database>,
  recommendationIds: readonly string[],
): Promise<Record<string, number>> {
  const totals: Record<string, number> = {};
  const unique = [...new Set(recommendationIds)];
  if (unique.length === 0) return totals;
  for (const id of unique) totals[id] = 0;
  const rows = await db
    .selectFrom("wallet_entry")
    .select((eb) => ["recommendation_id", eb.fn.count<string>("order_id").distinct().as("orders")])
    .where("kind", "=", "referrer_cashback")
    .where("recommendation_id", "in", unique)
    .groupBy("recommendation_id")
    .execute();
  for (const row of rows) {
    if (row.recommendation_id !== null) totals[row.recommendation_id] = Number(row.orders);
  }
  return totals;
}
