# ADR 0011 — Backend service stack: Hono + Powertools

- **Status:** Accepted
- **Date:** 2026-06-28
- **Related:** [ADR-0002](0002-app-compute-topology.md) (Lambdalith), [ADR-0007](0007-landing-path-and-latency.md) / [ADR-0009](0009-conversion-ingestion-poller.md) (structured-log events)

## Context

The Lambdalith and admin functions need an internal HTTP router behind API Gateway; every function
needs structured logging, tracing, and metrics — including the redirect/poller funnel events that
are emitted as structured log lines (ADR-0007/0009).

## Decision

- **Hono** as the in-Lambda HTTP framework. It routes the Lambdalith (`/auth/*`, `/me`, `/links`,
  `/products/*`, `/wallet*`) and admin (`/admin/*`) via Hono's AWS Lambda adapter. Tiny, fast,
  ESM-first, fully typed; request/response validation at the boundary uses the shared **Zod**
  schemas (ADR-0001).
- **AWS Lambda Powertools for TypeScript** (Logger, Tracer, Metrics) across **all** functions —
  structured JSON logs with a propagated correlation id, X-Ray tracing, and EMF metrics. The
  impression/click/conversion events are emitted via the Powertools **Logger**, which a CloudWatch
  Logs subscription → Firehose ships (ADR-0007/0009).

## Alternatives considered

- **Middy + a standalone router** — more manual wiring than Hono's batteries-included routing.
- **Express / Fastify on Lambda** — heavier, more cold-start weight, not ESM-lean.
- **Roll-your-own logging/metrics** — reinvents Powertools' EMF + X-Ray integration; Powertools is
  the AWS-standard and removes that boilerplate.

## Consequences

- One Hono app per service, exported through the Lambda adapter as the handler.
- A Powertools middleware wraps every handler; structured-log events stay off the hot path and are
  shipped out-of-band (ADR-0007).
