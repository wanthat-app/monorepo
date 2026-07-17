import { createDb } from "@wanthat/db";
import { FxRateRepo, getDocClient, RuntimeConfigRepo } from "@wanthat/dynamo";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required env var: ${name}`);
  return value;
}

type Db = ReturnType<typeof createDb>;

export interface AdminLedgerViewContext {
  db: Db;
  /** Read-only: the money route's fx.conversionCommissionBps lookup. */
  config: RuntimeConfigRepo;
  /** Cached FX rates (read-only): the money KPIs' display-only ILS estimate (ADR-0017). */
  fx: FxRateRepo;
}

let cached: AdminLedgerViewContext | undefined;

/**
 * Per-container deps for admin-ledger-view (refactor PR-5). Aurora (money-only) is reached as
 * `ledger_reader` — SELECT on wallet_entry + audit_log and NOTHING else (0008): this function
 * is a pure record reader with no write path anywhere. The only DynamoDB it touches is the FX
 * cache + runtime config, both read-only; every admin ACTION and Dynamo-backed view lives on
 * the non-VPC admin-console.
 */
export function getContext(): AdminLedgerViewContext {
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
    fx: new FxRateRepo(getDocClient(region), requireEnv("FX_RATE_TABLE")),
  };
  return cached;
}
