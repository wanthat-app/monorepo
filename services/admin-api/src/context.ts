import { createDb } from "@wanthat/db";
import { DevOtpSinkRepo, getDocClient, RuntimeConfigRepo } from "@wanthat/dynamo";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required env var: ${name}`);
  return value;
}

type Db = ReturnType<typeof createDb>;

export interface AdminContext {
  db: Db;
  config: RuntimeConfigRepo;
  /** Dev only — undefined in prod (no table, no env var; fail-closed). */
  devOtpSink?: DevOtpSinkRepo;
}

let cached: AdminContext | undefined;

/**
 * Per-container deps for admin-api (ADR-0002/0020). Aurora is reached read-only as `app_ro` (the
 * admin role never mutates money/PII); the runtime `config` table is the one thing admin-api writes.
 */
export function getContext(): AdminContext {
  if (cached) return cached;
  const region = process.env.AWS_REGION ?? "il-central-1";
  const devOtpSinkTable = process.env.DEV_OTP_SINK_TABLE;
  cached = {
    db: createDb({
      host: requireEnv("DB_HOST"),
      port: 5432,
      database: requireEnv("DB_NAME"),
      user: requireEnv("DB_USER"),
      region,
      caCerts: process.env.DB_CA_CERT,
    }),
    config: new RuntimeConfigRepo(getDocClient(region), requireEnv("RUNTIME_CONFIG_TABLE")),
    // Dev only: DEV_OTP_SINK_TABLE is set solely where the sink table exists (never prod).
    ...(devOtpSinkTable
      ? { devOtpSink: new DevOtpSinkRepo(getDocClient(region), devOtpSinkTable) }
      : {}),
  };
  return cached;
}
