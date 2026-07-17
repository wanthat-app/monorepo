/**
 * role-bootstrap (refactor 2026-07) — a one-shot, in-VPC Lambda invoked by a CDK
 * `triggers.Trigger` after the Aurora cluster exists and BEFORE the db-migrator's Trigger.
 *
 * It connects AS THE MASTER USER (`wanthat_master`) via IAM database authentication — no
 * password, no Secrets Manager. This works because 0003 made master a member of
 * `wanthat_migrator`, which holds `rds_iam`: RDS routes any (even transitively) rds_iam-member
 * role through IAM/PAM auth — which simultaneously DISABLES master's password login (the
 * failure mode that killed the secret-based first version of this function) and enables the
 * same SigV4-token path every other in-VPC function uses.
 *
 * It runs `runRoleBootstrap` (R1 as code): create-if-missing the four service roles +
 * GRANT rds_iam + GRANT USAGE ON SCHEMA public. Master must do this because
 * `wanthat_migrator` deliberately has no CREATEROLE (0003/0006); migration 0008 then GRANTs
 * table privileges on the roles this function guarantees exist. Idempotent every deploy.
 *
 * Throwing on failure is intentional: it fails the Trigger custom resource, which fails the
 * deploy — missing roles must never let a deploy that depends on them look successful.
 */
import { Logger } from "@aws-lambda-powertools/logger";
import { createDb, runRoleBootstrap, SERVICE_ROLES, waitForDb } from "@wanthat/db";

const SERVICE = "role-bootstrap";
const logger = new Logger({ serviceName: SERVICE });

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required env var: ${name}`);
  return value;
}

export const handler = async (): Promise<{ status: "ok"; roles: readonly string[] }> => {
  const region = process.env.AWS_REGION ?? "il-central-1";
  // No password: createDb mints a fresh SigV4 IAM token per connection (same path as the app
  // roles); DB_USER is wanthat_master. TLS trusts the RDS CA via NODE_EXTRA_CA_CERTS.
  const db = createDb({
    host: requireEnv("DB_HOST"),
    port: Number(requireEnv("DB_PORT")),
    database: requireEnv("DB_NAME"),
    user: requireEnv("DB_USER"),
    region,
  });
  try {
    // Ride out a scale-to-zero cold resume (min ACU 0, ADR-0003) before running the bootstrap.
    await waitForDb(db, { log: (msg, ctx) => logger.warn(msg, ctx) });
    await runRoleBootstrap(db);
    logger.info("role_bootstrap_ok", { roles: [...SERVICE_ROLES] });
    return { status: "ok", roles: SERVICE_ROLES };
  } finally {
    await db.destroy();
  }
};
