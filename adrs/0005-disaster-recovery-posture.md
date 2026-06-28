# ADR 0005 — Disaster-recovery posture: single-region active + cross-region backups

- **Status:** Accepted
- **Date:** 2026-06-28
- **Related:** [ADR-0003](0003-datastore-aurora-and-dynamodb.md) (datastores), [ADR-0006](0006-identity-sms-otp-and-passkeys.md) (Cognito replication limit)

## Context

The system holds an append-only money ledger and Israeli PII, so recovery is not optional. Two
constraints frame the level of investment:

- The product availability target is **99.5%** (~3.6 h/month) — lenient; a single-region active
  deployment meets it without active-passive multi-region.
- **Cognito has no multi-Region replication in `il-central-1`** (ADR-0006) — native identity
  failover across regions isn't even available, so a hot multi-region identity tier is off the
  table regardless.

## Decision

**Single-region active in `il-central-1`; `eu-central-1` is a DR / restore target, not a hot
failover.** Backups replicate there; recovery is restore-based.

**Mandatory for MVP:**
- **Aurora PITR** (continuous, in-region) — guards corruption / accidental loss; **RPO ~minutes**.
- **DynamoDB PITR** + on-demand/AWS Backup, with cross-region export/copy for the redirect
  projection and attribution map.
- **Cross-region backup copy → `eu-central-1`:** Aurora automated-snapshot copy; S3 versioning +
  cross-region replication for the event/audit (funnel + audit) data; Secrets Manager
  replication. Region-loss recovery with **RTO ~hours**.
- **Audit-log hash-chain** complements backups for tamper-evidence.

**Explicit targets:** RPO ~minutes (PITR) / ~hours of data for cross-region restore; RTO ~hours
for a full region-loss rebuild.

**Deferred (post-MVP):** active-passive failover — Aurora Global Database, multi-region API, and
a non-native identity-failover strategy (forced by Cognito's lack of `il-central-1` replication,
e.g. user export/restore).

## Alternatives considered

- **Multi-region active-passive now** — not required for a 99.5% SLA; Cognito can't natively
  replicate from `il-central-1`, so identity failover would be non-native anyway; the cost and
  complexity aren't justified at MVP.
- **In-region backups only (no cross-region copy)** — a region incident would mean data loss on
  a money ledger; unacceptable.

## Consequences

- A region incident has a **defined recovery path** (restore from cross-region backups) at RTO
  hours — acceptable for 99.5%.
- Cross-region backups copy **Israeli PII into the EU (`eu-central-1`)** — within the IL/EU
  residency tolerance; recorded here as a conscious data flow.
- Identity (Cognito) has **no cross-region recovery in MVP** — a known, accepted limitation given
  the SLA and the residency-driven region choice.

## Revisit when

The SLA tightens beyond 99.5%, or identity region-loss recovery becomes a hard requirement.
