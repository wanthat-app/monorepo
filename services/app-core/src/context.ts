import { createDb } from "@wanthat/db";
import {
  FxRateRepo,
  getDocClient,
  type RuntimeConfigReader,
  RuntimeConfigRepo,
} from "@wanthat/dynamo";

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
  /** Cached USD→ILS rate for the wallet's display-only `≈₪` estimate (ADR-0017). */
  fx: FxRateRepo;
  /** Read-only by design: the config table is single-writer (admin-api) — ADR-0019 spec. */
  config: RuntimeConfigReader;
}

let cached: CoreContext | undefined;

/**
 * Build the per-container dependency graph once and reuse it across warm invocations. The in-VPC
 * wallet service (ADR-0006 rev: Cognito-native auth) reaches Aurora as `app_rw` via IAM auth (no
 * RDS Proxy) for the ledger, plus DynamoDB — through the VPC's free gateway endpoint (ADR-0004) —
 * for the fx-rate cache and the conversion-commission config behind the ILS estimate.
 */
export function getContext(): CoreContext {
  if (cached) return cached;
  const region = process.env.AWS_REGION ?? "il-central-1";
  const doc = getDocClient(region);
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
    fx: new FxRateRepo(doc, requireEnv("FX_RATE_TABLE")),
    config: new RuntimeConfigRepo(doc, requireEnv("RUNTIME_CONFIG_TABLE")),
  };
  return cached;
}
