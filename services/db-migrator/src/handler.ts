/**
 * DB migrator (ADR-0012, ADR-0020) — a one-shot, in-VPC Lambda invoked by a CDK
 * `triggers.Trigger` after the Aurora cluster is created, and on every subsequent deploy.
 *
 * It runs `@wanthat/db` `migrateToLatest()` **as the master user** read from the cluster's generated
 * Secrets Manager secret — not via IAM auth — because the per-function IAM login roles (`app_rw`,
 * `app_ro`, `poller_writer`) and their `rds_iam` grant do not exist until `0001_init.sql` runs. That
 * is the chicken-and-egg the master path resolves. Reserved concurrency is 1 (the stack) so two
 * deploys never migrate concurrently; the Kysely migrator is itself transactional per file.
 *
 * Throwing on failure is intentional: it fails the Trigger custom resource, which fails the deploy —
 * a half-migrated schema must not look successful.
 */
import { Logger } from "@aws-lambda-powertools/logger";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { createDb, createMigrator } from "@wanthat/db";

const SERVICE = "db-migrator";
const logger = new Logger({ serviceName: SERVICE });

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required env var: ${name}`);
  return value;
}

interface MasterSecret {
  username: string;
  password: string;
}

export const handler = async (): Promise<{ status: "ok"; applied: string[] }> => {
  const region = process.env.AWS_REGION ?? "il-central-1";
  const sm = new SecretsManagerClient({ region });
  const res = await sm.send(new GetSecretValueCommand({ SecretId: requireEnv("DB_SECRET_ARN") }));
  if (!res.SecretString) throw new Error("db master secret has no SecretString");
  const secret = JSON.parse(res.SecretString) as MasterSecret;

  const db = createDb({
    host: requireEnv("DB_HOST"),
    port: Number(requireEnv("DB_PORT")),
    database: requireEnv("DB_NAME"),
    user: secret.username,
    region,
    password: secret.password,
    // TLS verification trusts the Amazon RDS CA via NODE_EXTRA_CA_CERTS (the bundle shipped in the
    // function artifact, wired in DataStack), so `pg` needs no explicit `ca` here — Node's default
    // trust store already includes it. rejectUnauthorized stays on.
  });

  try {
    const { error, results } = await createMigrator(db).migrateToLatest();
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
