import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runRoleBootstrap, SERVICE_ROLES } from "./role-bootstrap";
import type { Database } from "./schema";

/**
 * role-bootstrap integration test — a RAW container (deliberately not the shared harness, which
 * itself runs the bootstrap): only the rds_iam shim pre-exists, exactly like a fresh RDS cluster
 * before the role-bootstrap Trigger's first run. Asserts the bootstrap creates the four service
 * roles with LOGIN + rds_iam + schema USAGE, and that a second run is a clean no-op.
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

describe("runRoleBootstrap", () => {
  it("creates the four service roles with LOGIN, rds_iam, and schema USAGE", async () => {
    await runRoleBootstrap(db);
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
