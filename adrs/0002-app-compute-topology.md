# ADR 0002 — Application compute topology & least-privilege model

- **Status:** Accepted
- **Date:** 2026-06-28
- **Related:** [ADR-0003](0003-datastore-aurora-and-dynamodb.md) (datastore), [ADR-0004](0004-network-topology-nat-free-egress.md) (VPC placement & egress)

## Context

Compute should be sliced by **real seams** — divergent workload, exposure, privilege, scaling,
and deploy cadence — not by the domain diagram. The core identity/links/wallet domain shares one
relational schema; splitting it along module lines would invite distributed-transaction
complexity and ops overhead a small team can't justify. At the same time, a single monolithic
function gives one execution role the union of every permission, which is wrong for the
money-writing and admin surfaces.

## Decision

### Four compute units, each at a real seam

1. **`identity + links + wallet` Lambdalith** — one Lambda, internal HTTP framework, behind an
   API Gateway HTTP API. `identity` + `wallet` share Aurora and an atomic transaction at
   registration (customer + empty wallet); `links` writes products/recommendations to DynamoDB.
   Similar modest load → keeping them together keeps the function warm and the surface small.
2. **`admin`** — its own Lambda. Different audience (internal operators), highest privilege (the
   only app surface that may write money, via audited adjustments), and different exposure
   (separate hostname / tighter WAF). Isolating it shrinks the public API blast radius and gives
   the high-privilege surface its own tight role.
3. **`landing`** — separate (public, viral-spiky, latency-critical). **Non-VPC**: it resolves
   `recommendation_id → affiliate_url` in DynamoDB (ADR-0003), so it never touches Aurora and needs no
   VPC attachment, internet egress, or DB credentials.
4. **`conversion poller`** — separate (scheduled, sole money writer). The poll flow is
   `EventBridge → Retailer Proxy (calls the IPv4-only retailer API, resolves attribution in
   DynamoDB) → invokes an in-VPC writer (Aurora ledger + audit)`. See ADR-0004.

Plus one shared egress function:

5. **`Retailer Proxy`** — the **single** non-VPC function that holds the retailer credential and
   is the **sole egress** to retailer APIs. It runs the HMAC-signing client and exposes two
   operations — `generateLink` (`link.generate`, called by the Lambdalith's `links` module) and
   `listOrders` (`order.listbyindex`, called by the poll flow). It is one component, not two
   per-flow fetchers, because both are the same signed call to the same gateway under the same
   secret; the *orchestration* seams (sync user-facing link-gen vs scheduled batch poll) stay
   with their owners (the Lambdalith and the poll flow). This gives exactly one secret-holder,
   one audited egress chokepoint, and one place to add per-retailer adapters.

### VPC placement

The only thing that pins a function to the VPC is **Aurora access** (PII + money — ADR-0003).
Aurora-touching code (Lambdalith, admin, poller-writer) runs **in-VPC and connects directly to
Aurora via IAM database authentication — no RDS Proxy**. **Reserved-concurrency caps** on these
low-concurrency functions keep total connections under Aurora `max_connections`. Everything else
runs outside the VPC.

### Least-privilege model

- Lambda IAM is **coarse per function** (one role = that function's needs); we don't pretend
  to do per-module IAM inside the Lambdalith.
- The **money guarantee is enforced at the database**, via per-function Postgres roles/GRANTs:
  Lambdalith + admin-read → **read-only** on `wallet_entry` / `audit_log`; admin adjustments (if
  enabled) → a narrow, audited append path; conversion poller-writer → **append-only** (INSERT,
  no UPDATE/DELETE). This isolates money-write capability by DB grant regardless of Lambda IAM.
- The **retailer secret** lives only in the non-VPC **Retailer Proxy**, under a secret-scoped
  role (ADR-0004); in-VPC money/PII functions never hold it and have no internet egress.

## Alternatives considered

- **Single modular-monolith function** — one IAM role = union of all permissions; can't give the
  admin/money surface its own privilege or exposure.
- **Microservice-per-domain-module on the shared DB** — distributed transactions and ops
  overhead for no isolation we actually need.
- **Always-on Fargate** — pays for idle while the scale-to-zero DB (ADR-0003) is paused; Lambda
  pairs scale-to-zero compute with scale-to-zero data.
- **RDS Proxy for connection pooling** — its only must-have justification was the redirect viral
  burst, which is gone once redirect resolves in DynamoDB; the remaining low-concurrency callers
  connect directly under reserved-concurrency caps.

## Consequences

- Five deploy units (four orchestration seams + the shared Retailer Proxy); admin isolation
  cleanly resolves the highest-privilege surface.
- The integrity property — the app API cannot mutate money tables — holds via DB grants + the
  isolated poller-writer, over direct IAM-auth connections, with no standing proxy cost.
- Lambda-vs-container is settled as Lambda.
