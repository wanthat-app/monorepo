#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { NetworkStack } from "../lib/network-stack";

/**
 * Wanthat infrastructure entrypoint (AWS CDK).
 *
 * Stacks are sliced per ADR-0002 (compute topology), ADR-0003 (datastore), ADR-0004 (network),
 * ADR-0005 (DR). Planned stacks (see lib/README.md):
 *   NetworkStack        VPC/subnets/SGs for Aurora + the in-VPC functions only; no NAT Gateway
 *   DataStack           Aurora Serverless v2 (scale-to-zero, IAM auth, no RDS Proxy) + DynamoDB
 *                       (short_id projection + guest_attribution) + Firehose/S3/Athena + Secrets
 *   IdentityStack       Cognito (native SMS OTP + passkeys) + Post-Confirmation trigger
 *   ApiStack            HTTP API + JWT authorizer + app-api Lambdalith (in-VPC) (+ regional WAF)
 *   AdminStack          admin Lambda (in-VPC, own role/exposure)
 *   EdgeServicesStack   landing Lambda (non-VPC -> DynamoDB); conversion poller (non-VPC
 *                       Retailer Proxy + in-VPC writer); EventBridge Scheduler
 *   EdgeStack           CloudFront + S3 site + ACM cert + CloudFront WAF (us-east-1)
 *   ObservabilityStack  dashboards, alarms, SMS kill-switch wiring
 */

const app = new cdk.App();

const region = process.env.CDK_DEFAULT_REGION ?? "il-central-1";
const env: cdk.Environment = { account: process.env.CDK_DEFAULT_ACCOUNT, region };

// Per-environment stacks (ADR-0005). Only NetworkStack exists so far; the remaining stacks
// are stubs to be implemented. The EdgeStack (CloudFront cert + WAF) must live in us-east-1.
new NetworkStack(app, "wanthat-dev-network", { env });

app.synth();
