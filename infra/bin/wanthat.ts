#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { AdminStack } from "../lib/admin-stack";
import { ApiStack } from "../lib/api-stack";
import { resolveEnv, stackName } from "../lib/config";
import { DataStack } from "../lib/data-stack";
import { DnsStack } from "../lib/dns-stack";
import { EdgeServicesStack } from "../lib/edge-services-stack";
import { EdgeStack } from "../lib/edge-stack";
import { IdentityStack, SMS_MONTHLY_SPEND_LIMIT_USD } from "../lib/identity-stack";
import { NetworkStack } from "../lib/network-stack";
import { ObservabilityStack } from "../lib/observability-stack";
import { WhatsAppStack } from "../lib/whatsapp-stack";

/**
 * Wanthat infrastructure entrypoint (AWS CDK).
 *
 * One set of `wanthat-{env}-*` stacks per environment, selected by `WANTHAT_ENV` (or `-c env=`),
 * defaulting to `dev`. Account is read from `CDK_DEFAULT_ACCOUNT` (set by the CLI from the active
 * credentials, coerced empty → undefined so a credential-free synth stays env-agnostic); region is
 * fixed per env. Stacks are sliced per ADR-0002/0003/0004/0005.
 *
 * **Incremental rollout:** stacks (and resources within them) are wired in one at a time, each
 * proven through the CI/CD pipeline before the next is added.
 *
 * The us-east-1 **EdgeStack** (CloudFront + ACM + WAF) fronts the landing HTTP API (in il-central-1)
 * on `/p/*`, so EdgeServices (producer) and Edge (consumer) both set `crossRegionReferences: true`.
 *
 * Order: Network -> Data -> Identity -> Api / Admin / EdgeServices / WhatsApp -> Edge -> Observability
 * (last).
 *
 * Wired: NetworkStack, DataStack, IdentityStack, ApiStack, AdminStack, EdgeServicesStack,
 * WhatsAppStack, EdgeStack, DnsStack (prod), ObservabilityStack.
 */
const app = new cdk.App();
const wanthatEnv = resolveEnv(process.env.WANTHAT_ENV ?? app.node.tryGetContext("env"));
const account = process.env.CDK_DEFAULT_ACCOUNT || undefined;
const env: cdk.Environment = { account, region: wanthatEnv.region };
const common = { env, wanthatEnv };

cdk.Tags.of(app).add("app", "wanthat");
cdk.Tags.of(app).add("env", wanthatEnv.name);
// Stamp every resource with the deploy version (set by the Deploy workflow; `0.0.0` for a local
// synth). A manual prod deploy advances the least-significant version segment and tags the commit —
// see deploy.yml.
cdk.Tags.of(app).add("version", process.env.WANTHAT_VERSION ?? "0.0.0");

const network = new NetworkStack(app, stackName(wanthatEnv, "network"), common);
const data = new DataStack(app, stackName(wanthatEnv, "data"), {
  ...common,
  vpc: network.vpc,
  auroraSg: network.auroraSg,
  lambdaSg: network.lambdaSg,
});
// identity/api/admin feed public config (client ids, api hosts) to the us-east-1 EdgeStack's
// config.json, so they set crossRegionReferences like edge-services (which exports the landing apiId).
const identity = new IdentityStack(app, stackName(wanthatEnv, "identity"), {
  ...common,
  crossRegionReferences: true,
  runtimeConfigTable: data.runtimeConfigTable,
  // Exact customer counter (customerCounter in OpsCounters) - incremented by post-confirmation.
  opsCountersTable: data.opsCountersTable,
  otpSinkTable: data.otpSinkTable,
  // Post-Confirmation trigger targets (ADR-0006 decision 7): welcome outbox + guest attribution.
  notificationOutboxTable: data.notificationOutboxTable,
  guestAttributionTable: data.guestAttributionTable,
});
const api = new ApiStack(app, stackName(wanthatEnv, "api"), {
  ...common,
  crossRegionReferences: true,
  userPool: identity.userPool,
  userPoolClient: identity.userPoolClient,
  productTable: data.productTable,
  recommendationTable: data.recommendationTable,
  fxRateTable: data.fxRateTable,
  runtimeConfigTable: data.runtimeConfigTable,
  vpc: network.vpc,
  lambdaSg: network.lambdaSg,
  cluster: data.cluster,
});

const admin = new AdminStack(app, stackName(wanthatEnv, "admin"), {
  ...common,
  crossRegionReferences: true,
  // Admin API authorizes against the employee pool (ADR-0006 §two-pool); app-api keeps the customer
  // pool above. A customer token therefore can't reach /admin.
  employeePool: identity.employeePool,
  employeePoolClient: identity.employeePoolClient,
  // Customer pool: the users page deletes member accounts (non-VPC credentials fn only).
  customerPool: identity.userPool,
  runtimeConfigTable: data.runtimeConfigTable,
  // Exact customer counter: admin-api reads the stats; admin-credentials writes moderation moves.
  opsCountersTable: data.opsCountersTable,
  productTable: data.productTable,
  recommendationTable: data.recommendationTable,
  // The unattributed-order claim queue (list + claim/dismiss; the retailer-proxy settles).
  unattributedOrderTable: data.unattributedOrderTable,
  // OTP sink + signup outbox: the activity page lists parked codes and member signups.
  otpSinkTable: data.otpSinkTable,
  notificationOutboxTable: data.notificationOutboxTable,
  // Write-only credential drop (PutSecretValue + DescribeSecret; never read) — see AdminStack.
  retailerSecret: data.retailerSecret,
  vpc: network.vpc,
  lambdaSg: network.lambdaSg,
  cluster: data.cluster,
});

