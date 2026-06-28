import { Stack, type StackProps } from "aws-cdk-lib";
import type { Construct } from "constructs";

/**
 * NetworkStack — VPC + subnets + security groups.
 *
 * Scoped to Aurora and the functions that touch it (ADR-0003/0004): the Lambdalith, admin, and
 * poller-writer attach here and reach Postgres directly via IAM database auth — no RDS Proxy.
 * Private isolated subnets for the DB; DynamoDB is reached via a free gateway endpoint. There is
 * **no NAT Gateway**: redirect and the retailer fetchers run outside the VPC, so nothing in-VPC
 * needs internet egress.
 *
 * Stub — define the VPC here.
 */
export class NetworkStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);
    // TODO: new ec2.Vpc(this, "Vpc", { maxAzs: 2, natGateways: 1, ... })
  }
}
