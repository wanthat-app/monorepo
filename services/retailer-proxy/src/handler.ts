/**
 * Retailer Proxy (ADR-0002, ADR-0004) — the single non-VPC egress to retailer APIs.
 * Sole holder of the secret-scoped retailer credential + HMAC client (packages/aliexpress).
 * Invoked by the Lambdalith (`generateLink`, synchronous) and by the EventBridge heartbeat
 * (`listOrders`, the ADR-0009 conversion poll). Never touches Aurora; the in-VPC
 * conversion-poller-writer persists the money (this proxy invokes it — the endpoint-free VPC
 * cannot invoke outward, so the chain runs proxy → writer, never the reverse).
 *
 * Known ops never throw — they answer a typed error the caller maps.
 */
import { Logger } from "@aws-lambda-powertools/logger";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { AliExpressClient } from "@wanthat/aliexpress";
import {
  CashbackConsumerBps,
  CashbackReferrerBps,
  GenerateLinkRequest,
  type PollOrdersResponse,
  RetailerAliexpressTrackingId,
  type WriteConversionsRequest,
  WriteConversionsResponse,
} from "@wanthat/contracts";
import {
  GuestAttributionRepo,
  getDocClient,
  PollerStateRepo,
  ProductRepo,
  RecommendationRepo,
  RuntimeConfigRepo,
  UnattributedOrderRepo,
} from "@wanthat/dynamo";
import { RetailerCredentialsReader } from "./credentials";
import { type GenerateLinkDeps, type GenerateLinkWire, generateLink } from "./generate-link";
import { type PollOrdersDeps, pollOrders } from "./poll-orders";
import { type SettleClaimsDeps, settleClaims } from "./settle-claims";

const SERVICE = "retailer-proxy";
const logger = new Logger({ serviceName: SERVICE });

export type RetailerProxyEvent =
  | { op: "generateLink"; retailer: "aliexpress"; url: string }
  // The poll op computes its own window (CONFIG + watermark) — the heartbeat carries none.
  | { op: "listOrders"; retailer: "aliexpress" };

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required env var: ${name}`);
  return value;
}

let cached: { link: GenerateLinkDeps; poll: PollOrdersDeps; claims: SettleClaimsDeps } | undefined;

/** Per-container dependency graph; the credential fetch is memoized inside the reader. */
function getDeps(): { link: GenerateLinkDeps; poll: PollOrdersDeps; claims: SettleClaimsDeps } {
  if (cached) return cached;
  const region = process.env.AWS_REGION ?? "il-central-1";
  const doc = getDocClient(region);
  const credentials = new RetailerCredentialsReader(requireEnv("RETAILER_SECRET_ARN"));
  const config = new RuntimeConfigRepo(doc, requireEnv("RUNTIME_CONFIG_TABLE"));
  const client = async () => {
    const creds = await credentials.get();
    if (!creds) return null;
    // Admin-tunable (runtime config, next to the credentials): must name a tracking id that
    // exists in the AliExpress portal. Read per client build — an admin change applies on the
    // next invoke, no redeploy.
    const trackingId = RetailerAliexpressTrackingId.parse(
      await config.get("retailer.aliexpressTrackingId"),
    );
    return new AliExpressClient({ ...creds, trackingId });
  };

  // Dry mode until the writer ships/wires: resolved conversions are logged, never written.
  const writerFn = process.env.CONVERSION_WRITER_FUNCTION;
  const lambda = writerFn ? new LambdaClient({}) : undefined;
  const invokeWriter =
    writerFn && lambda
      ? async (req: WriteConversionsRequest): Promise<WriteConversionsResponse> => {
          const res = await lambda.send(
            new InvokeCommand({
              FunctionName: writerFn,
              Payload: Buffer.from(
                // Money is bigint in code, decimal-string on the wire.
                JSON.stringify(req, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
              ),
            }),
          );
          if (res.FunctionError || !res.Payload) {
            throw new Error(`writer invoke failed: ${res.FunctionError ?? "empty payload"}`);
          }
          return WriteConversionsResponse.parse(
            JSON.parse(Buffer.from(res.Payload).toString("utf8")),
          );
        }
      : null;

  const unattributed = new UnattributedOrderRepo(doc, requireEnv("UNATTRIBUTED_ORDER_TABLE"));
  const recommendations = new RecommendationRepo(doc, requireEnv("RECOMMENDATION_TABLE"));

  cached = {
    link: {
      products: new ProductRepo(doc, requireEnv("PRODUCT_TABLE")),
      client,
      logger,
    },
    poll: {
      client,
      state: new PollerStateRepo(doc, requireEnv("POLLER_STATE_TABLE")),
      config,
      attribution: {
        recommendations,
        guests: new GuestAttributionRepo(doc, requireEnv("GUEST_ATTRIBUTION_TABLE")),
        env: requireEnv("WANTHAT_ENV"),
        // Deleted-recommendation fallback economics: the config split as of the conversion.
        fallbackSplit: async () => {
          const [referrerBps, consumerBps] = await Promise.all([
            config.get("cashback.referrerBps"),
            config.get("cashback.consumerBps"),
          ]);
          return {
            referrerBps: CashbackReferrerBps.parse(referrerBps),
            consumerBps: CashbackConsumerBps.parse(consumerBps),
          };
        },
        now: () => new Date(),
      },
      unattributed,
      invokeWriter,
      now: () => new Date(),
      logger,
    },
    claims: {
      unattributed,
      recommendations,
      invokeWriter,
      now: () => new Date(),
      logger,
    },
  };
  return cached;
}

export const handler = async (
  event: RetailerProxyEvent,
): Promise<GenerateLinkWire | PollOrdersResponse> => {
  logger.appendKeys({ op: event.op, retailer: event.retailer });
  switch (event.op) {
    case "generateLink": {
      const request = GenerateLinkRequest.safeParse(event);
      if (!request.success) return { status: "error", code: "unsupported_url" };
      return generateLink(request.data.url, getDeps().link);
    }
    case "listOrders": {
      const summary = await pollOrders(getDeps().poll);
      logger.info("poll_summary", { summary: JSON.stringify(summary) });
      // Claim settlement rides EVERY heartbeat (retailer API untouched), so an admin claim
      // lands in the ledger within ~15 minutes regardless of the poll gate.
      const claims = await settleClaims(getDeps().claims);
      if (claims.processed > 0) logger.info("claims_summary", { ...claims });
      return summary;
    }
    default: {
      const exhaustive: never = event;
      throw new Error(`unknown op: ${JSON.stringify(exhaustive)}`);
    }
  }
};