const edgeServices = new EdgeServicesStack(app, stackName(wanthatEnv, "edge-services"), {
  ...common,
  crossRegionReferences: true, // landing apiId is consumed by the us-east-1 EdgeStack
  productTable: data.productTable,
  recommendationTable: data.recommendationTable,
  guestAttributionTable: data.guestAttributionTable,
  runtimeConfigTable: data.runtimeConfigTable,
  fxRateTable: data.fxRateTable,
  retailerSecret: data.retailerSecret,
  pollerStateTable: data.pollerStateTable,
  unattributedOrderTable: data.unattributedOrderTable,
  // Offline JWT verification on the landing resolve path (ADR-0007: JWKS, never a Cognito call).
  userPoolId: identity.userPool.userPoolId,
  userPoolClientId: identity.userPoolClient.userPoolClientId,
  // The in-VPC conversion-poller-writer (ADR-0002): Aurora as poller_writer.
  vpc: network.vpc,
  lambdaSg: network.lambdaSg,
  cluster: data.cluster,
});

// WhatsAppStack (ADR-0019): the notification dispatcher. Depends only on DataStack; deploys
// before Observability (which watches its Lambda).
const whatsapp = new WhatsAppStack(app, stackName(wanthatEnv, "whatsapp"), {
  ...common,
  notificationOutboxTable: data.notificationOutboxTable,
  runtimeConfigTable: data.runtimeConfigTable,
});

// EdgeStack lives in us-east-1 (CloudFront cert + WAF are control-plane there), not the app region.
new EdgeStack(app, stackName(wanthatEnv, "edge"), {
  env: { account, region: "us-east-1" },
  wanthatEnv,
  crossRegionReferences: true,
  landingApiId: edgeServices.landingApi.apiId,
  // Public runtime config written to /config.json in the SPA bucket (cross-region from il-central-1).
  spaConfig: {
    apiUrl: api.httpApi.apiEndpoint,
    adminApiUrl: admin.httpApi.apiEndpoint,
    // ADR-0006: the SPA calls cognito-idp.<region>.amazonaws.com directly for every customer auth
    // ceremony (no Managed Login for customers). A synth-time literal, not a stack output.
    cognitoRegion: wanthatEnv.region,
    userPoolClientId: identity.userPoolClient.userPoolClientId,
    adminManagedLoginUrl: identity.employeePoolDomain.baseUrl(),
    adminPoolClientId: identity.employeePoolClient.userPoolClientId,
  },
});

// ObservabilityStack deploys LAST — it only references resources the other il-central-1 stacks
// already created (the HTTP APIs, the application Lambdas, and the Aurora cluster). The db-migrator is
// intentionally excluded from the per-Lambda error alarms: a failed one-shot migration surfaces via
// the deploy, not steady-state alarms.
new ObservabilityStack(app, stackName(wanthatEnv, "observability"), {
  ...common,
  httpApis: [
    { label: "app-api", api: api.httpApi },
    { label: "admin-api", api: admin.httpApi },
    { label: "landing", api: edgeServices.landingApi },
  ],
  functions: [
    { label: "app-links", fn: api.appLinksFn },
    { label: "app-core", fn: api.appCoreFn },
    { label: "admin-api", fn: admin.adminApiFn },
    { label: "admin-credentials", fn: admin.adminCredentialsFn },
    { label: "landing", fn: edgeServices.landingFn },
    { label: "retailer-proxy", fn: edgeServices.retailerProxyFn },
    { label: "conversion-poller", fn: edgeServices.conversionPollerFn },
    { label: "fx-rates", fn: edgeServices.fxRatesFn },
    { label: "message-sender", fn: identity.messageSenderFn },
    { label: "post-confirmation", fn: identity.postConfirmationFn },
    { label: "whatsapp-dispatcher", fn: whatsapp.dispatcherFn },
  ],
  cluster: data.cluster,
  smsSpendLimitUsd: SMS_MONTHLY_SPEND_LIMIT_USD[wanthatEnv.name],
  // Funnel events are emitted by landing (impression/click), the conversion poller (conversion)
  // and the retailer proxy (order_untracked — the unattributed-revenue stream).
  funnelLogGroups: [
    edgeServices.landingFn.logGroup,
    edgeServices.conversionPollerFn.logGroup,
    edgeServices.retailerProxyFn.logGroup,
  ],
});

// DnsStack — apex mail records (Zoho MX/SPF/DKIM/DMARC) for wanthat.app. Prod only: these belong to
// the apex domain, not the dev subdomain (dev has a domainName now, but no mail of its own).
if (wanthatEnv.name === "prod" && wanthatEnv.domainName && wanthatEnv.hostedZoneId) {
  new DnsStack(app, stackName(wanthatEnv, "dns"), {
    ...common,
    hostedZoneId: wanthatEnv.hostedZoneId,
    domainName: wanthatEnv.domainName,
  });
}

app.synth();
