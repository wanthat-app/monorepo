import { createDb } from "@wanthat/db";

/** The Kysely handle type, derived from createDb so this service needs no direct kysely dep. */
type Db = ReturnType<typeof createDb>;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required env var: ${name}`);
  return value;
}

export interface AuditWriterContext {
  region: string;
  db: Db;
}

let cached: AuditWriterContext | undefined;

/**
 * Build the per-container dependency graph once and reuse it across warm invocations. The
 * in-VPC audit-writer reaches Aurora as `audit_writer` via IAM auth — its ONLY capability is
 * EXECUTE on `audit_append` (migration 0008); it holds no table access and touches nothing else.
 */
export function getContext(): AuditWriterContext {
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
