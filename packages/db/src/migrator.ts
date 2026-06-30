import { promises as fs } from "node:fs";
import path from "node:path";
import { type Kysely, type Migration, type MigrationProvider, Migrator, sql } from "kysely";
import type { Database } from "./schema";

/**
 * Plain-SQL migrations (ADR-0012): each `NNNN_name.sql` is run as one batch; an
 * optional `NNNN_name.down.sql` provides the rollback. SQL is the source of truth.
 *
 * The migrations directory is passed in explicitly rather than derived from `import.meta.url`: the
 * migrator runs inside an esbuild-bundled Lambda where `import.meta.url` is `undefined` (CJS output),
 * so the caller supplies an absolute path. The bundled Lambda ships the `.sql` files under
 * `/var/task/migrations` and points `MIGRATIONS_DIR` at it (see DataStack); local callers pass their
 * own path.
 */
class SqlFileProvider implements MigrationProvider {
  constructor(private readonly migrationsDir: string) {}

  async getMigrations(): Promise<Record<string, Migration>> {
    const dir = this.migrationsDir;
    const files = (await fs.readdir(dir))
      .filter((f) => f.endsWith(".sql") && !f.endsWith(".down.sql"))
      .sort();
    const migrations: Record<string, Migration> = {};
    for (const file of files) {
      const name = file.replace(/\.sql$/, "");
      migrations[name] = {
        async up(db: Kysely<unknown>) {
          await sql.raw(await fs.readFile(path.join(dir, file), "utf8")).execute(db);
        },
        async down(db: Kysely<unknown>) {
          const downPath = path.join(dir, `${name}.down.sql`);
          const raw = await fs.readFile(downPath, "utf8").catch(() => null);
          if (raw) await sql.raw(raw).execute(db);
        },
      };
    }
    return migrations;
  }
}

/** Build a Kysely migrator that reads `.sql` files from `migrationsDir` (an absolute path). */
export function createMigrator(db: Kysely<Database>, migrationsDir: string): Migrator {
  return new Migrator({ db, provider: new SqlFileProvider(migrationsDir) });
}
