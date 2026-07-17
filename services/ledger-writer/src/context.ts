import { createDb } from "@wanthat/db";

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
}

let cached: WriterContext | undefined;

/**
 * Build the per-container dependency graph once and reuse it across warm invocations. The
 * in-VPC writer (ADR-0002: the sole money mutator) reaches Aurora as `ledger_writer` via IAM
 * auth — and NOTHING else (refactor PR-6): the conversions stat became a projection derived
 * from the ledger and applied by retailer-settlement, so this function holds no DynamoDB
 * client, table env, or grant. The role that parses nothing and moves money touches only the
 * money store.
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
  };
  return cached;
}
