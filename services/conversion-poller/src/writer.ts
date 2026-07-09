/**
 * The conversion writer (ADR-0002/0009): the SOLE money mutator. Receives resolved conversions
 * from the retailer-proxy poll and appends the append-only ledger — one `wallet_entry` per
 * party per status, deduplicated by the `(order_id, kind, status)` unique index, each landed
 * row chained into the audit log. One `ConversionEvent` console.log line per conversion whose
 * status produced at least one new row (per order+status, not per party row) feeds the
 * Logs → Firehose → Athena funnel. A first-sight pending referrer row bumps the
 * recommendation's conversions stat (best-effort, never fails money).
 * Per-conversion isolation: one bad order lands in `failed`, the batch survives.
 */
import {
  ConversionEvent,
  type ConversionWrite,
  type WriteConversionsResponse,
} from "@wanthat/contracts";
import { appendAudit, appendWalletEntry, type createDb, type WalletEntryInsert } from "@wanthat/db";

/** The Kysely handle type, derived from createDb so this service needs no direct kysely dep. */
type Db = ReturnType<typeof createDb>;

export interface WriterDeps {
  db: Db;
  recommendations: { incrementConversions(recommendationId: string): Promise<void> };
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
        const inserted = await appendWalletEntry(deps.db, entry);
        if (!inserted) continue; // idempotent re-read — already chained + counted + emitted
        anyNew = true;
        appended.push({ orderId: entry.orderId, kind: entry.kind, status: entry.status });
        await appendAudit(deps.db, {
          type: "wallet_entry",
          cognitoSub: entry.cognitoSub,
          kind: entry.kind,
          amountMinor: entry.amountMinor.toString(),
          currency: entry.currency,
          orderId: entry.orderId,
          recommendationId: entry.recommendationId,
          status: entry.status,
        });
      }
      if (anyNew) {
        // Funnel analytics (the poller log group's subscription filter ships this line).
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
        // First sight of the order (its pending stage) → the recommendation's stat.
        if (resolved.status === "pending") {
          try {
            await deps.recommendations.incrementConversions(resolved.recommendationId);
          } catch (err) {
            console.error("conversions counter increment failed", String(err));
          }
        }
      }
    } catch (err) {
      failed.push({ orderId: resolved.orderId, error: String(err) });
    }
  }

  return { appended, failed };
}
