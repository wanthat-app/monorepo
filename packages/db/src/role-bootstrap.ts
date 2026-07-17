import { type Kysely, sql } from "kysely";
import type { Database } from "./schema";

/**
 * R1 + R2 as code — the role lifecycle the role-bootstrap Lambda runs AS MASTER on every
 * deploy, ordered before the db-migrator's Trigger (migration 0008 GRANTs to these roles and
 * fails the deploy if they are missing). Master must run this because `wanthat_migrator`
 * deliberately has no CREATEROLE (0003/0006): role creation AND destruction stay master-only
 * capabilities, exercised by exactly one auditable, deploy-time code path instead of a psql
 * runbook. The psql equivalents stay documented in infra/lib/README.md as the
 * disaster-recovery reference. Everything here is idempotent — re-running is a no-op.
 *
 * This bootstrap is PERMANENT infrastructure, not refactor scaffolding: it is the fresh-env
 * R1 mechanism (a new environment has no service roles until it runs), so it is never
 * removed. The legacy-retirement step (R2, refactor PR-8) simply no-ops once — or wherever —
 * the legacy roles are gone.
 */

/** The four service roles introduced by the 2026-07 topology refactor (see migration 0008). */
export const SERVICE_ROLES = [
  "wallet_reader",
  "ledger_reader",
  "ledger_writer",
  "audit_writer",
] as const;

/**
 * The pre-refactor roles (0001) retired by refactor PR-8. Every Lambda flipped to a
 * SERVICE_ROLES member in PR-7, so nothing connects as these anymore.
 */
export const LEGACY_ROLES = ["app_rw", "app_ro", "poller_writer"] as const;

/**
 * Create-if-missing each service role; grant IAM auth + schema visibility; retire the legacy
 * roles. Idempotent.
 */
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
  await retireLegacyRoles(db);
}

/**
 * R2 — retire the legacy roles (refactor PR-8). Per role, guarded on pg_roles existence so a
 * fresh env (which never had them) and every re-run after the first are clean no-ops:
 * REVOKE everything master can revoke, clear stray grants with DROP OWNED, then DROP ROLE.
 * The roles own no objects (0001 created them permissionless-by-ownership; every table and
 * function is owned by master or wanthat_migrator) — DROP OWNED therefore only revokes
 * privileges granted TO the role (e.g. 0007's admin_audit_config_change EXECUTE for app_ro),
 * which is exactly what would otherwise block DROP ROLE.
 */
async function retireLegacyRoles(db: Kysely<Database>): Promise<void> {
  for (const role of LEGACY_ROLES) {
    // Role names come from the LEGACY_ROLES constant above, never from input.
    await sql
      .raw(`
      DO $$ BEGIN
        IF EXISTS (SELECT FROM pg_roles WHERE rolname = '${role}') THEN
          REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${role};
          REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM ${role};
          -- audit_append exists from 0005 on; a fresh env retires nothing, but guard anyway so
          -- a pre-0005 database (or a partial restore) cannot fail the bootstrap.
          IF to_regprocedure('audit_append(jsonb, timestamptz)') IS NOT NULL THEN
            REVOKE EXECUTE ON FUNCTION audit_append(jsonb, timestamptz) FROM ${role};
          END IF;
          REVOKE USAGE ON SCHEMA public FROM ${role};
          -- DROP OWNED requires membership in the target role (master is not a superuser on
          -- RDS); as the roles' creator master holds ADMIN OPTION, so it can self-grant. The
          -- membership dies with the DROP ROLE below.
          GRANT ${role} TO CURRENT_USER;
          DROP OWNED BY ${role};
          DROP ROLE ${role};
        END IF;
      END $$;
    `)
      .execute(db);
  }
}
