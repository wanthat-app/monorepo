# ADR 0018 — Landing front door: API Gateway HTTP API (not a Lambda Function URL)

- **Status:** Accepted
- **Date:** 2026-06-29
- **Supersedes:** [ADR-0007](0007-landing-path-and-latency.md) — **only its front-door mechanism**
  (Function URL → HTTP API); the rest of ADR-0007 carries forward unchanged.
- **Related:** [ADR-0007](0007-landing-path-and-latency.md) (landing path), [ADR-0004](0004-network-topology-nat-free-egress.md) (non-VPC), [ADR-0011](0011-backend-service-stack.md) (HTTP API)

## Context

ADR-0007 fronts the public landing/redirect path (`/p/*`) with a **Lambda Function URL** behind
CloudFront. But **Lambda Function URLs are not available in il-central-1** (our primary region) —
confirmed directly in-account:

- **CloudFormation:** `AWS::Lambda::Url` → `TypeNotFoundException` in il-central-1, but `LIVE` in
  us-east-1. (A deploy fails with `Template format error: Unrecognized resource types: [AWS::Lambda::Url]`.)
- **Lambda API:** `GetFunctionUrlConfig` / `CreateFunctionUrlConfig` → `AccessDeniedException: Unable
  to determine service/operation name to be authorized` in il-central-1 (the regional endpoint
  doesn't recognize the operation) versus a normal `ResourceNotFoundException` in us-east-1.

So the Function-URL decision simply cannot be realized in our region.

## Decision

Front the landing Lambda with a **public API Gateway HTTP API** (no JWT authorizer), CloudFront-fronted
on `/p/*`. The landing handler is unchanged — HTTP API (v2) and Function URLs use the same proxy event
shape. **Everything else in ADR-0007 carries forward**: non-VPC Lambda, cookieless client-side
identity + resolve, `c`/`g`/`ref` attribution, DynamoDB single-digit-ms reads, offline JWKS validation
(no Cognito call), impression/click → Firehose events, and the p95 target.

Per-surface **request throttling** is configured centrally (`infra/lib/config.ts` → `THROTTLING`) and
applied to each HTTP API's `$default` stage: `landing` (viral, high headroom), `userWallet` (the
authenticated app-api, moderate), `admin` (internal, low).

## Alternatives considered

- **Relocate landing to us-east-1** (where Function URLs work) — splits the landing path into another
  region; cross-region complexity + latency for no gain over an in-region HTTP API. Rejected.
- **Create the Function URL out-of-band via a custom resource** — impossible: the Lambda API
  operations themselves are unavailable in il-central-1, so an SDK-based custom resource can't create
  one either.
- **Keep the Function URL** — not viable; the stack fails to deploy (`Unrecognized resource types`).

## Consequences

- The landing front door now costs **~$1 per million origin requests** (HTTP API) where a Function URL
  endpoint is free — mitigated by CloudFront caching and small at MVP scale. ADR-0007's "~$8/mo
  standing cost" gains this caveat on the viral path.
- **One** front-door pattern (HTTP API) across app-api / admin / landing — simpler than two.
- HTTP API adds per-route/stage throttling knobs, now used (see `THROTTLING`).
- Revisit if Lambda Function URLs become available in il-central-1.
