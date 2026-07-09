/**
 * DB migrator (ADR-0012, ADR-0006) — a one-shot, in-VPC Lambda invoked by a CDK
 * `triggers.Trigger` after the Aurora cluster is created, and on every subsequent deploy.
 *
 * It runs `@wanthat/db` `migrateToLatest()` as **`wanthat_migrator` via IAM auth** (0003) — no
 * Secrets Manager read, so the VPC needs no secretsmanager interface endpoint. The role owns the
 * app tables + kysely bookkeeping (ownership transferred in 0003), which is what future ALTERs need.
 * NEW-ENV BOOTSTRAP: a brand-new cluster has no wanthat_migrator until 0001–0003 have run, so the
 * FIRST migration of a fresh environment is a one-time manual master-credential run (see 0003's
 * header). Envs are fixed at dev+prod, both migrated. Reserved concurrency is 1 (the stack) so two
 * deploys never migrate concurrently; the Kysely migrator is itself transactional per file.
 *
 * Throwing on failure is intentional: it fails the Trigger custom resource, which fails the deploy —
 * a half-migrated schema must not look successful.
 */
import { Logger } from "@aws-lambda-powertools/logger";
import { createDb, createMigrator, waitForDb } from "@wanthat/db";

const SERVICE = "db-migrator";
const logger = new Logger({ serviceName: SERVICE });

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required env var: ${name}`);
  return value;
}

export const handler = async (): Promise<{ status: "ok"; applied: string[] }> => {
  const region = process.env.AWS_REGION ?? "il-central-1";
  // No password: createDb mints a fresh SigV4 IAM token per connection (same path as app_rw).
  const db = createDb({
    host: requireEnv("DB_HOST"),
    port: Number(requireEnv("DB_PORT")),
    database: requireEnv("DB_NAME"),
    user: requireEnv("DB_USER"),
    region,
    // TLS verification trusts the Amazon RDS CA via NODE_EXTRA_CA_CERTS (the bundle shipped in the
    // function artifact, wired in DataStack), so `pg` needs no explicit `ca` here — Node's default
    // trust store already includes it. rejectUnauthorized stays on.
  });

  try {
    // Ride out a scale-to-zero cold resume before migrating: the cluster (min ACU 0, ADR-0003) may be
    // paused when this deploy fires, so the first connection ETIMEDOUTs — retry until it wakes. Without
    // this, any deploy that runs the migrator against a paused cluster fails and rolls back the stack.
    await waitForDb(db, { log: (msg, ctx) => logger.warn(msg, ctx) });
    // The .sql files are shipped in the bundle at MIGRATIONS_DIR (/var/task/migrations); see DataStack.
    const { error, results } = await createMigrator(
      db,
      requireEnv("MIGRATIONS_DIR"),
    ).migrateToLatest();
    for (const r of results ?? []) {
      logger.info("migration", {
        name: r.migrationName,
        status: r.status,
        direction: r.direction,
      });
    }
    if (error) {
      logger.error("migration_failed", { error: String(error) });
      throw error instanceof Error ? error : new Error(String(error));
    }
    return { status: "ok", applied: (results ?? []).map((r) => r.migrationName) };
  } finally {
    await db.destroy();
  }
};
