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
  /**
   * Public runtime config baked into `/config.json` in the SPA bucket, so the deployed SPA learns its
   * backend URLs + Cognito client ids **at load time** (it can't read build-time `VITE_*` — the bundle
   * is built before these stacks' outputs exist). All values are public (client ids, endpoint hosts).
   * These come from il-central-1 stacks, so they cross regions (crossRegionReferences on both ends).
   */
  readonly spaConfig: {
    readonly apiUrl: string;
    /** Region of the Cognito customer pool — the SPA calls cognito-idp directly (ADR-0006). */
    readonly cognitoRegion?: string;
    readonly userPoolClientId: string;
  };
  /**
   * Public runtime config for the ADMIN console's own `/config.json` (admin bucket). Separate from
   * {@link spaConfig} on purpose: the console is its own SPA on its own origin (apps/admin), and the
   * member config no longer carries any admin values.
   */
  readonly adminSpaConfig: {
    /** Env name rendered as the console's environment badge - dev vs prod at a glance. */
    readonly environment: string;
    readonly adminApiUrl: string;
    readonly adminManagedLoginUrl: string;
    readonly adminPoolClientId: string;
  };
}

/**
 * EdgeStack — the public front door (ADR-0007, ADR-0016, ADR-0007, ADR-0018). **Must be us-east-1**:
 * CloudFront's ACM cert and the `CLOUDFRONT`-scoped WAF web ACL are control-plane resources that
 * only live there (traffic still terminates at the edge near the user — Israel via the
 * PRICE_CLASS_200 footprint).
 *
 * TWO CloudFront distributions per environment since the admin-origin split:
 *
 * The MEMBER distribution has two origins:
 * - **default** → a private S3 bucket (OAC) holding the member Vite/React SPA (ADR-0016) AND the
 *   lean landing app (apps/landing: `landing.html` + `/landing-assets/*` — the shell the landing
 *   Lambda injects, so guests on `/p/*` never download the member bundle). SPA client-side routing
 *   is served by rewriting 403/404 to `/index.html`.
 * - **`/p/*`** → the landing HTTP API (ADR-0007/0007), the viral redirect hot path.
 *
 * The ADMIN distribution (`admin.{domainName}`) serves the admin console — its own SPA (apps/admin)
 * on its OWN origin, so employee-pool tokens are storage-isolated from all customer-facing code (an
 * XSS in the member surface can no longer reach an admin session). Same bucket/OAC/SPA-rewrite
 * pattern, plus a strict Content-Security-Policy response-headers policy; it shares the member
 * distribution's WAF web ACL (one CLOUDFRONT ACL may front many distributions).
 *
 * The app-api and admin APIs are **not** fronted here: the SPAs are cookieless and call them directly
 * with a Bearer JWT (ADR-0008/0016), so cross-origin is fine and there is no proxy hop (ADR-0018).
 *
 * Custom domain + Route 53 alias + DNS-validated cert are wired wherever the env carries a
 * `domainName`/`hostedZoneId` — the apex in prod (`wanthat.app`) or a subdomain in dev
 * (`dev.wanthat.app`), both in the same `wanthat.app` zone (`hostedZoneName`); the cert carries
 * `admin.{domainName}` as a SAN. An env with no domain would fall back to the default
 * `*.cloudfront.net` names.
 */
