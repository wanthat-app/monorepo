import { Signer } from "@aws-sdk/rds-signer";
import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import type { Database } from "./schema";

export interface DbConfig {
  host: string;
  port: number;
  database: string;
  /** Per-function Postgres role: app_rw | app_ro | poller_writer (ADR-0002). */
  user: string;
  region: string;
  /** Disable TLS only for local Testcontainers; Aurora IAM auth requires it. */
  ssl?: boolean;
  /**
   * Static password — the master-user path used by the one-shot migrator, which runs **before** the
   * IAM login roles exist (0001 creates them), so it cannot authenticate via IAM (ADR-0020). When
   * set, it replaces the SigV4 token provider. Application functions never set this; they use IAM.
   */
  password?: string;
  /**
   * PEM CA bundle for TLS verification. Aurora's server cert chains to a private Amazon RDS CA that
   * is **not** in Node's default trust store, so `rejectUnauthorized: true` (below) fails unless this
   * is provided. Supply the il-central-1 RDS CA bundle for in-cloud connections; omit for the
   * Testcontainers path (`ssl: false`). Never disable verification to work around a missing CA.
   */
  caCerts?: string;
}

/**
 * IAM database authentication (ADR-0003): the password is a short-lived (~15 min)
 * SigV4 token minted locally — no Secrets Manager call, no RDS Proxy. node-postgres
 * calls this provider per new connection, so the pool always presents a fresh token.
 */
function authTokenProvider(cfg: DbConfig): () => Promise<string> {
  const signer = new Signer({
    hostname: cfg.host,
    port: cfg.port,
    username: cfg.user,
    region: cfg.region,
  });
  return () => signer.getAuthToken();
}

export function createDb(cfg: DbConfig): Kysely<Database> {
  // Password resolution: Testcontainers (ssl:false) → none; explicit master password (migrator) →
  // static; otherwise a fresh SigV4 IAM token per connection (ADR-0003).
  const password = cfg.ssl === false ? undefined : (cfg.password ?? authTokenProvider(cfg));
  const pool = new pg.Pool({
    host: cfg.host,
    port: cfg.port,
    database: cfg.database,
    user: cfg.user,
    password,
    ssl: cfg.ssl === false ? undefined : { rejectUnauthorized: true, ca: cfg.caCerts },
    // In-VPC, reserved-concurrency-capped functions (ADR-0002): keep pools tiny.
    max: 2,
    idleTimeoutMillis: 30_000,
  });
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}
