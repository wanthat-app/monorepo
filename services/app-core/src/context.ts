import { createDb } from "@wanthat/db";

/** The Kysely handle type, derived from createDb so app-core needs no direct kysely dependency. */
type Db = ReturnType<typeof createDb>;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required env var: ${name}`);
  return value;
}

export interface CoreContext {
  region: string;
  db: Db;
}

let cached: CoreContext | undefined;

/**
 * Build the per-container dependency graph once and reuse it across warm invocations. The in-VPC
 * wallet service (ADR-0006 rev: Cognito-native auth) reaches Aurora as `app_rw` via IAM auth (no
 * RDS Proxy). Aurora is money-only: the sole dependency here is the pg pool for the wallet ledger
 * and the /healthz/db probe.
 */
export function getContext(): CoreContext {
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