export class EdgeStack extends Stack {
  readonly distribution: cloudfront.Distribution;
  readonly adminDistribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: EdgeStackProps) {
    super(scope, id, props);
    const { wanthatEnv } = props;
    const { domainName, hostedZoneId } = wanthatEnv;
    // The zone is the apex (wanthat.app); the alias record may be a subdomain of it (dev.wanthat.app).
    const zoneName = wanthatEnv.hostedZoneName ?? domainName;
    const isSubdomain = !!domainName && domainName !== zoneName;

    // --- SPA bucket: private, reached only through CloudFront's Origin Access Control ---
    // Contents are reproducible build output (apps/web/dist), so destroying with the stack is safe.
    const siteBucket = new s3.Bucket(this, "SpaBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // --- Admin SPA bucket: same private/OAC/reproducible-build semantics, its own distribution ---
    const adminBucket = new s3.Bucket(this, "AdminSpaBucket", {
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
      domainName && hostedZoneId && zoneName
        ? route53.HostedZone.fromHostedZoneAttributes(this, "Zone", {
            hostedZoneId,
            zoneName,
          })
        : undefined;
    // Admin console hostname — a subdomain of the site (admin.wanthat.app / admin.dev.wanthat.app).
    const adminDomainName = domainName ? `admin.${domainName}` : undefined;
    // Adding the admin SAN REPLACES the certificate (ACM certs are immutable) — expected, safe:
    // CloudFront switches to the new cert in place and the old one is deleted after detachment.
    const certificate =
      domainName && zone
        ? new acm.Certificate(this, "Cert", {
            domainName,
            subjectAlternativeNames: adminDomainName ? [adminDomainName] : undefined,
            validation: acm.CertificateValidation.fromDns(zone),
          })
        : undefined;

    // --- landing origin (cross-region: the landing HTTP API lives in il-central-1) ---
    // The HTTP API's `$default` stage answers at the bare execute-api host, so no origin path.
    const landingDomain = `${props.landingApiId}.execute-api.${wanthatEnv.region}.amazonaws.com`;
    const landingOrigin = new origins.HttpOrigin(landingDomain);

    // Origin-controlled edge cache for the landing page (ADR-0007/0018 amendment 2026-07-17):
    // min/default TTL 0 means ONLY responses that explicitly opt in via Cache-Control are
    // cached - the landing GET page sends `public, max-age=60`, the per-consumer POST resolve
    // sends `no-store` (and POSTs are never cached anyway). The 60s cap is the burst shield:
    // a viral share link is maximally repetitive traffic, and the account Lambda concurrency
    // limit of 10 is shared by EVERY function - without the edge absorbing hot-link repeats,
    // one popular share could throttle the whole account (OTP sends included). Cache key is
    // the path only: the page is identity-free by design (cookieless, no query params).
    // The SPA-deploy CloudFront invalidation also clears it, keeping shell asset refs fresh.
    const landingPageCache = new cloudfront.CachePolicy(this, "LandingPageCache", {
      comment: "wanthat landing /p/ - origin-controlled, max 60s, path-only key",
      minTtl: Duration.seconds(0),
      defaultTtl: Duration.seconds(0),
      maxTtl: Duration.seconds(60),
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
      headerBehavior: cloudfront.CacheHeaderBehavior.none(),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.none(),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
    });

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
          // POST /p/{id}/resolve rides the same behavior as the GET page (ADR-0007/0008).
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          // Origin-controlled 60s cache (see LandingPageCache above). Strip Host so the API
          // sees its own; resolve stays uncached (no-store + POST).
          cachePolicy: landingPageCache,
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

    // --- Admin distribution — the console's OWN origin (admin.{domainName}) ---
    // Strict CSP on every response: the console is a privileged surface, so only its own origin
    // may serve code/styles/assets; connect-src is pinned to the admin API + the employee-pool
    // hosted UI (token endpoint); the Google-Fonts pair the DS loads is allow-listed; and
    // frame-ancestors 'none' forbids embedding (clickjacking). Inline styles stay allowed —
    // React style props render as style attributes. ASCII-only description (WAF/EC2 charset trap).
    const adminCsp = [
      "default-src 'self'",
      "script-src 'self'",
      `connect-src 'self' ${props.adminSpaConfig.adminApiUrl} ${props.adminSpaConfig.adminManagedLoginUrl}`,
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src https://fonts.gstatic.com",
      "img-src 'self' data:",
      "object-src 'none'",
      "base-uri 'self'",
      "frame-ancestors 'none'",
    ].join("; ");
    const adminHeaders = new cloudfront.ResponseHeadersPolicy(this, "AdminHeaders", {
      comment: `wanthat-${wanthatEnv.name} admin console security headers`,
      securityHeadersBehavior: {
        contentSecurityPolicy: { contentSecurityPolicy: adminCsp, override: true },
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        referrerPolicy: {
          referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
          override: true,
        },
        strictTransportSecurity: {
          accessControlMaxAge: Duration.days(365),
          includeSubdomains: false, // admin.{domain} only; the member site sets its own policy
          override: true,
        },
      },
    });

    this.adminDistribution = new cloudfront.Distribution(this, "AdminDistribution", {
      comment: `wanthat-${wanthatEnv.name} admin edge`,
      defaultRootObject: "index.html",
      priceClass: cloudfront.PriceClass.PRICE_CLASS_200, // same footprint as the member site
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      domainNames: adminDomainName ? [adminDomainName] : undefined,
      certificate, // the site cert carries admin.{domainName} as a SAN
      webAclId: webAcl.attrArn, // one CLOUDFRONT-scoped ACL fronts both distributions
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(adminBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: adminHeaders,
      },
      // SPA client-side routing, same as the member distribution: unknown paths -> index.html.
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

    // The console's public origin — written into BOTH config.json files: the member SPA's /admin*
    // redirect stub forwards there, and it names the admin console itself.

    // Upload the member SPA build + the LANDING app build + a runtime `/config.json`, and invalidate
    // the edge cache on each deploy. The asset dirs must exist at synth time; infra build-depends on
    // `@wanthat/web` and `@wanthat/landing-app` (its `package.json`), so Turborepo's `^build` produces
    // both dists before any infra synth/diff/deploy. All three are sources of the SAME deployment (a
    // second BucketDeployment would prune the other's files): the member SPA owns index.html +
    // /assets/*, the landing app owns landing.html + /landing-assets/* (disjoint by construction —
    // the landing Lambda fetches landing.html as its shell, so guests on /p/* never download the
    // member bundle), and the SPA fetches config.json at load so it needs no build-time env.
    // Token values are substituted at deploy time by the BucketDeployment custom resource.
    //
    // Cache-Control: no-cache on EVERYTHING here. Without it S3 sends no Cache-Control and
    // BROWSERS cache index.html heuristically, so a user keeps referencing an old bundle even
    // after the CloudFront invalidation below (made the create-link validation look broken).
    // no-cache still allows conditional revalidation (ETag 304s), so the cost is one cheap
    // round-trip per load; the hashed /assets/* files change name per build, so a fancier
    // long-cache split is not worth a second deployment construct at this size.
    new s3deploy.BucketDeployment(this, "SpaDeployment", {
      destinationBucket: siteBucket,
      sources: [
        s3deploy.Source.asset(path.join(REPO_ROOT, "apps", "web", "dist")),
        s3deploy.Source.asset(path.join(REPO_ROOT, "apps", "landing", "dist")),
        s3deploy.Source.jsonData("config.json", props.spaConfig),
      ],
      cacheControl: [s3deploy.CacheControl.noCache()],
      distribution: this.distribution,
      distributionPaths: ["/*"],
    });

    // The admin console's build + its own runtime config.json (mirrors the site deployment).
    new s3deploy.BucketDeployment(this, "AdminSpaDeployment", {
      destinationBucket: adminBucket,
      sources: [
        s3deploy.Source.asset(path.join(REPO_ROOT, "apps", "admin", "dist")),
        s3deploy.Source.jsonData("config.json", props.adminSpaConfig),
      ],
      cacheControl: [s3deploy.CacheControl.noCache()],
      distribution: this.adminDistribution,
      distributionPaths: ["/*"],
    });

    if (zone && domainName) {
      const aliasTarget = route53.RecordTarget.fromAlias(
        new targets.CloudFrontTarget(this.distribution),
      );
      // Apex site → recordName omitted (zone apex, e.g. wanthat.app). Subdomain site → the full
      // subdomain (e.g. dev.wanthat.app); CDK keeps it within the zone.
      const recordName = isSubdomain ? domainName : undefined;
      new route53.ARecord(this, "AliasA", { zone, recordName, target: aliasTarget });
      new route53.AaaaRecord(this, "AliasAaaa", { zone, recordName, target: aliasTarget });

      // Admin console alias — always a subdomain of the zone (admin.{domainName}).
      const adminAliasTarget = route53.RecordTarget.fromAlias(
        new targets.CloudFrontTarget(this.adminDistribution),
      );
      new route53.ARecord(this, "AdminAliasA", {
        zone,
        recordName: adminDomainName,
        target: adminAliasTarget,
      });
      new route53.AaaaRecord(this, "AdminAliasAaaa", {
        zone,
        recordName: adminDomainName,
        target: adminAliasTarget,
      });
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
    new CfnOutput(this, "AdminDistributionId", {
      value: this.adminDistribution.distributionId,
    });
    new CfnOutput(this, "AdminSiteUrl", {
      value: `https://${adminDomainName ?? this.adminDistribution.distributionDomainName}`,
    });
  }
}
