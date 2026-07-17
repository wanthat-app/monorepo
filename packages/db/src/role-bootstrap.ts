import { type Kysely, sql } from "kysely";
import type { Database } from "./schema";

/**
 * R1 as code — the service-role bootstrap the role-bootstrap Lambda runs AS MASTER on every
 * deploy, ordered before the db-migrator's Trigger (migration 0008 GRANTs to these roles and
 * fails the deploy if they are missing). Master must run this because `wanthat_migrator`
 * deliberately has no CREATEROLE (0003/0006): role creation stays a master-only capability,
 * now exercised by exactly one auditable, deploy-time code path instead of a psql runbook.
 * The psql equivalent stays documented in infra/lib/README.md as the disaster-recovery
 * reference. Everything here is idempotent — re-running is a no-op.
 */

/** The four service roles introduced by the 2026-07 topology refactor (see migration 0008). */
export const SERVICE_ROLES = [
  "wallet_reader",
  "ledger_reader",
  "ledger_writer",
  "audit_writer",
] as const;

/** Create-if-missing each service role; grant IAM auth + schema visibility. Idempotent. */
export async function runRoleBootstrap(db: Kysely<Database>): Promise<void> {
  // CREATE ROLE has no IF NOT EXISTS - the catalog check makes each create idempotent.
  await sql`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'wallet_reader') THEN CREATE ROLE wallet_reader LOGIN; END IF;
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'ledger_reader') THEN CREATE ROLE ledger_reader LOGIN; END IF;
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'ledger_writer') THEN CREATE ROLE ledger_writer LOGIN; END IF;
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'audit_writer')  THEN CREATE ROLE audit_writer  LOGIN; END IF;
    END $$;
  `.execute(db);
  // IAM database authentication (the rds_iam grant is what makes SigV4 tokens work; ADR-0003).
  await sql`GRANT rds_iam TO wallet_reader, ledger_reader, ledger_writer, audit_writer`.execute(db);
  // Master owns schema public - USAGE cannot be granted by the migrator (0003 ownership model).
  await sql`GRANT USAGE ON SCHEMA public TO wallet_reader, ledger_reader, ledger_writer, audit_writer`.execute(
    db,
  );
}
