# ADR 0007 — Landing path & latency

- **Status:** Accepted
- **Date:** 2026-06-28
- **Related:** [ADR-0003](0003-datastore-aurora-and-dynamodb.md) (redirect projection), [ADR-0004](0004-network-topology-nat-free-egress.md) (non-VPC), [ADR-0008](0008-consumer-attribution-model.md) (attribution at click)

## Context

The public `/p/{recommendation_id}` redirect is the consumer entry point and the one viral-spiky surface:
the scenario the architecture exists to serve is a link going viral after a quiet period. The
product target is **p95 < 500ms**. It must resolve `recommendation_id → affiliate_url`, decide attribution,
and emit funnel events — fast.

The app is **cookieless** (ADR-0008): the SPA holds the Cognito JWT in JS and sends it as a Bearer
header on `/api/*`. But a click on `/p/{recommendation_id}` is a **top-level navigation**, which carries
neither a Bearer header (those only ride XHR/fetch) nor a cookie — so the server **cannot** know
the consumer's identity from that request. The identity decision therefore happens **client-side**.
That also fits OG unfurling: social crawlers run no JS, so the landing HTML must be server-rendered
with product-specific OG tags regardless.

## Decision

**The landing service is a non-VPC Lambda fronted by a CloudFront → Lambda Function URL (`/p/*`), not API
Gateway.** Two steps:

1. **`GET /p/{recommendation_id}`** → resolve `recommendation_id` in DynamoDB (ADR-0003) and return a minimal
   **OG-tagged landing page + bootstrap JS**. Emit an **impression** event.
2. **Client-side identity + resolve** — the bootstrap JS, on our origin, inspects the SPA's token
   store and calls a **resolve** endpoint that assembles `custom_parameters` — `ref` (the
   `recommendation_id`, always) plus a consumer key — onto the **product-level** affiliate URL and
   returns it:
   - **member** → sends the Bearer token; the endpoint validates it **offline against cached
     Cognito JWKS** (no Cognito call) and injects `customer_id` (`c`) → JS redirects. Automatic,
     no interaction — the logged-in "auto-redirect", done in the browser.
   - **guest** → sends the `guestId` from **localStorage** (ADR-0008); the endpoint injects `g` →
     JS redirects.
   - **neither** → render login / signup / continue-as-guest.
   The resolve emits the **click** event.

It is **not** behind API Gateway's JWT authorizer: that authorizer rejects missing/invalid tokens,
which would break the anonymous landing — and the viral hot path wants the leanest front, not an
extra hop. Token validation is offline JWKS signature verification, so redirect/resolve never call
Cognito at request time.

DynamoDB on the hot path means single-digit-ms reads, $0 idle, no scale-to-zero resume, no VPC
cold-start, and it absorbs the burst natively. The projection is written through at link generation
and is immutable per link → no sync/invalidation.

Both funnel events (**impression**, **click**) are emitted as structured `console.log` lines that a
**CloudWatch Logs subscription filter → Firehose → S3** ships — never an un-awaited `PutRecord`
(Lambda freezes after the response and can silently drop it, losing attribution).

With the DB resume and VPC cold-start gone, latency is dominated by the Node cold start, the OG
landing render, and one client→resolve round-trip. The relaxed target absorbs that round-trip; the
original 500ms is approachable and reachable with provisioned concurrency if real traffic warrants.

## Alternatives considered

- **Postgres on the hot path** — a scale-to-zero database wake (~0.5–3s) plus VPC cold start
  blows the budget at exactly the p90–p95 percentile a burst lands on, and forces RDS Proxy to
  survive the connection storm. DynamoDB removes both the latency and the burst.
- **Provisioned concurrency to hide cold starts** — ~$27–110+/mo standing, which defeats
  scale-to-zero; kept as a later lever only if real traffic warrants it.
- **CloudFront KeyValueStore at the edge** — cheaper still and resolves inside a CloudFront
  Function (the origin Lambda may not run at all); kept as the next escalation if the cold-start
  tail ever hurts conversion.
- **API Gateway with a permissive Lambda authorizer** (to allow anonymous) — an extra hop + cost
  on the viral path for no gain; rejected in favour of the Function URL + offline JWKS validation.
- **Cookie-based session, server-side redirect decision** — a server `301` keyed off a session
  cookie is simpler, but rejected: the app is cookieless (ADR-0008) and cookie-based flows are
  fragile under Safari ITP / third-party-cookie deprecation, and still couldn't carry identity on
  a cross-person shared link without the client step.

## Consequences

- Hot path: `GET /p/{id}` → OG landing (+impression) → client resolve (+click) → redirect. Standing
  redirect + CDN + stream cost stays under ~$8/mo.
- The logged-in case is a client-driven redirect (one resolve call), not a server `301` — the price
  of cookieless + correct OG unfurling, absorbed by the relaxed target.
- The viral burst lands on DynamoDB, which is also why no RDS Proxy is needed (ADR-0002/0003).
- Redirect-p95 monitoring is the trigger to escalate to provisioned concurrency or an edge KVS.
