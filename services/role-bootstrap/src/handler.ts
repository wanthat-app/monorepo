/**
 * role-bootstrap (refactor 2026-07) — a one-shot, in-VPC Lambda invoked by a CDK
 * `triggers.Trigger` after the Aurora cluster exists and BEFORE the db-migrator's Trigger.
 *
 * It is the system's ONLY master-credential consumer: it reads the cluster's generated master
 * secret (via the TRANSITIONAL Secrets Manager interface endpoint — see DataStack) and runs
 * `runRoleBootstrap` (R1 as code): create-if-missing the four service roles + GRANT rds_iam +
 * GRANT USAGE ON SCHEMA public. Master must do this because `wanthat_migrator` deliberately has
 * no CREATEROLE (0003/0006); migration 0008 then GRANTs table privileges on the roles this
 * function guarantees exist. Idempotent every deploy.
 *
 * Throwing on failure is intentional: it fails the Trigger custom resource, which fails the
 * deploy — missing roles must never let a deploy that depends on them look successful.
 */
import { Logger } from "@aws-lambda-powertools/logger";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { createDb, runRoleBootstrap, SERVICE_ROLES, waitForDb } from "@wanthat/db";

const SERVICE = "role-bootstrap";
const logger = new Logger({ serviceName: SERVICE });

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required env var: ${name}`);
  return value;
}

/** The fields we need from the RDS-generated master secret (SecretString JSON). */
export function parseMasterSecret(secretString: string): { username: string; password: string } {
  const parsed: unknown = JSON.parse(secretString);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as { username?: unknown }).username !== "string" ||
    typeof (parsed as { password?: unknown }).password !== "string"
  ) {
    throw new Error("master secret is missing username/password");
  }
  const { username, password } = parsed as { username: string; password: string };
  return { username, password };
}

export const handler = async (): Promise<{ status: "ok"; roles: readonly string[] }> => {
  const region = process.env.AWS_REGION ?? "il-central-1";
  const sm = new SecretsManagerClient({ region });
  const res = await sm.send(
    new GetSecretValueCommand({ SecretId: requireEnv("MASTER_SECRET_ARN") }),
  );
  if (!res.SecretString) throw new Error("master secret has no SecretString");
  const { username, password } = parseMasterSecret(res.SecretString);

  // Static master password (the one legitimate use of cfg.password outside tests); TLS trusts the
  // RDS CA via NODE_EXTRA_CA_CERTS, same as every other in-VPC function.
  const db = createDb({
    host: requireEnv("DB_HOST"),
    port: Number(requireEnv("DB_PORT")),
    database: requireEnv("DB_NAME"),
    user: username,
    password,
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
