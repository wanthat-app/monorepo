/**
 * Retailer Proxy (ADR-0002, ADR-0004) — the single non-VPC egress to retailer APIs.
 * Sole holder of the secret-scoped retailer credential + HMAC client (packages/aliexpress).
 * Invoked by the Lambdalith (`generateLink`, synchronous) and by EventBridge → poll
 * (`listOrders`). Never touches Aurora; in-VPC writers persist the results.
 *
 * Walking skeleton — both ops return `not_implemented` (never throw on a known op, so an invoke
 * from the Lambdalith/poller does not surface as a 5xx). Wire the signed client and the DynamoDB
 * projection / attribution resolution here.
 */
import { Logger } from "@aws-lambda-powertools/logger";

const SERVICE = "retailer-proxy";
const logger = new Logger({ serviceName: SERVICE });

export type RetailerProxyEvent =
  | { op: "generateLink"; retailer: "aliexpress"; url: string; subId: string }
  | {
      op: "listOrders";
      retailer: "aliexpress";
      startTime: string;
      endTime: string;
      status: string;
    };

export const handler = async (
  event: RetailerProxyEvent,
): Promise<{ status: "not_implemented"; service: string; op: RetailerProxyEvent["op"] }> => {
  logger.appendKeys({ op: event.op, retailer: event.retailer });
  switch (event.op) {
    case "generateLink":
      // TODO: sign aliexpress.affiliate.link.generate; write short_id→url to DynamoDB.
      logger.info("not_implemented");
      return { status: "not_implemented", service: SERVICE, op: event.op };
    case "listOrders":
      // TODO: aliexpress.affiliate.order.listbyindex (cursor loop); resolve attribution.
      logger.info("not_implemented");
      return { status: "not_implemented", service: SERVICE, op: event.op };
    default: {
      const exhaustive: never = event;
      throw new Error(`unknown op: ${JSON.stringify(exhaustive)}`);
    }
  }
};
