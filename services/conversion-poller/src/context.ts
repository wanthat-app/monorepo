import { createDb } from "@wanthat/db";
import { getDocClient, RecommendationRepo } from "@wanthat/dynamo";

/** The Kysely handle type, derived from createDb so this service needs no direct kysely dep. */
type Db = ReturnType<typeof createDb>;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required env var: ${name}`);
  return value;
}

export interface WriterContext {
  region: string;
  db: Db;
  recommendations: RecommendationRepo;
}

let cached: WriterContext | undefined;

/**
 * Build the per-container dependency graph once and reuse it across warm invocations. The
 * in-VPC writer (ADR-0002: the sole money mutator) reaches Aurora as `poller_writer` via IAM
 * auth, and DynamoDB (the conversions stat) over the VPC's free gateway endpoint.
 */
export function getContext(): WriterContext {
  if (cached) return cached;
  const region = process.env.AWS_REGION ?? "il-central-1";
  cached = {
    region,
    db: createDb({
      host: requireEnv("DB_HOST"),
      port: 5432,
      database: requireEnv("DB_NAME"),
      user: requireEnv("DB_USER"),
      region,
      caCerts: process.env.DB_CA_CERT,
    }),
    recommendations: new RecommendationRepo(getDocClient(region), requireEnv("RECOMMENDATION_TABLE")),
  };
  return cached;
}
