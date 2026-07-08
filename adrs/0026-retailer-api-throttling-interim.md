# ADR 0026 — Retailer API throttling: sequential calls + single ban-window retry (INTERIM)

- **Status:** Accepted (temporary — revise before scale; see *Revisit triggers*)
- **Date:** 2026-07-08
- **Related:** [ADR-0002](0002-app-compute-topology.md) (retailer proxy), [ADR-0009](0009-conversion-ingestion-poller.md) (poller — the future volume driver)

## Context

The AliExpress affiliate gateway rate-limits per app. Observed during create-link validation
(test-mode app): `ApiCallLimit: Api access frequency exceeds the limit. this ban will last 1
seconds` — roughly one call per second. A single resolve needs two calls (`productdetail.get`,
`link.generate`); fired in parallel they race for the same budget, and the throttle can land on
either — including the essential one. Approved apps get higher limits, but the ceiling never
disappears, and the conversion poller (ADR-0009) will add scheduled bulk calls to the same app
key later.

## Decision (interim)

**Within one `generateLink` invoke, the retailer calls run sequentially in dependency order
(metadata first, link mint last — the all-or-nothing flow), and each call gets exactly one retry
after waiting out the ban window (~1.2s) when the platform answers `ApiCallLimit`.** Any other
failure, or a second throttle, fails the flow with a typed error.

This is deliberately minimal — correct for today's traffic (interactive, low-volume, one resolve
at a time) and simple enough to delete. It is **not** a rate limiter: concurrent invokes do not
coordinate, and nothing enforces a global calls-per-second budget across the proxy's containers.

## Alternatives considered (the likely future shape)

- **A real shared limiter** — a token bucket over the app-wide budget (state in DynamoDB, or a
  reserved-concurrency-1 queue in front of the retailer calls). Needed once concurrent resolves
  or the poller make cross-invoke contention real; overkill for one interactive user today.
- **Exponential backoff with jitter** — better than a single fixed retry under sustained
  contention; pointless while the observed ban is a fixed one-second window.

## Revisit triggers

Revise this decision when any of these arrives:
1. the **conversion poller** slice (bulk `order.listbyindex` sharing the same app key),
2. real concurrent user traffic on resolve,
3. the app leaves test mode and the actual approved rate limits are known.

## Consequences

- A throttled second call adds ~1.2s to a first-ever resolve; cached products are unaffected.
- Under concurrent invokes the retry can still lose (both containers waiting the same window) —
  the flow then fails typed (`upstream_error`) and the user retries; acceptable interim.
