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

    // Apex ("@") TXT — one record set carrying every apex TXT string (Route 53 can hold only ONE
    // TXT record set per name, so Zoho's ownership-verification value and the SPF policy coexist as
    // separate values here). Resolvers return all strings; each consumer picks its own (Zoho matches
    // the verification token; SPF validators match the `v=spf1` string). CDK handles TXT quoting.
    // NOTE: construct id stays `ZohoVerification` so the CFN logical id is unchanged — adding SPF is
    // an in-place update of the deployed record, not a delete/recreate.
    new route53.TxtRecord(this, "ZohoVerification", {
      zone,
      ttl: Duration.minutes(5),
      values: [
        "zoho-verification=zb60222279.zmverify.zoho.com",
        "v=spf1 include:zohomail.com ~all",
      ],
    });

    // Zoho mail exchangers (apex) — lower priority is preferred; Zoho publishes 10/20/50.
    new route53.MxRecord(this, "ZohoMx", {
      zone,
      ttl: Duration.minutes(5),
      values: [
        { priority: 10, hostName: "mx.zoho.com" },
        { priority: 20, hostName: "mx2.zoho.com" },
        { priority: 50, hostName: "mx3.zoho.com" },
      ],
    });

    // Zoho DKIM public key — a TXT at the `zmail._domainkey` selector. Single string (234 chars, under
    // the 255-char TXT limit). Mail receivers fetch this to verify Zoho's DKIM signatures.
    new route53.TxtRecord(this, "ZohoDkim", {
      zone,
      recordName: "zmail._domainkey",
      ttl: Duration.minutes(5),
      values: [
        "v=DKIM1; k=rsa; p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCdAJOVs0n44nZtCBDhOYncfFll29DLgBR1XIveunYEoTZBu6tCk67yhYlrmFP4DPjBCDsZ6CbLy1lv4ziQa6RNWbgeNnQEfAKGIWEm+q/uw/8mmzrDgwoAf4uGwPEsA42qX3DN/HfgbSMj5CaiXWh+SlvCDCY1FWWmPLRDwhWS3QIDAQAB",
      ],
    });

    // DMARC — a TXT at the `_dmarc` name. Starts in monitor mode (`p=none`): nothing is blocked or
    // quarantined; aggregate reports (rua) go to dennis@wanthat.app so alignment can be confirmed
    // before tightening to quarantine/reject. Relaxed alignment (the default) suits Zoho SPF+DKIM.
    new route53.TxtRecord(this, "Dmarc", {
      zone,
      recordName: "_dmarc",
      ttl: Duration.minutes(5),
      values: ["v=DMARC1; p=none; rua=mailto:dennis@wanthat.app"],
    });
  }
}
