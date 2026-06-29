import { CfnOutput, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as targets from "aws-cdk-lib/aws-route53-targets";
import * as s3 from "aws-cdk-lib/aws-s3";
import type { Construct } from "constructs";
import type { WanthatEnv } from "./config";

export interface EdgeStackProps extends StackProps {
  readonly wanthatEnv: WanthatEnv;
  /** Host of the app HTTP API (`{id}.execute-api.{region}.amazonaws.com`). */
  readonly apiDomain: string;
  /** Host of the landing Function URL (`{id}.lambda-url.{region}.on.aws`). */
  readonly landingDomain: string;
}

/**
 * EdgeStack (**us-east-1**) — the public front door for prod's custom domain.
 *
 * CloudFront terminates TLS at the edge and routes by path: `/api/*` → the app HTTP API, `/p/*` →
 * the landing Function URL, everything else → the static SPA in S3. The ACM cert and (later) the
 * CloudFront WAF must live in us-east-1 — control-plane only; traffic still terminates near the
 * user. Route 53 alias records point the apex + `www` at the distribution.
 *
 * Only instantiated for environments with a `domainName` (prod). The cross-region references to the
 * il-central-1 API/landing are ferried by CDK (`crossRegionReferences`). The CloudFront WAF web ACL
 * and the SPA asset upload are follow-ups.
 */
export class EdgeStack extends Stack {
  constructor(scope: Construct, id: string, props: EdgeStackProps) {
    super(scope, id, props);
    const { wanthatEnv, apiDomain, landingDomain } = props;
    const domainName = wanthatEnv.domainName;
    const hostedZoneId = wanthatEnv.hostedZoneId;
    if (!domainName || !hostedZoneId) {
      throw new Error("EdgeStack requires wanthatEnv.domainName + hostedZoneId (set on prod).");
    }
    const wwwName = `www.${domainName}`;

    const zone = route53.HostedZone.fromHostedZoneAttributes(this, "Zone", {
      hostedZoneId,
      zoneName: domainName,
    });

    // Cert must be in us-east-1 for CloudFront; DNS-validated against the hosted zone (no manual step).
    const certificate = new acm.Certificate(this, "Certificate", {
      domainName,
      subjectAlternativeNames: [wwwName],
      validation: acm.CertificateValidation.fromDns(zone),
    });

    // Private SPA bucket, served via CloudFront with Origin Access Control. Asset upload is later.
    const siteBucket = new s3.Bucket(this, "SiteBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // API GW + Function URL are HTTPS custom origins; they reject a forwarded viewer Host header.
    const dynamicBehavior = (domain: string, methods: cloudfront.AllowedMethods) =>
      ({
        origin: new origins.HttpOrigin(domain, {
          protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: methods,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
      }) satisfies cloudfront.BehaviorOptions;

    const distribution = new cloudfront.Distribution(this, "Distribution", {
      domainNames: [domainName, wwwName],
      certificate,
      defaultRootObject: "index.html",
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(siteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
      additionalBehaviors: {
        "/api/*": dynamicBehavior(apiDomain, cloudfront.AllowedMethods.ALLOW_ALL),
        "/p/*": dynamicBehavior(landingDomain, cloudfront.AllowedMethods.ALLOW_GET_HEAD),
      },
    });

    // Apex + www → CloudFront (A + AAAA).
    const target = route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution));
    new route53.ARecord(this, "AliasApex", { zone, target });
    new route53.AaaaRecord(this, "AliasApexV6", { zone, target });
    new route53.ARecord(this, "AliasWww", { zone, recordName: "www", target });
    new route53.AaaaRecord(this, "AliasWwwV6", { zone, recordName: "www", target });

    new CfnOutput(this, "DistributionDomain", { value: distribution.distributionDomainName });
    new CfnOutput(this, "SiteUrl", { value: `https://${domainName}` });
  }
}
