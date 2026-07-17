import { Signer } from "@aws-sdk/rds-signer";
import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import type { Database } from "./schema";

export interface DbConfig {
  host: string;
  port: number;
  database: string;
  /** Per-function Postgres role: wallet_reader | ledger_reader | ledger_writer | audit_writer (ADR-0002, refactor 2026-07). */
  user: string;
  region: string;
  /** Disable TLS only for local Testcontainers; Aurora IAM auth requires it. */
  ssl?: boolean;
  /**
   * Static password — the master-user path used by the one-shot migrator, which runs **before** the
   * IAM login roles exist (0001 creates them), so it cannot authenticate via IAM (ADR-0006). When
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
    // Bound the connect so a genuinely unreachable DB errors instead of silently hanging the Lambda,
    // but keep it long enough to ride out an Aurora scale-to-zero resume (kept at min ACU 0, ADR-0003;
    // a cold resume can take ~20-30s+). The one-shot migrator has a matching 60s Lambda timeout; the
    // API-fronted functions are still capped at the 30s HTTP API integration limit.
    connectionTimeoutMillis: 60_000,
  });
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}

/**
 * Wait until the database accepts a connection, riding out an Aurora Serverless v2 scale-to-zero
 * resume (min ACU 0, ADR-0003). A cold/paused cluster refuses the connection — at the OS/TCP layer a
 * `connect ETIMEDOUT` fires around ~21s, *before* pg's 60s connect timeout even applies — so a single
 * attempt fails. The attempt itself triggers the resume; retrying with a short backoff catches the
 * cluster once it is up (typically 1-3 attempts, tens of seconds). Used by the one-shot DB migrator,
 * whose deploy would otherwise fail whenever a deploy happens to fire while the cluster is paused.
 * Rethrows the last error if the cluster never comes up within the budget (a genuine failure).
 */
export async function waitForDb(
  db: Kysely<Database>,
  opts: {
    attempts?: number;
    delayMs?: number;
    log?: (msg: string, ctx: Record<string, unknown>) => void;
  } = {},
): Promise<void> {
  const attempts = opts.attempts ?? 8;
  const delayMs = opts.delayMs ?? 5_000;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await sql`select 1`.execute(db);
      return;
    } catch (err) {
      if (attempt === attempts) throw err;
      opts.log?.("db_connect_retry", {
        attempt,
        of: attempts,
        error: err instanceof Error ? err.message : String(err),
      });
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}
