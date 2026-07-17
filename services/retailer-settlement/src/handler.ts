/**
 * Retailer Settlement (ADR-0002/0009; refactor PR-6 split it out of the retailer proxy) — the
 * scheduled half of the retailer egress. The EventBridge heartbeat fires this function every
 * 15 minutes with NO payload (the pre-split `{op:"listOrders"}` discriminator is gone — the
 * heartbeat is the only entry): each beat runs the window poll (self-gated on CONFIG
 * `poller.intervalMinutes`) and then claim settlement (every beat, retailer API untouched).
 *
 * The split rationale: linkgen parses customer-pasted input, so it never shares a role with
 * THIS function's ledger-writer invoke — settlement's inputs are the retailer API and the
 * admin-claimed queue only. Money still flows one way: settlement resolves conversions and
 * invokes the in-VPC ledger-writer (the sole money mutator; the endpoint-free VPC cannot
 * invoke outward, ADR-0004). Each writer response carries the derived per-recommendation
 * conversion totals, applied here to DynamoDB as idempotent, self-healing SETs.
 */
import { Logger } from "@aws-lambda-powertools/logger";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { AliExpressClient, RetailerCredentialsReader } from "@wanthat/aliexpress";
import {
  CashbackConsumerBps,
  CashbackReferrerBps,
  type PollOrdersResponse,
  RetailerAliexpressTrackingId,
  RetailerDebugLogPayloads,
  type WriteConversionsRequest,
  WriteConversionsResponse,
} from "@wanthat/contracts";
import {
  GuestAttributionRepo,
  getDocClient,
  PollerStateRepo,
  RecommendationRepo,
  RuntimeConfigRepo,
  UnattributedOrderRepo,
} from "@wanthat/dynamo";
import { applyingConversionTotals, type InvokeWriter } from "./conversion-totals";
import { type PollOrdersDeps, pollOrders } from "./poll-orders";
import { type SettleClaimsDeps, settleClaims } from "./settle-claims";

const SERVICE = "retailer-settlement";
const logger = new Logger({ serviceName: SERVICE });

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required env var: ${name}`);
  return value;
}

let cached: { poll: PollOrdersDeps; claims: SettleClaimsDeps } | undefined;

/** Per-container dependency graph; the credential fetch is memoized inside the reader. */
function getDeps(): { poll: PollOrdersDeps; claims: SettleClaimsDeps } {
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
    const [trackingId, debugPayloads] = await Promise.all([
      config
        .get("retailer.aliexpressTrackingId")
        .then((v) => RetailerAliexpressTrackingId.parse(v)),
      config.get("retailer.debugLogPayloads").then((v) => RetailerDebugLogPayloads.parse(v)),
    ]);
    return new AliExpressClient({ ...creds, trackingId, debugPayloads });
  };

  const recommendations = new RecommendationRepo(doc, requireEnv("RECOMMENDATION_TABLE"));

  // Dry mode until the writer is wired: resolved conversions are logged, never written.
  const writerFn = process.env.LEDGER_WRITER_FUNCTION;
  const lambda = writerFn ? new LambdaClient({}) : undefined;
  const rawInvoke: InvokeWriter | null =
    writerFn && lambda
      ? async (req: WriteConversionsRequest) => {
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
  // Every successful writer answer carries the derived conversion totals — apply them to the
  // recommendation stat (idempotent SETs, non-fatal) before the caller sees the response.
  const invokeWriter = rawInvoke
    ? applyingConversionTotals(rawInvoke, { recommendations, logger })
    : null;

  const unattributed = new UnattributedOrderRepo(doc, requireEnv("UNATTRIBUTED_ORDER_TABLE"));

  cached = {
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

/** The heartbeat entry — the event carries nothing; every beat polls, then settles claims. */
export const handler = async (): Promise<PollOrdersResponse> => {
  const deps = getDeps();
  const summary = await pollOrders(deps.poll);
  logger.info("poll_summary", { summary: JSON.stringify(summary) });
  // Claim settlement rides EVERY heartbeat (retailer API untouched), so an admin claim lands
  // in the ledger within ~15 minutes regardless of the poll gate.
  const claims = await settleClaims(deps.claims);
  if (claims.processed > 0) logger.info("claims_summary", { ...claims });
  return summary;
};
