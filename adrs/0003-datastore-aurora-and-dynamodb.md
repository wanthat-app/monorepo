# ADR 0003 — Datastore: Aurora (PII + money) + DynamoDB (everything else)

- **Status:** Accepted
- **Date:** 2026-06-28
- **Related:** [ADR-0002](0002-app-compute-topology.md) (compute), [ADR-0004](0004-network-topology-nat-free-egress.md) (network), [ADR-0005](0005-disaster-recovery-posture.md) (DR), [ADR-0007](0007-redirect-path-and-latency.md) (redirect)

## Context

The system has two distinct access-pattern classes:

- **PII + money** — customer PII and the append-only wallet ledger + hash-chained audit log. Needs
  ACID (registration provisions customer+wallet atomically), engine-enforced immutability, flexible
  reconciliation/finance queries against retailer payouts, and the strongest residency/sovereignty
  guarantees. → **relational**.
- **Catalog + operational, non-PII** — shared products, recommendations (incl. the
  `recommendation_id → affiliate_url` resolution on the viral redirect hot path), and the opaque,
  best-effort `guestId → customer_id` map. Point-lookups / simple queries, no PII, no ACID
  requirement. → **key-value**.

This holds the money ledger and Israeli PII, so data residency, sovereignty, and DR weigh as
heavily as cost.

## Decision

**Polyglot persistence — the right engine per access-pattern class.**

### Aurora Serverless v2 (PostgreSQL ≥ 15.7, scale-to-zero), `il-central-1` — PII + money only

Holds **only** the crown jewels: **customer PII** and the **money ledger** (wallet entries +
hash-chained audit log). Nothing else — products and recommendations are catalog/operational data
and live in DynamoDB. Lambdas connect via **IAM database authentication** (locally-signed token, no
Secrets Manager call on any hot path), each role scoped to its per-function Postgres user.
Scale-to-zero means idle ≈ storage cost.

### DynamoDB (on-demand), `il-central-1` — catalog + operational

Holds everything that isn't PII or money:
- **Product** — shared catalog item keyed by `(store_id, store_product_id)`; fetched once and reused
  across members, carrying the product-level `affiliate_url` and cashback rates.
- **Recommendation** — keyed by `recommendation_id` (uuid); a member's shareable rec of a product
  (+ optional review + stats). Denormalises `affiliate_url` so the redirect resolves in one lookup;
  a GSI on the owner backs "list my recommendations". This keeps the viral redirect burst off the
  relational layer.
- **`guest_attribution` (guestId → customer_id)** — opaque→opaque, best-effort (ADR-0008); written
  at registration outside the atomic Aurora transaction (allowed to fail), read at conversion by the
  non-VPC Retailer Proxy.

References from these items into Aurora (a recommendation's owner; a wallet entry's recommendation)
are **soft** — plain id attributes, not enforced FKs (KV has none).

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
- Registration stays a single ACID Aurora transaction (customer + empty wallet); products,
  recommendations, and `guest_attribution` are DynamoDB writes outside it.
- Aurora-touching functions are in-VPC; redirect is not — the public path touches only the
  non-PII DynamoDB table.
- **Verify at provisioning:** `il-central-1` Aurora engine + scale-to-zero; reserved-concurrency
  caps hold under `max_connections` at the chosen min ACU; DynamoDB PITR enabled.
