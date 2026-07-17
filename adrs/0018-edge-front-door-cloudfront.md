# ADR 0018 — Edge front door: one CloudFront distribution (SPA + landing), us-east-1

- **Status:** Accepted
- **Date:** 2026-06-29
- **Related:** [ADR-0016](0016-frontend-stack.md) (static SPA on S3/CloudFront), [ADR-0007](0007-landing-path-and-latency.md) (landing path) / [ADR-0007](0007-landing-path-and-latency.md) (landing HTTP API), [ADR-0008](0008-consumer-attribution-model.md) (cookieless Bearer), [ADR-0004](0004-network-topology-nat-free-egress.md) (non-VPC)

## Context

Several earlier ADRs name an "EdgeStack" without pinning its composition: ADR-0016 serves the SPA as
"static files from S3 + CloudFront (EdgeStack)"; ADR-0007/0007 front the landing `/p/*` path with
"CloudFront → landing HTTP API." This ADR fixes how those compose into one distribution, what it does
**not** front, and why it must be a separate region.

Constraints in play:

- CloudFront's **ACM certificate** and a **`CLOUDFRONT`-scoped WAF web ACL** are control-plane
  resources that exist **only in us-east-1**. The rest of the system is il-central-1 (ADR-0004).
- The app is **cookieless** (ADR-0008): the SPA holds the Cognito JWT in memory and sends it as a
  `Bearer` header on every app/admin call. Bearer headers ride XHR/fetch and work cross-origin under
  CORS — they do **not** require same-origin fronting.
- The landing `/p/*` click is a **top-level navigation** on the viral hot path; it benefits from edge
  caching, the WAF, and a custom-domain URL that unfurls cleanly.

## Decision

**One CloudFront distribution in a us-east-1 `EdgeStack`, with two origins:**

1. **default behavior → private S3 bucket (Origin Access Control).** Holds the Vite/React SPA build
   (ADR-0016). The bucket blocks all public access; only CloudFront (OAC) can read it. SPA
   client-side routing is served by rewriting **403/404 → `/index.html` (200)**.
2. **`/p/*` behavior → the landing HTTP API** (ADR-0007) with an **origin-controlled edge
   cache** (amended 2026-07-17; was cache-disabled): min/default TTL 0, max 60 s, path-only
   cache key — only responses that opt in via `Cache-Control` are cached. The landing GET
   page sends `public, max-age=60`; the per-consumer `POST /resolve` sends `no-store` (and
   POSTs are never cached). The 60 s cap is the viral-burst shield: hot-link traffic is
   maximally repetitive, and the account-wide Lambda concurrency limit (10) is shared by
   every function — the edge absorbing repeats keeps one popular share from throttling the
   account. Safe because the page is identity-free by design (ADR-0008: attribution is
   stamped at resolve time, never in the page). `Host` stripped
   (`ALL_VIEWER_EXCEPT_HOST_HEADER`) so the API receives its own host. This is a **cross-region**
   origin (CloudFront/us-east-1 → HTTP API/il-central-1); the CDK app sets
   `crossRegionReferences: true` on both the producing (`EdgeServicesStack`) and consuming
   (`EdgeStack`) stacks so the landing `apiId` flows across regions.

**The app and admin HTTP APIs are NOT fronted by this distribution.** The SPA calls them directly at
their HTTP API endpoints with a `Bearer` JWT (ADR-0008/0016); cross-origin is fine and avoids an
extra proxy hop and a second cross-region origin. Admin keeps its own separate exposure (ADR-0002).

**Custom domain is environment-gated.** Where the env carries a `domainName` + `hostedZoneId` (prod →
`wanthat.app`), the stack issues a **DNS-validated ACM cert** against the public Route 53 zone and
**aliases the apex** (A + AAAA) at the distribution. Dev has neither, so it runs on the default
`*.cloudfront.net` hostname. Price class is **200** (includes the Middle East / Israel edge).

## Alternatives considered

- **Also proxy `/api/*` (and `/auth/*`) through CloudFront** — single same-origin host, no CORS. But
  cookieless Bearer (ADR-0008) makes same-origin unnecessary, and it adds a second cross-region
  origin plus cache/forwarding config on an authenticated, uncacheable path. Rejected; revisit only
  if a CORS or same-origin requirement emerges.
- **Relocate the SPA bucket/landing to us-east-1** to avoid the cross-region origin — splits data and
  ownership across regions for no gain; the landing projection (DynamoDB) and its Lambda are
  il-central-1 by ADR-0003/0004. Rejected.
- **A second distribution for landing** — two distributions, two WAFs, two certs for one product
  surface. The single-distribution/two-origin split is simpler. Rejected.

## Consequences

- **CloudFront error responses are distribution-wide**, so the SPA's 403/404→`index.html` rewrite
  also covers `/p/*`. The **landing handler must answer its own not-found with `200`** (an OG "gone"
  page, already ADR-0007's model), never 403/404, or the rewrite would swallow it.
- The `EdgeStack` is **us-east-1**; everything else stays il-central-1. Cross-region references add a
  small SSM-export + reader custom resource — the accepted cost of the region split.
- The SPA's API base URL is configured to the il-central-1 app HTTP API endpoint, and **the app
  API must send CORS headers** allowing the SPA origin (the CloudFront/custom domain). That CORS
  wiring lands with the app-API slice; it is out of scope for the EdgeStack itself.
- SPA bucket contents are reproducible build output, so the bucket is `DESTROY` + auto-delete; a
  `BucketDeployment` uploads `apps/web/dist` and invalidates the cache on each deploy.
