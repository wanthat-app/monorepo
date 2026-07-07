import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { createDb } from "@wanthat/db";
import { getDocClient, RuntimeConfigRepo } from "@wanthat/dynamo";
import { RetailerSecretWriter } from "./retailer-secret";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required env var: ${name}`);
  return value;
}

type Db = ReturnType<typeof createDb>;

export interface AdminContext {
  db: Db;
  config: RuntimeConfigRepo;
  retailerSecret: RetailerSecretWriter;
}

let cached: AdminContext | undefined;

/**
 * Per-container deps for admin-api (ADR-0002/0020). Aurora is reached read-only as `app_ro` (the
 * admin role never mutates money/PII); the runtime `config` table is the one thing admin-api writes.
 */
export function getContext(): AdminContext {
  if (cached) return cached;
  const region = process.env.AWS_REGION ?? "il-central-1";
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
    retailerSecret: new RetailerSecretWriter(
      new SecretsManagerClient({ region }),
      requireEnv("RETAILER_SECRET_ARN"),
    ),
  };
  return cached;
}
