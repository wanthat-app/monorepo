import { Duration, Stack, type StackProps } from "aws-cdk-lib";
import * as route53 from "aws-cdk-lib/aws-route53";
import type { Construct } from "constructs";
import type { WanthatEnv } from "./config";

export interface DnsStackProps extends StackProps {
  readonly wanthatEnv: WanthatEnv;
  /** The EXISTING public hosted zone (referenced, never created) for {@link domainName}. */
  readonly hostedZoneId: string;
  readonly domainName: string;
}

/**
 * DnsStack — domain DNS records in our **existing** Route 53 hosted zone (referenced by id, never
 * created). Holds domain-verification / mail records (Zoho today; SPF/DKIM/MX later) as proper CDK
 * IaC, deployed by the pipeline like everything else — not a hand-run CloudFormation side-stack.
 *
 * The us-east-1 `EdgeStack` separately owns the CloudFront apex alias (A/AAAA); these are a different
 * record type, so they coexist in the zone. Only instantiated where a custom domain exists (prod);
 * dev uses CloudFront's `*.cloudfront.net` hostname and has no DNS to manage. Route 53 is a global
 * service, so this stack's region is not significant.
 */
export class DnsStack extends Stack {
  constructor(scope: Construct, id: string, props: DnsStackProps) {
    super(scope, id, props);

    const zone = route53.HostedZone.fromHostedZoneAttributes(this, "Zone", {
      hostedZoneId: props.hostedZoneId,
      zoneName: props.domainName,
    });

    // Zoho domain-ownership verification — an apex ("@") TXT. CDK handles the TXT quoting/chunking.
    new route53.TxtRecord(this, "ZohoVerification", {
      zone,
      ttl: Duration.minutes(5),
      values: ["zoho-verification=zb60222279.zmverify.zoho.com"],
    });
  }
}
