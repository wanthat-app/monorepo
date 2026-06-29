/**
 * Conversion poller (ADR-0002, ADR-0009). Triggered by EventBridge Scheduler on an admin-tunable
 * period (CONFIG poller.intervalMinutes; admin-api updates the schedule) and re-scans an admin-tunable
 * lookback window (CONFIG poller.lookbackHours). Via the Retailer Proxy, calls
 * aliexpress.affiliate.order.listbyindex (api-sg gateway,
 * HMAC-SHA256) over an overlapping window in GMT+8, cursor-paginated; the proxy resolves
 * custom_parameters -> referrer (ref = recommendationId -> recommendation owner + product) +
 * consumer (c = customer_id, or g = guestId via the DynamoDB guest_attribution lookup) into a
 * ResolvedConversion, then invokes the in-VPC writer; idempotent upsert on (order_id, kind),
 * driving the ledger pending -> confirmed -> clawback plus the audit log, and emitting a
 * conversion event to Firehose. Sole money-writer (append-only DB role).
 *
 * Walking skeleton — returns `not_implemented` (never throws, so a scheduled invoke does not trip
 * retries/alarms). Real reconciliation lands with the conversion slice.
 */
import { Logger } from "@aws-lambda-powertools/logger";

const SERVICE = "conversion-poller";
const logger = new Logger({ serviceName: SERVICE });

export const handler = async (): Promise<{ status: "not_implemented"; service: string }> => {
  logger.info("not_implemented");
  return { status: "not_implemented", service: SERVICE };
};
