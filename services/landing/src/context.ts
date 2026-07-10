import {
  FxRateRepo,
  getDocClient,
  RecommendationRepo,
  type RuntimeConfigBatchReader,
  RuntimeConfigRepo,
} from "@wanthat/dynamo";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required env var: ${name}`);
  return value;
}

export interface LandingContext {
  /** ONE point lookup resolves the whole landing (ADR-0007: the denormalised projection). */
  recommendations: RecommendationRepo;
  /** Read-only: `landing.countdownSeconds` + `fx.conversionCommissionBps` (single-writer: admin-api). */
  config: RuntimeConfigBatchReader;
  /** Settlement→ILS display rate (same convention as the create flow). */
  fx: FxRateRepo;
  /** This deployment's env name — stamped into every click's attribution (wire format). */
  env: string;
}

let cached: LandingContext | undefined;

/**
 * Build the per-container dependency graph once and reuse it across warm invocations. Landing is
 * non-VPC (ADR-0004) and reaches DynamoDB over public AWS endpoints; it never touches Aurora or
 * Cognito on the render path (ADR-0007).
 */
export function getContext(): LandingContext {
  if (cached) return cached;
  const region = process.env.AWS_REGION ?? "il-central-1";
  const doc = getDocClient(region);
  cached = {
    recommendations: new RecommendationRepo(doc, requireEnv("RECOMMENDATION_TABLE")),
    config: new RuntimeConfigRepo(doc, requireEnv("RUNTIME_CONFIG_TABLE")),
    fx: new FxRateRepo(doc, requireEnv("FX_RATE_TABLE")),
    env: requireEnv("WANTHAT_ENV"),
  };
  return cached;
}
