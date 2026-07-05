import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { RemovalPolicy } from "aws-cdk-lib";
import type { CfnStage, HttpApi } from "aws-cdk-lib/aws-apigatewayv2";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import type { Construct } from "constructs";

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
   * Custom apex domain. Wired by the us-east-1 EdgeStack (CloudFront + ACM + Route 53). When unset
   * (dev), the EdgeStack serves CloudFront's default `*.cloudfront.net` hostname instead.
   */
  readonly domainName?: string;
  /**
   * Route 53 **public** hosted zone id that {@link domainName} lives in. Lets the EdgeStack
   * DNS-validate the ACM cert and alias the record at CloudFront. Set wherever {@link domainName} is.
   */
  readonly hostedZoneId?: string;
  /**
   * Apex name of {@link hostedZoneId} (e.g. `wanthat.app`). Only differs from {@link domainName} when
   * the site runs on a **subdomain** (dev → `dev.wanthat.app` in the `wanthat.app` zone): the zone is
   * still the apex, but the CloudFront alias record is the subdomain. Defaults to {@link domainName}
   * (apex site, e.g. prod).
   */
  readonly hostedZoneName?: string;
  /**
   * Addresses subscribed to the ObservabilityStack alarm SNS topic. Each gets an email subscription
   * (every recipient must confirm once via the AWS link before they receive alarms). Empty/unset
   * leaves the topic without a subscriber so alarms still fire and are visible in the console.
   */
  readonly alarmEmails?: readonly string[];
}

const REGION = "il-central-1";

const ALARM_EMAILS = ["dennis@wanthat.app", "jonatan@wanthat.app"] as const;

const HOSTED_ZONE_ID = "Z01833842M5XCPIIPFXKG"; // the wanthat.app public zone (dev + prod share it)

export const ENVIRONMENTS: Record<EnvName, WanthatEnv> = {
  dev: {
    name: "dev",
    region: REGION,
    // Dev runs on a subdomain of the same zone; the CloudFront alias is dev.wanthat.app.
    domainName: "dev.wanthat.app",
    hostedZoneId: HOSTED_ZONE_ID,
    hostedZoneName: "wanthat.app",
    alarmEmails: ALARM_EMAILS,
  },
  prod: {
    name: "prod",
    region: REGION,
    domainName: "wanthat.app",
    hostedZoneId: HOSTED_ZONE_ID,
    hostedZoneName: "wanthat.app",
    alarmEmails: ALARM_EMAILS,
  },
};

/**
 * Browser origins allowed to (a) call our HTTP APIs cross-origin (CORS `allowOrigins`) and (b) complete
 * the Cognito hosted-UI OAuth redirect (client callback URLs). The deployed site (prod apex / dev
 * subdomain) plus `localhost:5173` in non-prod, so a developer can run the SPA locally against a
 * deployed environment. Single source of truth — the CORS list and the Cognito callback list MUST
 * match, or a cross-origin `POST` preflight (OPTIONS) is rejected by the JWT authorizer and the real
 * request never fires.
 */
export function webOrigins(env: WanthatEnv): string[] {
  const site = env.domainName ? [`https://${env.domainName}`] : [];
  return env.name === "prod" ? site : ["http://localhost:5173", ...site];
}

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

/** A request-throttle profile for an HTTP API stage. */
export interface Throttle {
  /** Steady-state requests per second. */
  readonly rateLimit: number;
  /** Max burst (bucket size) — short spikes above the steady rate. */
  readonly burstLimit: number;
}

/**
 * Per-surface API Gateway throttling — **the one place to tune request limits per use case**.
 * Applied to each HTTP API's `$default` stage (default route settings) via {@link applyThrottle}.
 *
 * - `landing` — the public, viral redirect path (`/p/*`); highest headroom (also CloudFront-fronted).
 * - `userWallet` — the authenticated app API (identity + links + **wallet**); moderate.
 * - `admin` — the internal admin API; low (few operators).
 *
 * Account-level HTTP API defaults are 10000 rps / 5000 burst; these per-stage caps sit under that.
 */
export const THROTTLING = {
  landing: { rateLimit: 2000, burstLimit: 4000 },
  userWallet: { rateLimit: 500, burstLimit: 1000 },
  admin: { rateLimit: 50, burstLimit: 100 },
} satisfies Record<string, Throttle>;

/** Apply a {@link Throttle} to an HTTP API's auto-created `$default` stage (default route settings). */
export function applyThrottle(httpApi: HttpApi, throttle: Throttle): void {
  const stage = httpApi.defaultStage?.node.defaultChild as CfnStage | undefined;
  if (!stage) {
    throw new Error("HTTP API has no default stage to throttle");
  }
  stage.defaultRouteSettings = {
    throttlingRateLimit: throttle.rateLimit,
    throttlingBurstLimit: throttle.burstLimit,
  };
}

