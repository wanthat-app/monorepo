# ADR 0007 — Landing path, latency & front door

- **Status:** Accepted *(consolidated 2026-07-07: a former HTTP-API front-door ADR is
  merged into this record; the Function-URL mechanism it replaced is preserved under Alternatives)*
- **Date:** 2026-06-28 (front door revised 2026-06-29; consolidated 2026-07-07)
- **Related:** [ADR-0003](0003-datastore-aurora-and-dynamodb.md) (redirect projection),
  [ADR-0004](0004-network-topology-nat-free-egress.md) (non-VPC),
  [ADR-0008](0008-consumer-attribution-model.md) (attribution at click),
  [ADR-0011](0011-backend-service-stack.md) (HTTP API),
  [ADR-0018](0018-edge-front-door-cloudfront.md) (CloudFront)

## Context

The public `/p/{recommendation_id}` landing is the consumer entry point and the one viral-spiky
surface: the scenario the architecture exists to serve is a link going viral after a quiet period.
The product target is **p95 < 500ms**. It must resolve `recommendation_id → affiliate_url`, decide
attribution, and emit funnel events — fast.

The app is **cookieless** (ADR-0008): the SPA holds the Cognito JWT in JS and sends it as a Bearer
header on API calls. But a click on `/p/{recommendation_id}` is a **top-level navigation**, which
carries neither a Bearer header (those only ride XHR/fetch) nor a cookie — so the server **cannot**
know the consumer's identity from that request. The identity decision therefore happens
**client-side**. That also fits OG unfurling: social crawlers run no JS, so the landing HTML must be
server-rendered with product-specific OG tags regardless.

## Decision

**The landing service is a non-VPC Lambda fronted by a public API Gateway HTTP API (no JWT
authorizer), behind CloudFront on `/p/*`.** Two parts:

1. **Server side — bots and first paint.** `GET /p/{recommendation_id}` resolves the
   recommendation (DynamoDB, ADR-0003), injects product-specific **OG/Twitter tags + a content
   snapshot** into the SPA shell, and returns it. Crawlers get a rich preview without running JS;
   humans boot the SPA. An **impression** event is emitted. Absolute URLs and the shell fetch use a
   configured `SITE_ORIGIN`, never request headers (SSRF/cache-poisoning guard).
2. **Client side — identity + resolve.** The SPA page runs the same session/passkey machinery as
   the rest of the app and is **Aurora-free** (a member is recognised by a valid Cognito refresh —
   tokens, not profile):
   - **member** (stored session) → recognised → redirect to the store with attribution;
   - **returning passkey device, no session** → one-prompt native passkey login with the remembered phone (ADR-0006) → redirect;
   - **neither** → signup / login / continue-as-guest (`guestId` in localStorage, ADR-0008).
   The resolve step assembles `custom_parameters` — `ref` (the `recommendation_id`) plus the
   consumer key (`c` customer / `g` guest) — onto the product-level affiliate URL and emits the
   **click** event.

It is **not** behind the JWT authorizer: that authorizer rejects missing/invalid tokens, which would
break the anonymous landing. Token checks are offline (JWKS signature / refresh exchange), so the
hot path never calls Cognito synchronously.

DynamoDB on the hot path means single-digit-ms reads, $0 idle, no scale-to-zero resume, no VPC
cold-start, and it absorbs the burst natively. The projection is written through at link generation
and is immutable per link → no sync/invalidation.

Both funnel events (**impression**, **click**) are emitted as structured `console.log` lines that a
**CloudWatch Logs subscription filter → Firehose → S3** ships — never an un-awaited `PutRecord`
(Lambda freezes after the response and can silently drop it, losing attribution).

Per-surface **request throttling** is configured centrally (`infra/lib/config.ts` → `THROTTLING`)
and applied to each HTTP API's `$default` stage: `landing` (viral, high headroom), `userWallet`
(the authenticated app API, moderate), `admin` (internal, low).

## Alternatives considered

- **Lambda Function URL as the front door** — the original decision, and **not available in
  il-central-1** (confirmed in-account: `AWS::Lambda::Url` → `TypeNotFoundException`;
  `CreateFunctionUrlConfig` → `AccessDeniedException` on the regional endpoint). A custom resource
  can't create one either (the API operations themselves are absent), and relocating the landing to
  us-east-1 splits the viral path across regions for no gain. Replaced by the HTTP API — same proxy
  event shape, handler unchanged; costs ~$1/M origin requests where a Function URL is free
  (mitigated by CloudFront caching; small at MVP scale), and one front-door pattern now spans
  app / admin / landing. Revisit only if Function URLs reach il-central-1.
- **Postgres on the hot path** — a scale-to-zero database wake (~20s) plus VPC cold start blows the
  budget at exactly the p90–p95 percentile a burst lands on, and forces RDS Proxy to survive the
  connection storm. DynamoDB removes both.
- **Provisioned concurrency to hide cold starts** — ~$27–110+/mo standing, defeats scale-to-zero;
  kept as a later lever only if real traffic warrants it.
- **CloudFront KeyValueStore at the edge** — cheaper still and resolves inside a CloudFront
  Function; kept as the next escalation if the cold-start tail ever hurts conversion.
- **API Gateway with a permissive Lambda authorizer** (to allow anonymous) — an extra hop + cost on
  the viral path for no gain; rejected in favour of a public HTTP API + offline validation.
- **Cookie-based session, server-side redirect decision** — a server `301` keyed off a session
  cookie is simpler, but the app is cookieless (ADR-0008), cookie flows are fragile under Safari
  ITP / third-party-cookie deprecation, and identity still couldn't ride a cross-person shared link
  without the client step.

## Consequences

- Hot path: `GET /p/{id}` → OG-injected shell (+impression) → client identity + resolve (+click) →
  redirect. Standing redirect + CDN + stream cost stays small (~$8/mo + ~$1/M origin requests).
- The logged-in case is a client-driven redirect, not a server `301` — the price of cookieless +
  correct OG unfurling, absorbed by the relaxed target.
- The landing never touches Aurora (recognition = token validity, not profile) — the viral burst
  lands on DynamoDB only, which is also why no RDS Proxy is needed (ADR-0002/0003).
- Redirect-p95 monitoring is the trigger to escalate to provisioned concurrency or an edge KVS.
