import path from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import type { Database } from "./schema";

/**
 * Shared Testcontainers harness for this package's integration tests (ADR-0013: packages/db runs
 * against a real PostgreSQL 16 on a Docker-enabled runner). Starts a throwaway container and hands
 * back a Kysely handle; migrations are the TEST'S job (migrations.test.ts asserts the run itself,
 * the data-access tests just need the end state), via `createMigrator(db, MIGRATIONS_DIR)`.
 */

export const MIGRATIONS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "migrations",
);

export interface TestDb {
  db: Kysely<Database>;
  container: StartedPostgreSqlContainer;
  stop: () => Promise<void>;
}

export async function startTestDb(): Promise<TestDb> {
  const container = await new PostgreSqlContainer("postgres:16-alpine").start();
  const pool = new pg.Pool({ connectionString: container.getConnectionUri() });
  // RDS provides rds_iam; plain Postgres does not. The migrations only GRANT it, so NOLOGIN works.
  await pool.query("CREATE ROLE rds_iam NOLOGIN");
  const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
  return {
    db,
    container,
    stop: async () => {
      await db.destroy();
      await container.stop();
    },
  };
}
