/**
 * Conversion-poller-writer (ADR-0002/0009) — the in-VPC leg of the conversion chain and the
 * SOLE money mutator. Invoked by the retailer-proxy poll (never scheduled directly: the
 * endpoint-free VPC cannot invoke outward, so the non-VPC proxy orchestrates and calls in).
 * Ledger rows are keyed by the attributed sub DIRECTLY (ADR-0020 as amended by ADR-0006) —
 * there is no customer table and no sub-to-row resolution step. Appends are deduplicated by
 * the `(order_id, kind, status)` unique index; every landed row is audit-chained; analytics
 * ConversionEvents ride this function's log group into the Firehose funnel.
 */
import { WriteConversionsRequest, type WriteConversionsResponse } from "@wanthat/contracts";
import { waitForDb } from "@wanthat/db";
import { getContext } from "./context";
import { writeConversions } from "./writer";

export const handler = async (event: unknown): Promise<WriteConversionsResponse> => {
  const request = WriteConversionsRequest.parse(event);
  const ctx = getContext();
  // Ride out an Aurora scale-to-zero resume before the first insert (60s connect budget).
  await waitForDb(ctx.db);
  return writeConversions(request.conversions, {
    db: ctx.db,
    recommendations: ctx.recommendations,
    now: () => new Date(),
  });
};
