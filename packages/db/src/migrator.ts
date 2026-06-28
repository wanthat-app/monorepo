import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Kysely, type Migration, type MigrationProvider, Migrator, sql } from "kysely";
import type { Database } from "./schema";

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");

/**
 * Plain-SQL migrations (ADR-0012): each `NNNN_name.sql` is run as one batch; an
 * optional `NNNN_name.down.sql` provides the rollback. SQL is the source of truth.
 */
class SqlFileProvider implements MigrationProvider {
  async getMigrations(): Promise<Record<string, Migration>> {
    const files = (await fs.readdir(migrationsDir))
      .filter((f) => f.endsWith(".sql") && !f.endsWith(".down.sql"))
      .sort();
    const migrations: Record<string, Migration> = {};
    for (const file of files) {
      const name = file.replace(/\.sql$/, "");
      migrations[name] = {
        async up(db: Kysely<unknown>) {
          await sql.raw(await fs.readFile(path.join(migrationsDir, file), "utf8")).execute(db);
        },
        async down(db: Kysely<unknown>) {
          const downPath = path.join(migrationsDir, `${name}.down.sql`);
          const raw = await fs.readFile(downPath, "utf8").catch(() => null);
          if (raw) await sql.raw(raw).execute(db);
        },
      };
    }
    return migrations;
  }
}

export function createMigrator(db: Kysely<Database>): Migrator {
  return new Migrator({ db, provider: new SqlFileProvider() });
}
