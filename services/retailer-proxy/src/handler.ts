/**
 * Retailer Proxy (ADR-0002, ADR-0004) — the single non-VPC egress to retailer APIs.
 * Sole holder of the secret-scoped retailer credential + HMAC client (packages/aliexpress).
 * Invoked by the Lambdalith (`generateLink`, synchronous) and by EventBridge → poll
 * (`listOrders`). Never touches Aurora; in-VPC writers persist the results.
 *
 * `generateLink` is live: it mints/reuses the product-level affiliate URL and upserts the
 * Product in DynamoDB (ADR-0004/0008). `listOrders` stays a walking-skeleton stub until the
 * conversion-poller slice. Known ops never throw — they answer a typed error the caller maps.
 */
import { Logger } from "@aws-lambda-powertools/logger";
import { AliExpressClient } from "@wanthat/aliexpress";
import { GenerateLinkRequest } from "@wanthat/contracts";
import { getDocClient, ProductRepo } from "@wanthat/dynamo";
import { RetailerCredentialsReader } from "./credentials";
import { type GenerateLinkDeps, type GenerateLinkWire, generateLink } from "./generate-link";

const SERVICE = "retailer-proxy";
const logger = new Logger({ serviceName: SERVICE });

export type RetailerProxyEvent =
  | { op: "generateLink"; retailer: "aliexpress"; url: string }
  | {
      op: "listOrders";
      retailer: "aliexpress";
      startTime: string;
      endTime: string;
      status: string;
    };

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required env var: ${name}`);
  return value;
}

let cached: GenerateLinkDeps | undefined;

/** Per-container dependency graph; the credential fetch is memoized inside the reader. */
function getDeps(): GenerateLinkDeps {
  if (cached) return cached;
  const region = process.env.AWS_REGION ?? "il-central-1";
  const credentials = new RetailerCredentialsReader(requireEnv("RETAILER_SECRET_ARN"));
  const trackingId = process.env.ALIEXPRESS_TRACKING_ID ?? "wanthat";
  cached = {
    products: new ProductRepo(getDocClient(region), requireEnv("PRODUCT_TABLE")),
    client: async () => {
      const creds = await credentials.get();
      if (!creds) return null;
      return new AliExpressClient({ ...creds, trackingId });
    },
    logger,
  };
  return cached;
}

export const handler = async (
  event: RetailerProxyEvent,
): Promise<GenerateLinkWire | { status: "not_implemented"; service: string; op: string }> => {
  logger.appendKeys({ op: event.op, retailer: event.retailer });
  switch (event.op) {
    case "generateLink": {
      const request = GenerateLinkRequest.safeParse(event);
      if (!request.success) return { status: "error", code: "unsupported_url" };
      return generateLink(request.data.url, getDeps());
    }
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
