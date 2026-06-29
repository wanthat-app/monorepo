import { Stack } from "aws-cdk-lib";

/**
 * NetworkStack — VPC + subnets + security groups (ADR-0003/0004). **Deferred** — not instantiated.
 *
 * The only reason this app needs a VPC is Aurora: the relational store for PII + ledger runs in a
 * VPC, and the functions that talk to it (Lambdalith, admin, poller-writer) attach there to reach it
 * via IAM database auth — no RDS Proxy. (`aws-ec2` is CDK's *networking* module — VPC/subnets/SG —
 * not EC2 instances; the compute stays serverless.)
 *
 * Aurora is deferred to the wallet slice, so there's nothing in the VPC yet — the skeleton runs every
 * Lambda outside a VPC. This stack, and the in-VPC placement of app-api/admin, land with Aurora.
 * Empty stub until then.
 */
export class NetworkStack extends Stack {}
