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
  const pool = new pg.Pool({
    host: cfg.host,
    port: cfg.port,
    database: cfg.database,
    user: cfg.user,
    password: cfg.ssl === false ? undefined : authTokenProvider(cfg),
    ssl: cfg.ssl === false ? undefined : { rejectUnauthorized: true },
    // In-VPC, reserved-concurrency-capped functions (ADR-0002): keep pools tiny.
    max: 2,
    idleTimeoutMillis: 30_000,
  });
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}
