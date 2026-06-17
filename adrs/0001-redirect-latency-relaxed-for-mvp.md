# ADR 0001 — Relax the redirect latency target for MVP

- **Status:** Accepted
- **Date:** 2026-06-17
- **Context refs:** PRD §10.3; Solution Design Document §15 (NFR), §18 (open questions); AWS Architecture (MVP) §1

## Context

The PRD/SDD specify a redirect NFR of **p95 < 500ms** on `/p/{short_id}`. The MVP
redirect design is intentionally the simplest one: `CloudFront → Lambda → PostgreSQL`,
resolving `short_id → affiliate_url` on the hot path, with no edge key-value store and no
provisioned concurrency.

A latency-budget estimate shows that design cannot meet 500ms p95 in the very scenario the
architecture exists to serve — a link going viral after a quiet period. Worst-case
(`~2.4s`) stacks:

- Lambda cold start (Node 20 + `pg` + SDK): ~0.4–0.9s
- Scale-to-zero Postgres wake (if a scale-to-zero managed Postgres is used): ~0.5–3s
- Global single-region (il-central-1) CloudFront edge→origin RTT for distant viewers: ~0.12–0.28s

Because the burst ramps concurrency from zero, ~5–10% of a burst's requests are cold —
landing the cold path at roughly **p90–p95**, i.e. the SLO is breached at exactly the
percentile it is specified on.

Fixes exist (resolve `short_id` at the edge via DynamoDB or CloudFront KeyValueStore →
pennies/month and faster; or provisioned concurrency → ~$27–110+/mo standing, which
defeats scale-to-zero). Both add cost or a second datastore to keep in sync.

## Decision

For the MVP we **relax the redirect target to p95 ≤ ~2.5s** and keep the simplest design
(single Postgres datastore, redirect Lambda reads it on the hot path, no edge KV, no
provisioned concurrency). This is a **conscious tradeoff** favouring build simplicity and
near-zero idle cost over the original 500ms target.

## Consequences

- Hot path stays: resolve `short_id` → emit click → `301`. No second datastore to sync.
- Cost stays at the SDD §5.1 `<$8/mo` redirect + CDN + stream line.
- Click emission must remain **off** the 301 path *reliably*: the redirect Lambda emits the
  click as a structured `console.log` line and returns the 301; a **CloudWatch Logs
  subscription filter → Firehose → S3** ships it. (A naive un-awaited `PutRecord` is
  unsafe — Lambda freezes after the response and can silently drop the write, losing
  consumer attribution.)
- §13's redirect-p95 monitoring stays in place as the **revisit trigger**.

## Revisit when

Real traffic warrants it — specifically when redirect-p95 monitoring (§13) shows sustained
volume / virality where the latency hurts conversion. At that point, move `short_id`
resolution to an edge KV (DynamoDB or CloudFront KeyValueStore) rather than adding
provisioned concurrency.
