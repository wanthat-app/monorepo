import { Stack, type StackProps } from "aws-cdk-lib";
import type { Construct } from "constructs";

/**
 * NetworkStack — VPC + subnets + security groups.
 *
 * Required because the datastore is in-VPC Aurora Serverless v2 (ADR-0006): all app
 * Lambdas attach to this VPC and reach Postgres via RDS Proxy. Private isolated subnets
 * for the DB; egress (NAT or VPC endpoints) for Lambdas that call AliExpress / SNS / etc.
 *
 * Stub — define the VPC here.
 */
export class NetworkStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);
    // TODO: new ec2.Vpc(this, "Vpc", { maxAzs: 2, natGateways: 1, ... })
  }
}