// Resolve paths from this file (infra is ESM — no __dirname), so they hold regardless of cwd.
const here = path.dirname(fileURLToPath(import.meta.url)); // infra/lib
export const REPO_ROOT = path.resolve(here, "..", "..");

/** Absolute path to a service's Lambda handler entry (`src/handler.ts`), for NodejsFunction bundling. */
export const serviceEntry = (service: string): string =>
  path.join(REPO_ROOT, "services", service, "src", "handler.ts");

/**
 * Amazon RDS CA trust for in-VPC Aurora connections (ADR-0003/0020).
 *
 * Aurora presents a server cert that chains to a **private** Amazon RDS root CA, which is **not** in
 * Node's default trust store — so `pg`'s `rejectUnauthorized: true` fails unless that CA is trusted.
 * The bundle is AWS's *public*, version-pinned `global-bundle.pem` (every region) — not a secret and
 * not runtime-tunable, so it belongs in the deployment artifact, not Secrets Manager or the runtime
 * `config` table. We commit it under `packages/db/certs/`, copy it into each DB-touching Lambda's
 * bundle, and point `NODE_EXTRA_CA_CERTS` at it so Node trusts it process-wide (covering pg + any SDK
 * TLS) with no runtime fetch. Apply {@link rdsCaBundling} to the function's `bundling` **and** spread
 * {@link RDS_CA_ENV} into its `environment`.
 */
const RDS_CA_BUNDLE_FILE = "rds-global-bundle.pem";
const RDS_CA_BUNDLE_SRC = path.join("packages", "db", "certs", RDS_CA_BUNDLE_FILE); // relative to repo root

/** Lambda env that makes Node trust the Amazon RDS CA bundle copied into the bundle root (`/var/task`). */
export const RDS_CA_ENV = { NODE_EXTRA_CA_CERTS: `/var/task/${RDS_CA_BUNDLE_FILE}` } as const;

/**
 * NodejsFunction `bundling` that ships the RDS CA bundle alongside the handler. esbuild's input dir is
 * the monorepo root (the pnpm lockfile dir), so the bundle is copied from there into the asset output
 * (which Lambda unpacks to `/var/task`). Merge with any other bundling options at the call site.
 */
export const rdsCaBundling = {
  minify: true,
  sourceMap: true,
  commandHooks: {
    beforeBundling: () => [],
    beforeInstall: () => [],
    afterBundling: (inputDir: string, outputDir: string): string[] => [
      `cp "${path.join(inputDir, RDS_CA_BUNDLE_SRC)}" "${outputDir}"`,
    ],
  },
};

/**
 * The db-migrator's bundling and env. esbuild bundles only JS, so the plain-`.sql` migrations would
 * NOT be in the artifact — and the source resolves the dir from `import.meta.url`, which is `undefined`
 * in the CJS bundle. So we (a) ship the RDS CA bundle (the migrator connects to Aurora over TLS) **and**
 * the `.sql` files under a `migrations/` subdir, and (b) point `MIGRATIONS_DIR` at them at runtime.
 */
const MIGRATIONS_SRC = path.join("packages", "db", "migrations"); // relative to repo root

/** Lambda env: where the bundled `.sql` migrations land in the unpacked artifact (`/var/task`). */
export const MIGRATIONS_DIR_ENV = { MIGRATIONS_DIR: "/var/task/migrations" } as const;

export const migratorBundling = {
  minify: true,
  sourceMap: true,
  commandHooks: {
    beforeBundling: () => [],
    beforeInstall: () => [],
    afterBundling: (inputDir: string, outputDir: string): string[] => [
      `cp "${path.join(inputDir, RDS_CA_BUNDLE_SRC)}" "${outputDir}"`,
      `mkdir -p "${path.join(outputDir, "migrations")}"`,
      `cp "${path.join(inputDir, MIGRATIONS_SRC)}"/*.sql "${path.join(outputDir, "migrations")}"`,
    ],
  },
};

/** Stack name helper — `wanthat-{env}-{suffix}`. */
export const stackName = (env: WanthatEnv, suffix: string): string =>
  `wanthat-${env.name}-${suffix}`;

/**
 * An explicit, retention-bounded CloudWatch log group for a Lambda (ADR-0002 observability).
 *
 * Pass the result as the function's `logGroup` prop (NOT the deprecated `logRetention`): CDK then
 * sets the function's `LoggingConfig.LogGroup` and Lambda writes there. Retention is dev one month /
 * prod six months; the group is destroyed with the stack in dev but retained in prod so logs outlive
 * a teardown. `tracing: lambda.Tracing.ACTIVE` is set alongside this at each call site for X-Ray.
 */
export function serviceLogGroup(scope: Construct, id: string, env: WanthatEnv): logs.LogGroup {
  const isProd = env.name === "prod";
  return new logs.LogGroup(scope, id, {
    retention: isProd ? logs.RetentionDays.SIX_MONTHS : logs.RetentionDays.ONE_MONTH,
    removalPolicy: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
  });
}
