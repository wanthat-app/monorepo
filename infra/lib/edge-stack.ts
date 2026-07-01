import * as path from "node:path";
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as targets from "aws-cdk-lib/aws-route53-targets";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import * as wafv2 from "aws-cdk-lib/aws-wafv2";
import type { Construct } from "constructs";
import { REPO_ROOT, type WanthatEnv } from "./config";

export interface EdgeStackProps extends StackProps {
  readonly wanthatEnv: WanthatEnv;
  /**
   * `apiId` of the landing HTTP API (EdgeServicesStack, il-central-1), fronted on `/p/*`. Crosses
   * regions — this stack is us-east-1 — so the app sets `crossRegionReferences: true` on both ends.
   */
  readonly landingApiId: string;
}

/**
 * EdgeStack — the public front door (ADR-0007, ADR-0016, ADR-0018, ADR-0019). **Must be us-east-1**:
 * CloudFront's ACM cert and the `CLOUDFRONT`-scoped WAF web ACL are control-plane resources that
 * only live there (traffic still terminates at the edge near the user — Israel via the
 * PRICE_CLASS_200 footprint).
 *
 * One CloudFront distribution, two origins:
 * - **default** → a private S3 bucket (OAC) holding the Vite/React SPA (ADR-0016). SPA client-side
 *   routing is served by rewriting 403/404 to `/index.html`.
 * - **`/p/*`** → the landing HTTP API (ADR-0007/0018), the viral redirect hot path.
 *
 * The app-api and admin APIs are **not** fronted here: the SPA is cookieless and calls them directly
 * with a Bearer JWT (ADR-0008/0016), so cross-origin is fine and there is no proxy hop (ADR-0019).
 *
 * Custom domain (apex) + Route 53 alias + DNS-validated cert are wired only where the env carries a
 * `domainName`/`hostedZoneId` (prod → wanthat.app); dev runs on the default `*.cloudfront.net` name.
 */
