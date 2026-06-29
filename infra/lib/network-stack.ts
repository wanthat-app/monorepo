import { Stack, type StackProps } from "aws-cdk-lib";
import type { Construct } from "constructs";
import type { WanthatEnv } from "./config";

export interface NetworkStackProps extends StackProps {
  readonly wanthatEnv: WanthatEnv;
}

/**
 * NetworkStack — VPC + subnets + security groups (ADR-0003/0004).
 *
 * **Deferred** (not yet instantiated). The only reason this app needs a VPC is Aurora: the relational
 * store for PII + ledger runs in a VPC, and the functions that talk to it (Lambdalith, admin,
 * poller-writer) attach there to reach it via IAM database auth — no RDS Proxy. The serverless
 * compute is otherwise VPC-free (`aws-ec2` here is CDK's *networking* module — VPC/subnets/SG — not
 * EC2 instances).
 *
 * Since Aurora is deferred to the wallet slice, there is nothing in the VPC yet, so the skeleton
 * runs every Lambda outside a VPC (simpler, faster cold starts, no idle networking). This stack and
 * the in-VPC placement of app-api/admin land together with Aurora. Until then it is an empty stub.
 */
export class NetworkStack extends Stack {
  constructor(scope: Construct, id: string, props: NetworkStackProps) {
    super(scope, id, props);
    // VPC defined here when Aurora lands:
    //   new ec2.Vpc(this, "Vpc", { maxAzs: 2, natGateways: 0, subnetConfiguration: [...] })
  }
}
