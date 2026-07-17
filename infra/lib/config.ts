import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ArnFormat, Duration, RemovalPolicy, type Stack } from "aws-cdk-lib";
import type { CfnStage, HttpApi } from "aws-cdk-lib/aws-apigatewayv2";
import type * as ec2 from "aws-cdk-lib/aws-ec2";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { type BundlingOptions, NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
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

/**
 * Lambda CPU architecture for all functions, in one place. arm64 (Graviton) is ~20% cheaper per
 * GB-second than x86_64 with equal-or-better Node performance, and the whole dependency tree is
 * pure JavaScript after bundling (no native addons), so nothing is architecture-specific.
 */
export const LAMBDA_ARCHITECTURE = lambda.Architecture.ARM_64;

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

/** Per-service registry metadata — see {@link SERVICES}. */
export interface ServiceMeta {
  /**
   * The service's CDK construct id (PascalCase). Construct ids drive CloudFormation logical ids,
   * so changing one REPLACES the deployed function — renames are their own deliberate PR, never a
   * side effect. Note the one irregular id: `whatsapp-dispatcher` -> `Dispatcher`.
   */
  readonly constructId: string;
  /**
   * Emits structured funnel events (impression/click/conversion/order_untracked) that the
   * ObservabilityStack subscribes into the FunnelAnalytics pipeline.
   */
  readonly funnel: boolean;
  /**
   * Watched by the ObservabilityStack per-Lambda error alarms. Only the one-shot db-migrator is
   * excluded: a failed migration surfaces via the deploy itself, not steady-state alarms.
   */
  readonly alarms: boolean;
}

/**
 * The service registry — the single source of truth for service naming (slug -> construct id).
 *
 * The slug (key) is the directory name under `services/` AND the suffix of the function's physical
 * name (`wanthat-{env}-{slug}`, {@link physicalName}); the construct id drives CFN logical ids
 * ({@link constructId}). Key ORDER is load-bearing: {@link OBSERVED_SERVICES} derives the
 * observability alarm/dashboard order from it.
 */
export const SERVICES = {
  "app-links": { constructId: "AppLinks", funnel: false, alarms: true },
  "app-core": { constructId: "AppCore", funnel: false, alarms: true },
  "admin-api": { constructId: "AdminApi", funnel: false, alarms: true },
  "admin-credentials": { constructId: "AdminCredentials", funnel: false, alarms: true },
  landing: { constructId: "Landing", funnel: true, alarms: true },
  "retailer-proxy": { constructId: "RetailerProxy", funnel: true, alarms: true },
  "conversion-poller": { constructId: "ConversionPoller", funnel: true, alarms: true },
  "fx-rates": { constructId: "FxRates", funnel: false, alarms: true },
  "message-sender": { constructId: "MessageSender", funnel: false, alarms: true },
  "post-confirmation": { constructId: "PostConfirmation", funnel: false, alarms: true },
  "whatsapp-dispatcher": { constructId: "Dispatcher", funnel: false, alarms: true },
  "db-migrator": { constructId: "DbMigrator", funnel: false, alarms: false },
} as const satisfies Record<string, ServiceMeta>;

/** A service slug — a key of {@link SERVICES} (and a directory name under `services/`). */
export type ServiceSlug = keyof typeof SERVICES;

/** The slugs whose Lambdas the ObservabilityStack alarms on (registry order = dashboard order). */
export type AlarmedServiceSlug = {
  [K in ServiceSlug]: (typeof SERVICES)[K]["alarms"] extends true ? K : never;
}[ServiceSlug];

/** The slugs that emit funnel events (their log groups feed the FunnelAnalytics pipeline). */
export type FunnelServiceSlug = {
  [K in ServiceSlug]: (typeof SERVICES)[K]["funnel"] extends true ? K : never;
}[ServiceSlug];

/**
 * Alarm-watched slugs in registry order — the ObservabilityStack `{label, fn}` list derives its
 * labels (and its alarm/dashboard order) from this, so a rename lands in the alarms for free.
 */
export const OBSERVED_SERVICES: readonly AlarmedServiceSlug[] = (
  Object.keys(SERVICES) as ServiceSlug[]
).filter((slug): slug is AlarmedServiceSlug => SERVICES[slug].alarms);

/** A service Lambda's deterministic physical name — `wanthat-{env}-{slug}`. */
export const physicalName = (env: WanthatEnv, slug: ServiceSlug): string =>
  `wanthat-${env.name}-${slug}`;

/** A service's CDK construct id (from {@link SERVICES} — drives the CFN logical id). */
export const constructId = (slug: ServiceSlug): string => SERVICES[slug].constructId;

/**
 * A service Lambda's ARN built from its deterministic {@link physicalName} — for cross-stack
 * invoke grants/env vars WITHOUT a CloudFormation export (deploy-order independent, ADR-0004).
 */
export const functionArnFor = (stack: Stack, env: WanthatEnv, slug: ServiceSlug): string =>
  stack.formatArn({
    service: "lambda",
    resource: "function",
    resourceName: physicalName(env, slug),
    arnFormat: ArnFormat.COLON_RESOURCE_NAME,
  });

/** Absolute path to a service's Lambda handler entry (`src/handler.ts`), for NodejsFunction bundling. */
export const serviceEntry = (service: ServiceSlug): string =>
  path.join(REPO_ROOT, "services", service, "src", "handler.ts");

/**
 * Amazon RDS CA trust for in-VPC Aurora connections (ADR-0003/0006).
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
  // sourceMap OFF on purpose: source maps embed absolute pnpm-store paths (which carry
  // lockfile-dependent hashes), so a sourcemapped bundle's asset hash CHURNS whenever pnpm-lock
  // changes for ANY reason — even unrelated packages. That churn bumps the migrator's Lambda
  // `currentVersion`, which is what the MigrateTrigger keys on, so the one-shot migrator re-ran (and
  // re-hit a possibly-cold Aurora) on nearly every deploy. Without source maps the migrator's asset is
  // stable, so it re-runs only when its own code or the `.sql` migrations actually change.
  sourceMap: false,
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

/** The per-service knobs of {@link makeServiceFunction}; everything else is the shared baseline. */
export interface ServiceFunctionOpts {
  /** Defaults to 15 seconds. */
  readonly timeout?: Duration;
  readonly environment?: Record<string, string>;
  /**
   * Passed through VERBATIM (no default): most services ship `{ minify: true, sourceMap: true }`,
   * DB-touching ones {@link rdsCaBundling} / {@link migratorBundling}, and admin-credentials keeps
   * NodejsFunction's own defaults by omitting it. Changing a function's bundling churns its asset
   * hash (a real redeploy), so it stays an explicit per-service choice.
   */
  readonly bundling?: BundlingOptions;
  // In-VPC placement (ADR-0004) — only the four Aurora-touching functions set these.
  readonly vpc?: ec2.IVpc;
  readonly vpcSubnets?: ec2.SubnetSelection;
  readonly securityGroups?: ec2.ISecurityGroup[];
}

/**
 * The shared shape of every service Lambda (ADR-0002/0010): registry-derived construct id +
 * physical name + entry, the one runtime/architecture, 256 MB, X-Ray tracing, and an explicit
 * retention-bounded log group with the CDK-GENERATED name (construct id `{ConstructId}Logs`;
 * never set `logGroupName` — a named group would REPLACE the live one on deploy).
 */
export function makeServiceFunction(
  scope: Construct,
  env: WanthatEnv,
  slug: ServiceSlug,
  opts: ServiceFunctionOpts = {},
): NodejsFunction {
  const id = constructId(slug);
  return new NodejsFunction(scope, id, {
    functionName: physicalName(env, slug),
    entry: serviceEntry(slug),
    handler: "handler",
    runtime: LAMBDA_RUNTIME,
    architecture: LAMBDA_ARCHITECTURE,
    memorySize: 256,
    timeout: opts.timeout ?? Duration.seconds(15),
    // X-Ray tracing + an explicit retention-bounded log group (ADR-0002 observability).
    tracing: lambda.Tracing.ACTIVE,
    logGroup: serviceLogGroup(scope, `${id}Logs`, env),
    environment: opts.environment,
    bundling: opts.bundling,
    vpc: opts.vpc,
    vpcSubnets: opts.vpcSubnets,
    securityGroups: opts.securityGroups,
  });
}
