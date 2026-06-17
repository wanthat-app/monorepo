#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";

/**
 * Wanthat infrastructure entrypoint (AWS CDK).
 *
 * Stacks are sliced per ADR-0005 (compute topology), ADR-0006 (datastore), ADR-0007 (DR).
 * Planned stacks (see lib/README.md):
 *   NetworkStack        VPC/subnets/SGs (in-VPC Aurora -> Lambdas attach here)
 *   DataStack           Aurora Serverless v2 (scale-to-zero) + RDS Proxy + Firehose/S3/Athena + Secrets
 *   IdentityStack       Cognito (native SMS OTP + passkeys) + Post-Confirmation trigger
 *   ApiStack            HTTP API + JWT authorizer + app-api Lambdalith (+ regional WAF)
 *   AdminStack          admin Lambda (own role/exposure)
 *   EdgeServicesStack   redirect Lambda + conversion poller (EventBridge Scheduler)
 *   EdgeStack           CloudFront + S3 site + ACM cert + CloudFront WAF (us-east-1)
 *   ObservabilityStack  dashboards, alarms, SMS kill-switch wiring
 */

const app = new cdk.App();

const region = process.env.CDK_DEFAULT_REGION ?? "il-central-1";
const env: cdk.Environment = { account: process.env.CDK_DEFAULT_ACCOUNT, region };

// TODO: instantiate per-environment stacks, e.g.:
//   const network = new NetworkStack(app, "wanthat-dev-network", { env });
//   new DataStack(app, "wanthat-dev-data", { env, vpc: network.vpc });
// The EdgeStack (CloudFront cert + WAF) must be created in us-east-1 regardless of `region`.

void env;
app.synth();
