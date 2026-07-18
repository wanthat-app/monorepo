/**
 * The ledger writer (ADR-0002/0009): the SOLE money mutator. Receives resolved conversions
 * from the retailer-settlement poll and appends the append-only ledger — one `wallet_entry`
 * per party per status, deduplicated by the `(order_id, kind, status)` unique index, each
 * landed row chained into the audit log IN THE SAME TRANSACTION (atomic pair, 2026-07-18).
 * One `ConversionEvent` console.log line per conversion
 * whose status produced at least one new row (per order+status, not per party row) feeds the
 * Logs → Firehose → Athena funnel.
 *
 * The conversions stat is a DERIVED projection (refactor PR-6): after the batch, the writer
 * answers the ABSOLUTE per-recommendation `count(DISTINCT order_id)` from the ledger itself
 * (`conversionTotals`), and the caller applies it to DynamoDB as idempotent SETs — this
 * function is pure Aurora and never touches DynamoDB. A totals-query failure yields an empty
 * record (logged): money already landed, and absolute totals self-heal on the next batch.
 * Per-conversion isolation: one bad order lands in `failed`, the batch survives.
 */
import {
  ConversionEvent,
  type ConversionWrite,
  type WriteConversionsResponse,
} from "@wanthat/contracts";
import {
  appendWalletEntryAudited,
  conversionTotalsFor,
  type createDb,
  type WalletEntryInsert,
} from "@wanthat/db";

/** The Kysely handle type, derived from createDb so this service needs no direct kysely dep. */
type Db = ReturnType<typeof createDb>;

export interface WriterDeps {
  db: Db;
  now: () => Date;
}

const bigintReplacer = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);

function entriesOf(write: ConversionWrite): WalletEntryInsert[] {
  const { resolved } = write;
  const rows: WalletEntryInsert[] = [
    {
      cognitoSub: resolved.referrer.sub,
      kind: "referrer_cashback",
      amountMinor: resolved.referrer.reward.amountMinor,
      currency: resolved.referrer.reward.currency,
      orderId: resolved.orderId,
      recommendationId: resolved.recommendationId,
      status: resolved.status,
    },
  ];
  if (resolved.consumer) {
    rows.push({
      cognitoSub: resolved.consumer.sub,
      kind: "consumer_reward",
      amountMinor: resolved.consumer.reward.amountMinor,
      currency: resolved.consumer.reward.currency,
      orderId: resolved.orderId,
      recommendationId: resolved.recommendationId,
      status: resolved.status,
    });
  }
  return rows;
}

export async function writeConversions(
  conversions: ConversionWrite[],
  deps: WriterDeps,
): Promise<WriteConversionsResponse> {
  const appended: WriteConversionsResponse["appended"] = [];
  const failed: WriteConversionsResponse["failed"] = [];

  for (const write of conversions) {
    const { resolved } = write;
    try {
      let anyNew = false;
      for (const entry of entriesOf(write)) {
        // Atomic pair (2026-07-18): the wallet row and its audit witness commit in ONE
        // transaction — a failed audit rolls the money row back; the idempotent no-op
        // replay appends neither.
        const inserted = await appendWalletEntryAudited(deps.db, entry, {
          type: "wallet_entry",
          cognitoSub: entry.cognitoSub,
          kind: entry.kind,
          amountMinor: entry.amountMinor.toString(),
          currency: entry.currency,
          orderId: entry.orderId,
          recommendationId: entry.recommendationId,
          status: entry.status,
        });
        if (!inserted) continue; // idempotent re-read — already chained + counted + emitted
        anyNew = true;
        appended.push({ orderId: entry.orderId, kind: entry.kind, status: entry.status });
      }
      if (anyNew) {
        // Funnel analytics (the writer log group's subscription filter ships this line).
        console.log(
          JSON.stringify(
            ConversionEvent.parse({
              type: "conversion",
              orderId: resolved.orderId,
              recommendationId: resolved.recommendationId,
              consumer: write.consumer,
              amount: write.gross,
              status: resolved.status,
              at: deps.now().toISOString(),
            }),
            bigintReplacer,
          ),
        );
      }
    } catch (err) {
      failed.push({ orderId: resolved.orderId, error: String(err) });
    }
  }

  // The derived conversions projection: absolute distinct-order counts for EVERY recommendation
  // in the batch (failed orders included — the count is read from the ledger, so it is correct
  // regardless of what this batch landed). Runs after the appends and never fails money: a
  // query failure degrades to an empty record — the next batch's totals repair the stat.
  let conversionTotals: Record<string, number> = {};
  try {
    conversionTotals = await conversionTotalsFor(
      deps.db,
      conversions.map((c) => c.resolved.recommendationId),
    );
  } catch (err) {
    console.error("conversion totals query failed (stat self-heals next batch)", String(err));
  }

  return { appended, failed, conversionTotals };
}
