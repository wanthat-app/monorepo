#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { AdminStack } from "../lib/admin-stack";
import { ApiStack } from "../lib/api-stack";
import { resolveEnv, stackName } from "../lib/config";
import { DataStack } from "../lib/data-stack";
import { IdentityStack } from "../lib/identity-stack";

/**
 * Wanthat infrastructure entrypoint (AWS CDK).
 *
 * One set of `wanthat-{env}-*` stacks per environment, selected by `WANTHAT_ENV` (or `-c env=`),
 * defaulting to `dev`. Account is read from `CDK_DEFAULT_ACCOUNT` (set by the CLI from the active
 * credentials, coerced empty → undefined so a credential-free synth stays env-agnostic); region is
 * fixed per env. Stacks are sliced per ADR-0002/0003/0004/0005.
 *
 * **Incremental rollout:** stacks (and resources within them) are wired in one at a time, each
 * proven through the CI/CD pipeline before the next is added. Currently wired: `DataStack`. The
 * stack classes for Identity / Api / Admin / EdgeServices already exist and are added here as their
 * increments land. Deferred entirely: NetworkStack/VPC (until Aurora); the us-east-1 EdgeStack;
 * ObservabilityStack.
 *
 * Wired: DataStack, IdentityStack, ApiStack, AdminStack.
 */
const app = new cdk.App();
const wanthatEnv = resolveEnv(process.env.WANTHAT_ENV ?? app.node.tryGetContext("env"));
const account = process.env.CDK_DEFAULT_ACCOUNT || undefined;
const env: cdk.Environment = { account, region: wanthatEnv.region };
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

app.synth();