export class EdgeStack extends Stack {
  readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: EdgeStackProps) {
    super(scope, id, props);
    const { wanthatEnv } = props;
    const { domainName, hostedZoneId } = wanthatEnv;

    // --- SPA bucket: private, reached only through CloudFront's Origin Access Control ---
    // Contents are reproducible build output (apps/web/dist), so destroying with the stack is safe.
    const siteBucket = new s3.Bucket(this, "SpaBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // --- WAF (CLOUDFRONT scope; us-east-1 only) — managed common rules + a per-IP rate cap ---
    const webAcl = new wafv2.CfnWebACL(this, "CloudFrontWebAcl", {
      scope: "CLOUDFRONT",
      defaultAction: { allow: {} },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: `wanthat-${wanthatEnv.name}-cf`,
        sampledRequestsEnabled: true,
      },
      rules: [
        {
          name: "CommonRuleSet",
          priority: 1,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: "AWS",
              name: "AWSManagedRulesCommonRuleSet",
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: `wanthat-${wanthatEnv.name}-cf-common`,
            sampledRequestsEnabled: true,
          },
        },
        {
          name: "RateLimit",
          priority: 2,
          action: { block: {} },
          statement: { rateBasedStatement: { limit: 2000, aggregateKeyType: "IP" } },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: `wanthat-${wanthatEnv.name}-cf-rate`,
            sampledRequestsEnabled: true,
          },
        },
      ],
    });

    // --- custom domain (prod only) — DNS-validated cert + apex alias against the public zone ---
    const zone =
      domainName && hostedZoneId
        ? route53.HostedZone.fromHostedZoneAttributes(this, "Zone", {
            hostedZoneId,
            zoneName: domainName,
          })
        : undefined;
    const certificate =
      domainName && zone
        ? new acm.Certificate(this, "Cert", {
            domainName,
            validation: acm.CertificateValidation.fromDns(zone),
          })
        : undefined;

    // --- landing origin (cross-region: the landing HTTP API lives in il-central-1) ---
    // The HTTP API's `$default` stage answers at the bare execute-api host, so no origin path.
    const landingDomain = `${props.landingApiId}.execute-api.${wanthatEnv.region}.amazonaws.com`;
    const landingOrigin = new origins.HttpOrigin(landingDomain);

    this.distribution = new cloudfront.Distribution(this, "Distribution", {
      comment: `wanthat-${wanthatEnv.name} edge`,
      defaultRootObject: "index.html",
      priceClass: cloudfront.PriceClass.PRICE_CLASS_200, // includes the Middle East (Israel) edge
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      domainNames: domainName ? [domainName] : undefined,
      certificate,
      webAclId: webAcl.attrArn,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(siteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      additionalBehaviors: {
        "/p/*": {
          origin: landingOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
          // Redirect resolution is per-consumer; don't cache. Strip Host so the API sees its own.
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        },
      },
      // SPA client-side routing: serve index.html for unknown paths. The landing handler must
      // answer its own not-found with 200 (an OG "gone" page, ADR-0007), never 403/404, so these
      // distribution-wide rewrites never swallow a `/p/*` response.
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: "/index.html",
          ttl: Duration.minutes(5),
        },
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: "/index.html",
          ttl: Duration.minutes(5),
        },
      ],
    });

    // Upload the SPA build and invalidate the edge cache on each deploy. The asset dir must exist at
    // synth time; infra build-depends on `@wanthat/web` (its `package.json`), so Turborepo's `^build`
    // produces `apps/web/dist` before any infra synth/diff/deploy.
    new s3deploy.BucketDeployment(this, "SpaDeployment", {
      destinationBucket: siteBucket,
      sources: [s3deploy.Source.asset(path.join(REPO_ROOT, "apps", "web", "dist"))],
      distribution: this.distribution,
      distributionPaths: ["/*"],
    });

    if (zone && domainName) {
      const aliasTarget = route53.RecordTarget.fromAlias(
        new targets.CloudFrontTarget(this.distribution),
      );
      // recordName omitted → the zone apex (wanthat.app).
      new route53.ARecord(this, "AliasA", { zone, target: aliasTarget });
      new route53.AaaaRecord(this, "AliasAaaa", { zone, target: aliasTarget });
    }

    // --- Edge observability dashboard (us-east-1) ---
    // CloudFront and the CLOUDFRONT-scoped WAF publish metrics only in us-east-1, so this dashboard
    // lives here (same region, local refs) rather than the il-central-1 ObservabilityStack, which
    // would need cross-region metric plumbing. CloudFront metrics use the Region="Global" dimension.
    const env = wanthatEnv.name;
    const cfDims = { DistributionId: this.distribution.distributionId, Region: "Global" };
    const cfRate = (metricName: string, label: string) =>
      new cloudwatch.Metric({
        namespace: "AWS/CloudFront",
        metricName,
        dimensionsMap: cfDims,
        region: "us-east-1",
        period: Duration.minutes(5),
        statistic: "Average",
        label,
      });
    // WAF: a SEARCH expression matches the ACL-level series by its metric name, so we do not depend on
    // the exact CloudFront-scope value of the Region dimension. `Rule="ALL"` is the ACL aggregate.
    const wafAcl = (metricName: string, label: string) =>
      new cloudwatch.MathExpression({
        expression: `SEARCH('{AWS/WAFV2,Region,Rule,WebACL} MetricName="${metricName}" WebACL="wanthat-${env}-cf" Rule="ALL"', 'Sum', 300)`,
        label,
        searchRegion: "us-east-1",
        period: Duration.minutes(5),
      });
    const edgeDashboard = new cloudwatch.Dashboard(this, "EdgeDashboard", {
      dashboardName: `wanthat-${env}-edge`,
    });
    edgeDashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: "CloudFront requests",
        left: [
          new cloudwatch.Metric({
            namespace: "AWS/CloudFront",
            metricName: "Requests",
            dimensionsMap: cfDims,
            region: "us-east-1",
            period: Duration.minutes(5),
            statistic: "Sum",
            label: "requests",
          }),
        ],
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: "CloudFront error rate (percent)",
        left: [
          cfRate("TotalErrorRate", "total"),
          cfRate("4xxErrorRate", "4xx"),
          cfRate("5xxErrorRate", "5xx"),
        ],
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: "WAF requests (ACL)",
        left: [wafAcl("AllowedRequests", "allowed"), wafAcl("BlockedRequests", "blocked")],
        width: 24,
      }),
    );

    new CfnOutput(this, "DistributionDomainName", {
      value: this.distribution.distributionDomainName,
    });
    new CfnOutput(this, "DistributionId", { value: this.distribution.distributionId });
    new CfnOutput(this, "SiteUrl", {
      value: `https://${domainName ?? this.distribution.distributionDomainName}`,
    });
  }
}
