#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { AdminStack } from "../lib/admin-stack";
import { ApiStack } from "../lib/api-stack";
import { resolveEnv, stackName } from "../lib/config";
import { DataStack } from "../lib/data-stack";
import { EdgeServicesStack } from "../lib/edge-services-stack";
import { IdentityStack } from "../lib/identity-stack";

/**
 * Wanthat infrastructure entrypoint (AWS CDK).
 *
 * One set of `wanthat-{env}-*` stacks per environment, selected by `WANTHAT_ENV` (or `-c env=`),
 * defaulting to `dev`. The account is account-agnostic at synth and resolved from the deploy
 * credentials (`CDK_DEFAULT_ACCOUNT`); region is fixed per env. Stacks are sliced per
 * ADR-0002/0003/0004/0005.
 *
 * Deferred: NetworkStack + the in-VPC placement of app-api/admin (land with Aurora, ADR-0004); the
 * us-east-1 EdgeStack (CloudFront + ACM + Route 53 on the custom domain); ObservabilityStack.
 */
const app = new cdk.App();
const wanthatEnv = resolveEnv(process.env.WANTHAT_ENV ?? app.node.tryGetContext("env"));
// account omitted on purpose — resolved from the active credentials at deploy time.
const env: cdk.Environment = { region: wanthatEnv.region };
const common = { env, wanthatEnv };

cdk.Tags.of(app).add("app", "wanthat");
cdk.Tags.of(app).add("env", wanthatEnv.name);

const data = new DataStack(app, stackName(wanthatEnv, "data"), common);
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

new EdgeServicesStack(app, stackName(wanthatEnv, "edge-services"), {
  ...common,
  recommendationTable: data.recommendationTable,
  guestAttributionTable: data.guestAttributionTable,
  runtimeConfigTable: data.runtimeConfigTable,
  fxRateTable: data.fxRateTable,
  retailerSecret: data.retailerSecret,
});

app.synth();
