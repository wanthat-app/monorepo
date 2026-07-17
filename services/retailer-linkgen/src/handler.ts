/**
 * Retailer Linkgen (ADR-0002/0004; refactor PR-6 split it out of the retailer proxy) — the
 * synchronous link-minting egress to retailer APIs. Invoked by member-catalog (`generateLink`) with
 * customer-pasted input; deliberately holds NO poller state, no attribution reads, and no
 * ledger-writer invoke — the function that parses customer input never shares a role with the
 * money path (that is retailer-settlement's charter). Holds the secret-scoped retailer
 * credential + HMAC client (packages/aliexpress) and owns the Product write (ADR-0004).
 *
 * The wire shape keeps the pre-split `GenerateLinkRequest` (`op`/`retailer` discriminators) so
 * the caller's move here was an env-var flip; a known request never throws — it answers a
 * typed error the caller maps.
 */
import { Logger } from "@aws-lambda-powertools/logger";
import { AliExpressClient, RetailerCredentialsReader } from "@wanthat/aliexpress";
import {
  GenerateLinkRequest,
  RetailerAliexpressTrackingId,
  RetailerDebugLogPayloads,
} from "@wanthat/contracts";
import { getDocClient, ProductRepo, RuntimeConfigRepo } from "@wanthat/dynamo";
import { type GenerateLinkDeps, type GenerateLinkWire, generateLink } from "./generate-link";

const SERVICE = "retailer-linkgen";
const logger = new Logger({ serviceName: SERVICE });

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
  const doc = getDocClient(region);
  const credentials = new RetailerCredentialsReader(requireEnv("RETAILER_SECRET_ARN"));
  const config = new RuntimeConfigRepo(doc, requireEnv("RUNTIME_CONFIG_TABLE"));
  cached = {
    products: new ProductRepo(doc, requireEnv("PRODUCT_TABLE")),
    client: async () => {
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
    },
    logger,
  };
  return cached;
}

/**
 * The routing seam, deps-injected for tests: parse the pre-split wire shape, answer the typed
 * error on anything else (a known request never throws), and run the link flow.
 */
export async function handleGenerateLink(
  event: unknown,
  deps: GenerateLinkDeps,
): Promise<GenerateLinkWire> {
  const request = GenerateLinkRequest.safeParse(event);
  if (!request.success) return { status: "error", code: "unsupported_url" };
  deps.logger.appendKeys({ op: request.data.op, retailer: request.data.retailer });
  return generateLink(request.data.url, deps);
}

export const handler = async (event: unknown): Promise<GenerateLinkWire> =>
  handleGenerateLink(event, getDeps());
