# ADR 0007 — Redirect path & latency

- **Status:** Accepted
- **Date:** 2026-06-28
- **Related:** [ADR-0003](0003-datastore-aurora-and-dynamodb.md) (redirect projection), [ADR-0004](0004-network-topology-nat-free-egress.md) (non-VPC), [ADR-0008](0008-consumer-attribution-model.md) (attribution at click)

## Context

The public `/p/{short_id}` redirect is the consumer entry point and the one viral-spiky surface:
the scenario the architecture exists to serve is a link going viral after a quiet period. The
product target is **p95 < 500ms**. The hot path must resolve `short_id → affiliate_url`, decide
attribution, and emit a click — without letting any of that slow the `301`.

## Decision

**Redirect is a non-VPC Lambda that resolves `short_id → affiliate_url` in DynamoDB** (ADR-0003),
then:

1. **Branches on auth state** (ADR-0008): authenticated → auto-`301` with `customer_id` in
   `custom_parameters`; anonymous → an OG-tagged landing page, setting a `guestId` cookie.
2. **Emits the click off the `301` path** as a structured `console.log` line; a **CloudWatch
   Logs subscription filter → Firehose → S3** ships it.

DynamoDB on the hot path (rather than the relational store) means single-digit-ms reads, $0 idle,
no scale-to-zero database resume, and no VPC cold-start — and it absorbs the viral burst
natively. The projection is written through at `link.generate` and is immutable per link, so
there is no sync/invalidation problem.

Click emission must stay **off** the `301` path reliably: an un-awaited `PutRecord` is unsafe
because Lambda freezes after the response and can silently drop the write, losing consumer
attribution — hence the structured-log-line + Logs-subscription approach.

With the database resume and VPC cold-start removed, **the 500ms p95 target is within reach**;
the only remaining variables are the Node Lambda cold start and edge→origin RTT. For MVP we keep
a modestly relaxed target to avoid paying for provisioned concurrency — not because the datastore
forces it.

## Alternatives considered

- **Postgres on the hot path** — a scale-to-zero database wake (~0.5–3s) plus VPC cold start
  blows the budget at exactly the p90–p95 percentile a burst lands on, and forces RDS Proxy to
  survive the connection storm. DynamoDB removes both the latency and the burst.
- **Provisioned concurrency to hide cold starts** — ~$27–110+/mo standing, which defeats
  scale-to-zero; kept as a later lever only if real traffic warrants it.
- **CloudFront KeyValueStore at the edge** — cheaper still and resolves inside a CloudFront
  Function (the origin Lambda may not run at all); kept as the next escalation if the cold-start
  tail ever hurts conversion.

## Consequences

- Hot path: resolve in DynamoDB → emit click → `301`. Standing redirect + CDN + stream cost
  stays under ~$8/mo.
- The viral burst lands on DynamoDB, which is also why no RDS Proxy is needed (ADR-0002/0003).
- Redirect-p95 monitoring is the trigger to escalate to provisioned concurrency or an edge KVS.
