/**
 * Conversion poller (ADR-0002, ADR-0009). Triggered by EventBridge Scheduler on a CONFIGURABLE
 * period. Via the Retailer Proxy, calls aliexpress.affiliate.order.listbyindex (api-sg gateway,
 * HMAC-SHA256) over an overlapping window in GMT+8, cursor-paginated; the proxy resolves
 * custom_parameters -> referrer (ref = recommendationId -> recommendation owner + product) +
 * consumer (c = customer_id, or g = guestId via the DynamoDB guest_attribution lookup) into a
 * ResolvedConversion, then invokes the in-VPC writer; idempotent upsert on (order_id, kind),
 * driving the ledger pending -> confirmed -> clawback plus the audit log, and emitting a
 * conversion event to Firehose. Sole money-writer (append-only DB role).
 *
 * Stub.
 */
export const handler = async (): Promise<unknown> => {
  throw new Error("not implemented");
};
