/**
 * Ledger-writer (ADR-0002/0009; refactor PR-6 renamed it from conversion-poller) — the in-VPC
 * leg of the conversion chain and the SOLE money mutator, connecting to Aurora as the
 * `ledger_writer` role (migration 0008). Invoked by the retailer-settlement poll (never
 * scheduled directly: the endpoint-free VPC cannot invoke outward, so the non-VPC settlement
 * orchestrates and calls in). Ledger rows are keyed by the attributed sub DIRECTLY (ADR-0020
 * as amended by ADR-0006) — there is no customer table and no sub-to-row resolution step.
 * Appends are deduplicated by the `(order_id, kind, status)` unique index; every landed row is
 * audit-chained; analytics ConversionEvents ride this function's log group into the Firehose
 * funnel. Pure Aurora: the conversions stat leaves here only as derived `conversionTotals` in
 * the response — this function holds no DynamoDB access at all.
 */
import { WriteConversionsRequest, type WriteConversionsResponse } from "@wanthat/contracts";
import { waitForDb } from "@wanthat/db";
import { getContext } from "./context";
import { writeConversions } from "./writer";

export const handler = async (event: unknown): Promise<WriteConversionsResponse> => {
  const request = WriteConversionsRequest.parse(event);
  const ctx = getContext();
  // Ride out an Aurora scale-to-zero resume before the first insert. Bounded probes (6s each,
  // ~78s total under the 90s Lambda budget) so a resuming-but-not-serving cluster can't hang one
  // probe for the whole invocation — the prod 90s-timeout failure mode. A never-waking cluster
  // throws cleanly here and the caller's next heartbeat retries (idempotent on the unique index).
  await waitForDb(ctx.db, { attempts: 12, delayMs: 500, probeTimeoutMs: 6_000 });
  return writeConversions(request.conversions, {
    db: ctx.db,
    now: () => new Date(),
  });
};
