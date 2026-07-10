import { createDb } from "@wanthat/db";
import {
  CustomerCounterRepo,
  DevOtpSinkRepo,
  getDocClient,
  ProductRepo,
  RecommendationRepo,
  RuntimeConfigRepo,
  UnattributedOrderRepo,
} from "@wanthat/dynamo";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required env var: ${name}`);
  return value;
}

type Db = ReturnType<typeof createDb>;

export interface AdminContext {
  db: Db;
  config: RuntimeConfigRepo;
  /** Read-only (stats): the transactional entity counters live in these tables. */
  products: ProductRepo;
  recommendations: RecommendationRepo;
  /** Read-only (stats): the exact customer counter (`customerCounter` in OpsCounters). */
  customerCounter: CustomerCounterRepo;
  /** The unattributed-order claim queue (list + claim/dismiss intents; the proxy settles). */
  unattributedOrders: UnattributedOrderRepo;
  /** Dev only — undefined in prod (no table, no env var; fail-closed). */
  devOtpSink?: DevOtpSinkRepo;
}

let cached: AdminContext | undefined;

/**
 * Per-container deps for admin-api (ADR-0002/0006). Aurora (money-only since T7) is reached
 * read-only as `app_ro` — the admin role never mutates money; the runtime `config` table is the
 * one thing admin-api writes.
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
    customerCounter: new CustomerCounterRepo(
      getDocClient(region),
      requireEnv("OPS_COUNTERS_TABLE"),
    ),
    products: new ProductRepo(getDocClient(region), requireEnv("PRODUCT_TABLE")),
    recommendations: new RecommendationRepo(
      getDocClient(region),
      requireEnv("RECOMMENDATION_TABLE"),
    ),
    unattributedOrders: new UnattributedOrderRepo(
      getDocClient(region),
      requireEnv("UNATTRIBUTED_ORDER_TABLE"),
    ),
    // Dev only: DEV_OTP_SINK_TABLE is set solely where the sink table exists (never prod).
    ...(devOtpSinkTable
      ? { devOtpSink: new DevOtpSinkRepo(getDocClient(region), devOtpSinkTable) }
      : {}),
  };
  return cached;
}
