#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { AdminStack } from "../lib/admin-stack";
import { ApiStack } from "../lib/api-stack";
import { resolveEnv, stackName } from "../lib/config";
import { DataStack } from "../lib/data-stack";
import { EdgeServicesStack } from "../lib/edge-services-stack";
import { IdentityStack } from "../lib/identity-stack";
import { NetworkStack } from "../lib/network-stack";

/**
 * Wanthat infrastructure entrypoint (AWS CDK).
 *
 * One set of `wanthat-{env}-*` stacks per environment, selected by `WANTHAT_ENV` (or `-c env=`),
 * defaulting to `dev`. Stacks are sliced per ADR-0002/0003/0004/0005 and instantiated in dependency
 * order: Network → Data → Identity → Api / Admin / EdgeServices. The us-east-1 EdgeStack
 * (CloudFront + ACM + Route 53 on the custom domain) and ObservabilityStack land in follow-up PRs.
 */
const app = new cdk.App();
const wanthatEnv = resolveEnv(process.env.WANTHAT_ENV ?? app.node.tryGetContext("env"));
const env: cdk.Environment = { account: wanthatEnv.account, region: wanthatEnv.region };
const common = { env, wanthatEnv };

cdk.Tags.of(app).add("app", "wanthat");
cdk.Tags.of(app).add("env", wanthatEnv.name);

const network = new NetworkStack(app, stackName(wanthatEnv, "network"), common);
const data = new DataStack(app, stackName(wanthatEnv, "data"), common);
const identity = new IdentityStack(app, stackName(wanthatEnv, "identity"), common);

new ApiStack(app, stackName(wanthatEnv, "api"), {
  ...common,
  vpc: network.vpc,
  lambdaSecurityGroup: network.lambdaSecurityGroup,
  userPool: identity.userPool,
  userPoolClient: identity.userPoolClient,
  recommendationTable: data.recommendationTable,
  guestAttributionTable: data.guestAttributionTable,
  runtimeConfigTable: data.runtimeConfigTable,
});

new AdminStack(app, stackName(wanthatEnv, "admin"), {
  ...common,
  vpc: network.vpc,
  lambdaSecurityGroup: network.lambdaSecurityGroup,
  userPool: identity.userPool,
  userPoolClient: identity.userPoolClient,
  runtimeConfigTable: data.runtimeConfigTable,
  recommendationTable: data.recommendationTable,
});

new EdgeServicesStack(app, stackName(wanthatEnv, "edge-services"), {
  ...common,
  recommendationTable: data.recommendationTable,
  guestAttributionTable: data.guestAttributionTable,
  runtimeConfigTable: data.runtimeConfigTable,
  fxRateTable: data.fxRateTable,
  retailerSecret: data.retailerSecret,
});

app.synth();
