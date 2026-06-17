/**
 * Conversion poller (ADR-0002). Triggered by EventBridge Scheduler on a CONFIGURABLE
 * period. Calls aliexpress.affiliate.order.listbyindex (api-sg gateway, HMAC-SHA256)
 * over an overlapping window in GMT+8, cursor-paginated; parses custom_parameters ->
 * referrer (short_id) + consumer (customer_id, or guestId via guest_attribution);
 * idempotent upsert on order_id; drives the ledger pending -> confirmed -> clawback
 * plus the audit log. Sole money-writer (append-only DB role).
 *
 * Stub.
 */
export const handler = async (): Promise<unknown> => {
  throw new Error("not implemented");
};
