# ADR 0006 — Datastore: Aurora Serverless v2 (scale-to-zero) in il-central-1

- **Status:** Accepted
- **Date:** 2026-06-17
- **Context refs:** Solution Design Document D4, D6, §5.1, §10; PRD §9.3 (data residency); AWS Architecture (MVP) §3.4
- **Related:** [ADR-0001](0001-redirect-latency-relaxed-for-mvp.md) (relaxed latency absorbs pause-resume), [ADR-0005](0005-app-compute-topology.md) (in-VPC compute)

## Context

The SDD left the primary datastore open between **Aurora Serverless v2** (named in the
architecture doc) and an external scale-to-zero Postgres such as **Neon** (leaned toward in
§5.1 on cost). This is the money ledger + Israeli PII, so residency, sovereignty and DR
weigh as heavily as cost.

Verified facts:
- **Aurora Serverless v2 is available in `il-central-1`**, and **scale-to-zero / auto-pause**
  is supported on Aurora PostgreSQL **15.7+**. Paused instances background-wake periodically
  (~hours), so idle ≈ storage cost, not a perfect $0.
- **Neon's nearest appropriate region is Frankfurt (`eu-central-1`)** (no verified Tel Aviv
  region), and Neon is **US-headquartered → CLOUD Act exposure** even on EU data.

The historical reason to prefer Neon was Aurora's old ~$43/mo floor — **scale-to-zero erases
that**, making idle cost roughly a tie.

## Decision

**Aurora Serverless v2 (PostgreSQL 15.7+), scale-to-zero, in `il-central-1`,** with **RDS
Proxy** for Lambda connection pooling.

Rationale, once idle cost is a tie:
- **Residency/sovereignty:** data physically in Israel, AWS-operated — no US-company /
  CLOUD-Act third party holding the ledger + PII. Best fit for Israeli Privacy Law + PRD §9.3.
- **DR (feeds the #6 discussion):** AWS-native PITR + cross-region snapshots / Aurora Global
  Database to `eu-central-1`, controlled by us — important since Cognito has no multi-Region
  replication in `il-central-1` (ADR-0004).
- **In-region latency** (vs. cross-region TLV↔Frankfurt ~30–50ms/query for Neon).
- **Single vendor**, CDK-native, IAM auth, Secrets Manager rotation.

This settles compute: scale-to-zero DB pairs with **scale-to-zero Lambda** (in-VPC + RDS
Proxy), **not** always-on Fargate. The VPC cold-start + pause-resume latency is exactly what
**ADR-0001** already accepted via the relaxed redirect target — no new debt.

## Consequences

- App Lambdas run **in-VPC + RDS Proxy** (ADR-0005).
- Accept periodic background-wake (not a perfect $0 idle) and VPC + RDS Proxy wiring — the
  trade for residency + DR control + single-vendor on a financial datastore.
- Engine pinned to a scale-to-zero-capable version (Aurora PostgreSQL ≥ 15.7).
- Use `il-central-1` engine + scale-to-zero must be sanity-checked at provisioning time.

## Rejected

- **Neon (Frankfurt):** simplest (no VPC) and cheap, but EU-only residency, US/CLOUD-Act
  exposure on the ledger + PII, cross-region latency, and an extra vendor for the most
  sensitive data. The simplicity win doesn't outweigh those for a financial system.
