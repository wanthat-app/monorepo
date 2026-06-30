#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { AdminStack } from "../lib/admin-stack";
import { ApiStack } from "../lib/api-stack";
import { resolveEnv, stackName } from "../lib/config";
import { DataStack } from "../lib/data-stack";
import { DnsStack } from "../lib/dns-stack";
import { EdgeServicesStack } from "../lib/edge-services-stack";
import { EdgeStack } from "../lib/edge-stack";
import { IdentityStack } from "../lib/identity-stack";
import { NetworkStack } from "../lib/network-stack";

/**
 * Wanthat infrastructure entrypoint (AWS CDK).
 *
 * One set of `wanthat-{env}-*` stacks per environment, selected by `WANTHAT_ENV` (or `-c env=`),
 * defaulting to `dev`. Account is read from `CDK_DEFAULT_ACCOUNT` (set by the CLI from the active
 * credentials, coerced empty → undefined so a credential-free synth stays env-agnostic); region is
 * fixed per env. Stacks are sliced per ADR-0002/0003/0004/0005.
 *
 * **Incremental rollout:** stacks (and resources within them) are wired in one at a time, each
 * proven through the CI/CD pipeline before the next is added. Deferred entirely: ObservabilityStack.
 *
 * The us-east-1 **EdgeStack** (CloudFront + ACM + WAF) fronts the landing HTTP API (in il-central-1)
 * on `/p/*`, so EdgeServices (producer) and Edge (consumer) both set `crossRegionReferences: true`.
 *
 * Wired: NetworkStack, DataStack, IdentityStack, ApiStack, AdminStack, EdgeServicesStack, EdgeStack,
 * DnsStack (prod).
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
const identity = new IdentityStack(app, stackName(wanthatEnv, "identity"), common);
new ApiStack(app, stackName(wanthatEnv, "api"), {
  ...common,
  userPool: identity.userPool,
  userPoolClient: identity.userPoolClient,
  recommendationTable: data.recommendationTable,
  guestAttributionTable: data.guestAttributionTable,
  runtimeConfigTable: data.runtimeConfigTable,
});

new AdminStack(app, stackName(wanthatEnv, "admin"), {
  ...common,
  userPool: identity.userPool,
  userPoolClient: identity.userPoolClient,
  runtimeConfigTable: data.runtimeConfigTable,
  recommendationTable: data.recommendationTable,
});

const edgeServices = new EdgeServicesStack(app, stackName(wanthatEnv, "edge-services"), {
  ...common,
  crossRegionReferences: true, // landing apiId is consumed by the us-east-1 EdgeStack
  recommendationTable: data.recommendationTable,
  guestAttributionTable: data.guestAttributionTable,
  runtimeConfigTable: data.runtimeConfigTable,
  fxRateTable: data.fxRateTable,
  retailerSecret: data.retailerSecret,
});

// EdgeStack lives in us-east-1 (CloudFront cert + WAF are control-plane there), not the app region.
new EdgeStack(app, stackName(wanthatEnv, "edge"), {
  env: { account, region: "us-east-1" },
  wanthatEnv,
  crossRegionReferences: true,
  landingApiId: edgeServices.landingApi.apiId,
});

// DnsStack — domain verification / mail records (Zoho) in the existing Route 53 zone. Only where a
// custom domain is configured (prod); dev has no domain to manage.
if (wanthatEnv.domainName && wanthatEnv.hostedZoneId) {
  new DnsStack(app, stackName(wanthatEnv, "dns"), {
    ...common,
    hostedZoneId: wanthatEnv.hostedZoneId,
    domainName: wanthatEnv.domainName,
  });
}

app.synth();
