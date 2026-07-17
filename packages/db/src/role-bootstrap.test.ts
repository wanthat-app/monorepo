import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMigrator } from "./migrator";
import { LEGACY_ROLES, runRoleBootstrap, SERVICE_ROLES } from "./role-bootstrap";
import type { Database } from "./schema";
import { MIGRATIONS_DIR } from "./test-harness";

/**
 * role-bootstrap integration test — a RAW container (deliberately not the shared harness, which
 * itself runs the bootstrap): only the rds_iam shim pre-exists, exactly like a fresh RDS cluster
 * before the role-bootstrap Trigger's first run. Asserts the fresh-env path (R1: the four
 * service roles created with LOGIN + rds_iam + schema USAGE; no legacy roles to retire), then
 * the deployed-env path (R2: migrations seed the legacy roles + their grants exactly as
 * dev/prod carried them, and the next bootstrap run retires them without touching the service
 * roles), and that every re-run is a clean no-op.
 */

let container: StartedPostgreSqlContainer;
let db: Kysely<Database>;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  const pool = new pg.Pool({ connectionString: container.getConnectionUri() });
  await pool.query("CREATE ROLE rds_iam NOLOGIN");
  db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}, 180_000);

afterAll(async () => {
  await db?.destroy();
  await container?.stop();
});

/** pg_roles existence for each name, as a map. */
async function rolesPresent(names: readonly string[]): Promise<Record<string, boolean>> {
  const out: Record<string, boolean> = {};
  for (const name of names) {
    const { rows } = await sql<{ n: string }>`
      SELECT count(*) AS n FROM pg_roles WHERE rolname = ${name}
    `.execute(db);
    out[name] = Number(rows[0]?.n) === 1;
  }
  return out;
}

async function assertServiceRolesIntact(): Promise<void> {
  for (const role of SERVICE_ROLES) {
    const { rows } = await sql<{
      canLogin: boolean;
      hasRdsIam: boolean;
      hasUsage: boolean;
    }>`
      SELECT
        r.rolcanlogin                                  AS "canLogin",
        pg_has_role(r.rolname, 'rds_iam', 'MEMBER')    AS "hasRdsIam",
        has_schema_privilege(r.rolname, 'public', 'USAGE') AS "hasUsage"
      FROM pg_roles r WHERE r.rolname = ${role}
    `.execute(db);
    expect(rows, role).toHaveLength(1);
    expect(rows[0], role).toEqual({ canLogin: true, hasRdsIam: true, hasUsage: true });
  }
}

describe("runRoleBootstrap — fresh env (R1)", () => {
  it("creates the four service roles with LOGIN, rds_iam, and schema USAGE", async () => {
    await runRoleBootstrap(db);
    await assertServiceRolesIntact();
  });

  it("no-ops the legacy retirement when the legacy roles never existed", async () => {
    expect(await rolesPresent(LEGACY_ROLES)).toEqual({
      app_rw: false,
      app_ro: false,
      poller_writer: false,
    });
  });

  it("is idempotent - a second run changes nothing and does not throw", async () => {
    await runRoleBootstrap(db);
    const { rows } = await sql<{ count: string }>`
      SELECT count(*) AS count FROM pg_roles
      WHERE rolname IN ('wallet_reader', 'ledger_reader', 'ledger_writer', 'audit_writer')
    `.execute(db);
    expect(rows[0]?.count).toBe("4");
  });
});

describe("runRoleBootstrap — legacy retirement (R2)", () => {
  it("retires the migration-seeded legacy roles; service roles + their grants survive", async () => {
    // Seed the deployed-env state: the full migration chain creates app_rw / app_ro /
    // poller_writer (0001) and their grants (0001/0005/0006), exactly as dev/prod carried
    // them. (0008 needs the service roles, created by the R1 runs above.)
    const { error } = await createMigrator(db, MIGRATIONS_DIR).migrateToLatest();
    if (error) throw error;
    expect(await rolesPresent(LEGACY_ROLES)).toEqual({
      app_rw: true,
      app_ro: true,
      poller_writer: true,
    });
    // poller_writer carries the audit_append EXECUTE grant (0006) going into retirement.
    const { rows: pw } = await sql<{ ok: boolean }>`
      SELECT has_function_privilege('poller_writer', 'audit_append(jsonb, timestamptz)', 'EXECUTE') AS ok
    `.execute(db);
    expect(pw[0]?.ok).toBe(true);
    // A stray grant outside the explicit REVOKE list — the 0007-wrapper situation the real
    // deploy hits (the bootstrap runs BEFORE migration 0010 drops the wrapper, so app_ro
    // still holds EXECUTE on it at retirement time). Only DROP OWNED can clear this one.
    await sql`
      CREATE FUNCTION r2_stray_wrapper() RETURNS int LANGUAGE sql AS 'SELECT 1'
    `.execute(db);
    await sql`GRANT EXECUTE ON FUNCTION r2_stray_wrapper() TO app_ro`.execute(db);

    // The legacy roles own nothing — DROP OWNED must only be clearing grants, never objects.
    const { rows: owned } = await sql<{ n: string }>`
      SELECT count(*) AS n
      FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner
      WHERE r.rolname IN ('app_rw', 'app_ro', 'poller_writer')
    `.execute(db);
    expect(Number(owned[0]?.n)).toBe(0);

    await runRoleBootstrap(db);

    expect(await rolesPresent(LEGACY_ROLES)).toEqual({
      app_rw: false,
      app_ro: false,
      poller_writer: false,
    });
    await assertServiceRolesIntact();
    await sql`DROP FUNCTION r2_stray_wrapper()`.execute(db);
  });

  it("leaves audit_append EXECUTEable by audit_writer and ledger_writer (0008 grants intact)", async () => {
    for (const role of ["audit_writer", "ledger_writer"]) {
      const { rows } = await sql<{ ok: boolean }>`
        SELECT has_function_privilege(${role}, 'audit_append(jsonb, timestamptz)', 'EXECUTE') AS ok
      `.execute(db);
      expect(rows[0]?.ok, role).toBe(true);
    }
    // Functional proof: the chain still accepts appends from audit_writer post-retirement.
    await db.transaction().execute(async (trx) => {
      await sql`SET LOCAL ROLE audit_writer`.execute(trx);
      await sql`SELECT audit_append('{"type":"config_changed","key":"k","actor":"a@wanthat.app"}'::jsonb)`.execute(
        trx,
      );
    });
  });

  it("is idempotent - a re-run after retirement is a clean no-op", async () => {
    await runRoleBootstrap(db);
    expect(await rolesPresent(LEGACY_ROLES)).toEqual({
      app_rw: false,
      app_ro: false,
      poller_writer: false,
    });
    await assertServiceRolesIntact();
  });
});
