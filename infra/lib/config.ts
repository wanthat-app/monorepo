import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as lambda from "aws-cdk-lib/aws-lambda";

/**
 * Per-environment configuration (ADR-0005, ADR-0015). The CDK app instantiates one set of
 * `wanthat-{env}-*` stacks per environment, selected by `WANTHAT_ENV` (or CDK context `env`).
 *
 * The **account is not pinned here** — it's resolved at deploy time from the active credentials
 * (`CDK_DEFAULT_ACCOUNT`, i.e. the assumed OIDC role), so the account id stays out of the repo and
 * a synth needs no AWS calls. Region is fixed (il-central-1, ADR — not sensitive). dev + prod are a
 * single account today, isolated by stack name + the per-env deploy role; prod can graduate to its
 * own account later without code changes.
 */
export type EnvName = "dev" | "prod";

export interface WanthatEnv {
  readonly name: EnvName;
  readonly region: string;
  /**
   * Custom apex domain. Wired by the us-east-1 EdgeStack (CloudFront + ACM + Route 53), which
   * lands in a follow-up PR. Until then services are reachable on their AWS-generated hostnames.
   */
  readonly domainName?: string;
}

const REGION = "il-central-1";

export const ENVIRONMENTS: Record<EnvName, WanthatEnv> = {
  dev: { name: "dev", region: REGION },
  prod: { name: "prod", region: REGION, domainName: "wanthat.app" },
};

export function resolveEnv(name: string | undefined): WanthatEnv {
  const key = (name ?? "dev") as EnvName;
  const env = ENVIRONMENTS[key];
  if (!env) {
    throw new Error(`Unknown WANTHAT_ENV '${name}'. Expected 'dev' or 'prod'.`);
  }
  return env;
}

/**
 * Lambda runtime for all functions, in one place (ADR-0010 — Node 24 "Krypton" LTS; NodejsFunction
 * derives the esbuild target from this). Node 20 was retired: it reached end-of-life (Apr 2026) and
 * is deprecated on AWS Lambda. A future bump (next even LTS) changes this line in lockstep with the
 * repo's `engines` and `.nvmrc`.
 */
export const LAMBDA_RUNTIME = lambda.Runtime.NODEJS_24_X;

// Resolve paths from this file (infra is ESM — no __dirname), so they hold regardless of cwd.
const here = path.dirname(fileURLToPath(import.meta.url)); // infra/lib
export const REPO_ROOT = path.resolve(here, "..", "..");

/** Absolute path to a service's Lambda handler entry, for NodejsFunction bundling. */
export const serviceEntry = (service: string): string =>
  path.join(REPO_ROOT, "services", service, "src", "handler.ts");

/** Stack name helper — `wanthat-{env}-{suffix}`. */
export const stackName = (env: WanthatEnv, suffix: string): string =>
  `wanthat-${env.name}-${suffix}`;
