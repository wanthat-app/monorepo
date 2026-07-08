import { Stack, type StackProps } from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import type { Construct } from "constructs";
import type { WanthatEnv } from "./config";

export interface NetworkStackProps extends StackProps {
  readonly wanthatEnv: WanthatEnv;
}

/**
 * NetworkStack — VPC + subnets + security groups (ADR-0003/0004/0020).
 *
 * The only reason this app needs a VPC is Aurora: the relational store for PII + ledger runs in a
 * VPC, and the functions that talk to it (Lambdalith, admin, poller-writer) attach there to reach it
 * via IAM database auth — no RDS Proxy. (`aws-ec2` here is CDK's *networking* module — VPC/subnets/
 * SG — not EC2 instances.)
 *
 * NAT-free (ADR-0004): `natGateways: 0`, a single PRIVATE_ISOLATED subnet group. DynamoDB is reached
 * through a free gateway endpoint. NO interface endpoints (they bill hourly per AZ): `cognito-idp`
 * went with the ADR-0020 split, `secretsmanager` with the secretless in-VPC auth, and the brief
 * `lambda` endpoint (PR #110's link generation) went when the links module moved to the non-VPC
 * `app-auth` edge — a non-VPC function invokes the retailer-proxy for free, so nothing in the VPC
 * needs the Lambda Invoke API. Everything else stays out of the VPC.
 *
 * Two SGs split the trust boundary: `lambdaSg` (in-VPC functions) is allowed to reach `auroraSg`
 * (the cluster) on 5432; nothing else can.
 */
export class NetworkStack extends Stack {
  readonly vpc: ec2.Vpc;
  readonly auroraSg: ec2.SecurityGroup;
  readonly lambdaSg: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: NetworkStackProps) {
    super(scope, id, props);

    this.vpc = new ec2.Vpc(this, "Vpc", {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        { name: "isolated", subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });

    this.lambdaSg = new ec2.SecurityGroup(this, "LambdaSg", {
      vpc: this.vpc,
      // DO NOT edit this string: an EC2 SG description is immutable, so any change forces a REPLACEMENT
      // of the SG, which changes its exported GroupId - and that export is imported by the api/admin/
      // data stacks, so CloudFormation blocks the update ("Cannot update export ... as it is in use").
      // It still reads "app-api" (now the split app-auth/app-core) deliberately; the name is cosmetic.
      description:
        "In-VPC Lambdas (app-api, admin, poller-writer, migrator) - egress to Aurora + endpoints",
      allowAllOutbound: true,
    });

    this.auroraSg = new ec2.SecurityGroup(this, "AuroraSg", {
      vpc: this.vpc,
      description: "Aurora Serverless v2 - Postgres ingress from in-VPC Lambdas only",
      allowAllOutbound: false,
    });
    this.auroraSg.addIngressRule(this.lambdaSg, ec2.Port.tcp(5432), "Postgres from in-VPC Lambdas");

    // DynamoDB over the free gateway endpoint (no NAT) for in-VPC functions.
    this.vpc.addGatewayEndpoint("DynamoDbEndpoint", {
      service: ec2.GatewayVpcEndpointAwsService.DYNAMODB,
    });

    // NO interface endpoints (they bill hourly per AZ). History: `cognito-idp` went with the
    // ADR-0020 split (app-core stopped calling Cognito); `secretsmanager` became unnecessary once
    // nothing in the VPC read secrets (Ed25519 PUBLIC keys in plain env + IAM DB auth migrator);
    // and the short-lived `lambda` endpoint (PR #110 link generation) went when the links module
    // moved to the non-VPC app-auth edge - the sync retailer-proxy invoke is free from there. The
    // in-VPC functions' only AWS dependencies are Aurora (in-VPC) + DynamoDB (free gateway endpoint).
  }
}
