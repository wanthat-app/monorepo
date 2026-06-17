# ADR 0005 — App compute topology & least-privilege model

- **Status:** Accepted
- **Date:** 2026-06-17
- **Context refs:** Solution Design Document §3.5, §6, §10.4, §11, D1; AWS Architecture (MVP) §3.3, §3.5
- **Related:** [ADR-0002](0002-conversion-ingestion-scheduled-poller.md) (poller), [ADR-0006](0006-datastore-aurora-serverless-v2.md) (datastore → in-VPC)

## Context

D1 specifies a "modular monolith" app API + a separate redirect service. Re-examined from
first principles: compute should be sliced by **real seams** (divergent workload, exposure,
privilege, scaling, deploy cadence) — not by the domain diagram. Splitting along DDD module
lines for one shared database invites distributed-transaction complexity and ops overhead a
small team can't justify.

§3.5 also claims "IAM least-privilege per function (links reads only the AE secret)", which is
**incompatible** with a single-function monolith (one execution role = union of all module
permissions).

## Decision

### Compute units (four, each at a real seam)

1. **`identity + links + wallet` Lambdalith** — one Lambda, internal HTTP framework, behind
   API Gateway HTTP API. They share one Postgres schema, cross-table transactions (e.g.
   registration provisions customer+wallet+referral), shared types (D2 monorepo), and similar
   modest load → keeping them together avoids distributed transactions and keeps the function
   warm. This is the right default; extract a module later only under concrete pressure.
2. **`admin` — split out** into its own Lambda. Real seam: different audience (internal
   operators), highest privilege (only app-API surface that may write money via audited
   adjustments), and different exposure (separate hostname / tighter WAF). Shrinks the public
   API blast radius and gives the high-privilege surface its own tight role.
3. **Redirect service** — already separate (public, viral-spiky, latency-critical). Unchanged.
4. **Conversion poller** — already separate (ADR-0002; scheduled, outbound-only, sole money
   writer). Unchanged.

All app Lambdas run **in-VPC + RDS Proxy** (consequence of ADR-0006's Aurora choice).

### Least-privilege model (corrects §3.5)

- **Drop "IAM least-privilege per module"** for the Lambdalith — one role = union of its
  modules' needs. State this honestly.
- **Enforce the money guarantee at the database, not IAM**, via **per-function Postgres
  roles/grants**:
  - Lambdalith + admin-read → **read-only** on `wallet_entry` / `audit_log`;
  - admin adjustments (if enabled) → narrowly-scoped append path, audited;
  - conversion poller → **append-only** (INSERT, no UPDATE/DELETE) on `wallet_entry` /
    `audit_log`.
  This isolates money-write capability to the poller by DB grant, regardless of Lambda IAM —
  stronger than IAM-per-module.
- **AliExpress secret — Option A (pragmatic MVP):** keep in the Lambdalith, accept coarse IAM,
  compensate with **CloudTrail alarming on `GetSecretValue`** for the AE secret + rotation.
  Escalation (Option B): split the AliExpress-calling code into its own function with a
  secret-scoped role — do this when the secret's blast radius grows (multiple network creds /
  other tokens).

## Consequences

- Four deploy units; `admin` isolation cleanly resolves the #5 IAM concern for the
  highest-privilege surface.
- The real integrity property (app API cannot mutate money tables) is enforced by DB grants +
  the already-separate poller — more robust than the doc's IAM framing.
- Lambda-vs-container settled as **Lambda** (see ADR-0006: scale-to-zero DB pairs with
  scale-to-zero compute; always-on Fargate would pay for idle while the DB is paused).
