import { Stack, type StackProps } from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import type { Construct } from "constructs";
import type { WanthatEnv } from "./config";

export interface NetworkStackProps extends StackProps {
  readonly wanthatEnv: WanthatEnv;
}

/**
 * NetworkStack — VPC + subnets + security groups (ADR-0003/0004).
 *
 * Scoped to Aurora and the functions that touch it (Lambdalith, admin, poller-writer): they attach
 * here and reach Postgres directly via IAM database auth — no RDS Proxy. **No NAT Gateway**, so
 * private *isolated* subnets only; in-VPC functions reach DynamoDB via a free gateway endpoint and
 * never need internet egress. The landing service and the retailer proxy run outside the VPC.
 *
 * (Aurora itself is deferred to a later slice; this stack stands up the network it will live in,
 * plus the shared SG the in-VPC Lambdas attach to.)
 */
export class NetworkStack extends Stack {
  readonly vpc: ec2.Vpc;
  readonly lambdaSecurityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: NetworkStackProps) {
    super(scope, id, props);

    this.vpc = new ec2.Vpc(this, "Vpc", {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        { name: "isolated", subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });

    // Free gateway endpoint so in-VPC functions reach DynamoDB without a NAT path.
    this.vpc.addGatewayEndpoint("DynamoDbEndpoint", {
      service: ec2.GatewayVpcEndpointAwsService.DYNAMODB,
    });

    this.lambdaSecurityGroup = new ec2.SecurityGroup(this, "InVpcLambdaSg", {
      vpc: this.vpc,
      allowAllOutbound: true,
      description: "In-VPC Lambdas (Lambdalith, admin, poller-writer) — Aurora + DynamoDB endpoint",
    });
  }
}
