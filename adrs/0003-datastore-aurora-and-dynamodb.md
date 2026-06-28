# ADR 0003 — Datastore: Aurora (PII + ledger) + DynamoDB (redirect path)

- **Status:** Accepted
- **Date:** 2026-06-28
- **Related:** [ADR-0002](0002-app-compute-topology.md) (compute), [ADR-0004](0004-network-topology-nat-free-egress.md) (network), [ADR-0005](0005-disaster-recovery-posture.md) (DR), [ADR-0007](0007-redirect-path-and-latency.md) (redirect)

## Context

The system has two distinct access-pattern classes:

- **Authoritative, sensitive, transactional** — customer PII, the append-only wallet ledger +
  hash-chained audit log, the referral graph, and authoritative link records. Needs ACID
  cross-table transactions (registration provisions customer+wallet+referral atomically),
  engine-enforced immutability, and flexible reconciliation/finance queries against retailer
  payouts. → **relational**.
- **High-volume, non-PII, point-lookup** — `short_id → affiliate_url` resolution on the public,
  viral-spiky redirect hot path, and the opaque, best-effort `guestId → customer_id` attribution
  map. No joins, no PII, no ACID requirement. → **key-value**.

This holds the money ledger and Israeli PII, so data residency, sovereignty, and DR weigh as
heavily as cost.

## Decision

**Polyglot persistence — the right engine per access-pattern class.**

### Aurora Serverless v2 (PostgreSQL ≥ 15.7, scale-to-zero), `il-central-1` — system of record

Holds all sensitive + authoritative data: customer PII, wallet ledger + hash-chained audit log,
referral graph, authoritative link records. Lambdas connect via **IAM database authentication**
(locally-signed token, no Secrets Manager call on any hot path), each role scoped to its
per-function Postgres user. Scale-to-zero means idle ≈ storage cost.

### DynamoDB (on-demand), `il-central-1` — redirect projection + guest attribution

Holds the two non-PII, hot-path items:
- **`short_id → affiliate_url`** — written through at `link.generate`, read by the non-VPC
  redirect Lambda; immutable per link, so no cache-invalidation problem. Keeps the viral redirect
  burst off the relational layer.
- **`guest_attribution` (guestId → customer_id)** — opaque→opaque, best-effort (ADR-0008);
  written at registration outside the atomic Aurora transaction (allowed to fail), read at
  conversion by the non-VPC poller-fetcher.

On-demand DynamoDB is true scale-to-zero ($0 idle), single-digit-ms, absorbs bursts natively,
has PITR, and needs no VPC (free gateway endpoint for any in-VPC caller).

### No RDS Proxy

With redirect on DynamoDB, Aurora never sees the viral burst. The remaining Aurora callers are
low-concurrency / rate-limited and connect directly, with reserved-concurrency caps (ADR-0002)
holding under `max_connections`.

## Alternatives considered

- **All-relational, including the redirect lookup** — the viral burst hits a small scale-to-zero
  Aurora, which forces either RDS Proxy (~$22–33/mo standing, plus a pooler↔auto-pause
  interaction risk) or provisioned concurrency. More cost and complexity than a DynamoDB lookup
  (<$1/mo) that also removes the burst.
- **All-DynamoDB, including the wallet** — ~10× cheaper and deletes the VPC entirely, but
  relocates the ledger's hardest guarantees (engine-enforced immutability, re-derivable balances,
  live reconciliation) into app code + IAM + Athena, and gives up network-layer egress
  containment on the money path. Not worth it for a financial MVP. *Revisit if operational
  simplicity comes to outweigh those guarantees.*
- **Neon / external scale-to-zero Postgres** — EU-only residency (nearest region Frankfurt),
  US-headquartered → CLOUD-Act exposure on the ledger + PII, cross-region query latency, and an
  extra vendor for the most sensitive data.
- **ElastiCache for the redirect lookup** — an always-on, in-VPC node (~$24–30/mo for an HA
  pair) that's dominated on cost and fit by DynamoDB for an immutable point lookup.

## Consequences

- Residency strengthened: all PII consolidated in one in-region relational store — cleaner
  data-subject deletion and audit than scattering PII across engines.
- Registration stays a single ACID Aurora transaction; `guest_attribution` is the one
  deliberately non-atomic, best-effort cross-store write.
- Aurora-touching functions are in-VPC; redirect is not — the public path touches only the
  non-PII DynamoDB table.
- **Verify at provisioning:** `il-central-1` Aurora engine + scale-to-zero; reserved-concurrency
  caps hold under `max_connections` at the chosen min ACU; DynamoDB PITR enabled.
