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
   * Custom apex domain (EdgeStack). When set, the us-east-1 EdgeStack fronts the env with
   * CloudFront + an ACM cert + Route 53 records; when unset (dev), services stay on their
   * AWS-generated hostnames.
   */
  readonly domainName?: string;
  /** Route 53 public hosted-zone id for `domainName` — passed explicitly so synth needs no lookup. */
  readonly hostedZoneId?: string;
}

const REGION = "il-central-1";

/** CloudFront's ACM cert + WAF must live in us-east-1 (control-plane only; traffic stays at the edge). */
export const EDGE_REGION = "us-east-1";

export const ENVIRONMENTS: Record<EnvName, WanthatEnv> = {
  dev: { name: "dev", region: REGION },
  prod: {
    name: "prod",
    region: REGION,
    domainName: "wanthat.app",
    hostedZoneId: "Z01833842M5XCPIIPFXKG",
  },
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
 * Lambda runtime for all functions, in one place (ADR-0010 — Node 20; the bundler also targets
 * node20). AWS Lambda offers only even LTS majors (18/20/22; there is no 21.x), so a bump goes
 * 20 → 22 here in lockstep with the repo's `engines` and the esbuild `target`.
 */
export const LAMBDA_RUNTIME = lambda.Runtime.NODEJS_20_X;

// Resolve paths from this file (infra is ESM — no __dirname), so they hold regardless of cwd.
const here = path.dirname(fileURLToPath(import.meta.url)); // infra/lib
export const REPO_ROOT = path.resolve(here, "..", "..");

/** Absolute path to a service's Lambda handler entry, for NodejsFunction bundling. */
export const serviceEntry = (service: string): string =>
  path.join(REPO_ROOT, "services", service, "src", "handler.ts");

/** Stack name helper — `wanthat-{env}-{suffix}`. */
export const stackName = (env: WanthatEnv, suffix: string): string =>
  `wanthat-${env.name}-${suffix}`;
