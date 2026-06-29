import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Per-environment configuration (ADR-0005, ADR-0015). The CDK app instantiates one set of
 * `wanthat-{env}-*` stacks per environment, selected by `WANTHAT_ENV` (or CDK context `env`).
 * Single AWS account for now (dev + prod isolated by stack name + the per-env OIDC deploy role);
 * prod can graduate to its own account later without changing stack code.
 */
export type EnvName = "dev" | "prod";

export interface WanthatEnv {
  readonly name: EnvName;
  readonly account: string;
  readonly region: string;
  /**
   * Custom apex domain. Wired by the us-east-1 EdgeStack (CloudFront + ACM + Route 53), which
   * lands in a follow-up PR. Until then services are reachable on their AWS-generated hostnames.
   */
  readonly domainName?: string;
}

const ACCOUNT = "818913587533";
const REGION = "il-central-1";

export const ENVIRONMENTS: Record<EnvName, WanthatEnv> = {
  dev: { name: "dev", account: ACCOUNT, region: REGION },
  prod: { name: "prod", account: ACCOUNT, region: REGION, domainName: "wanthat.app" },
};

export function resolveEnv(name: string | undefined): WanthatEnv {
  const key = (name ?? "dev") as EnvName;
  const env = ENVIRONMENTS[key];
  if (!env) {
    throw new Error(`Unknown WANTHAT_ENV '${name}'. Expected 'dev' or 'prod'.`);
  }
  return env;
}

// Resolve paths from this file (infra is ESM — no __dirname), so they hold regardless of cwd.
const here = path.dirname(fileURLToPath(import.meta.url)); // infra/lib
export const REPO_ROOT = path.resolve(here, "..", "..");

/** Absolute path to a service's Lambda handler entry, for NodejsFunction bundling. */
export const serviceEntry = (service: string): string =>
  path.join(REPO_ROOT, "services", service, "src", "handler.ts");

/** Stack name helper — `wanthat-{env}-{suffix}`. */
export const stackName = (env: WanthatEnv, suffix: string): string =>
  `wanthat-${env.name}-${suffix}`;
