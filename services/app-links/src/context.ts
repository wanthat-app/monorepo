import {
  FxRateRepo,
  getDocClient,
  ProductRepo,
  RecommendationRepo,
  type RuntimeConfigReader,
  RuntimeConfigRepo,
} from "@wanthat/dynamo";
import { RetailerProxyClient } from "./links/proxy-client";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required env var: ${name}`);
  return value;
}

export interface LinksContext {
  region: string;
  /** Read-only by design: the config table is single-writer (admin-api) — ADR-0019 spec. */
  config: RuntimeConfigReader;
  /** Links module (ADR-0002; served from this non-VPC edge so the retailer-proxy invoke is free —
   * the in-VPC placement would need a paid lambda interface endpoint, ADR-0004). */
  products: ProductRepo;
  recommendations: RecommendationRepo;
  retailerProxy: RetailerProxyClient;
  fx: FxRateRepo;
  /** Canonical SPA origin for shareUrl (env APP_URL). */
  appUrl: string;
}

let cached: LinksContext | undefined;

/**
 * Build the per-container dependency graph once and reuse it across warm invocations. The non-VPC
 * links edge (ADR-0004) reaches DynamoDB + the retailer-proxy over public AWS endpoints. No Aurora
 * and no Cognito — authentication is browser-to-Cognito (ADR-0006); money is app-core's seam.
 */
export function getContext(): LinksContext {
  if (cached) return cached;
  const region = process.env.AWS_REGION ?? "il-central-1";
  const doc = getDocClient(region);
  cached = {
    region,
    config: new RuntimeConfigRepo(doc, requireEnv("RUNTIME_CONFIG_TABLE")),
    products: new ProductRepo(doc, requireEnv("PRODUCT_TABLE")),
    recommendations: new RecommendationRepo(doc, requireEnv("RECOMMENDATION_TABLE")),
    retailerProxy: new RetailerProxyClient(requireEnv("RETAILER_PROXY_FUNCTION")),
    fx: new FxRateRepo(doc, requireEnv("FX_RATE_TABLE")),
    appUrl: requireEnv("APP_URL"),
  };
  return cached;
}
