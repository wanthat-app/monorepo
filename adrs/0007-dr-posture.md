# ADR 0007 — DR posture: single-region active + cross-region backups

- **Status:** Accepted
- **Date:** 2026-06-17
- **Context refs:** Solution Design Document D6, §10, §14, §15 (99.5% availability); PRD §9.3, §10.3; AWS Architecture (MVP) §3.5
- **Related:** [ADR-0004](0004-sms-otp-passkeys-and-sms-kill-switch.md) (Cognito no multi-Region replication in il-central-1), [ADR-0006](0006-datastore-aurora-serverless-v2.md) (Aurora PITR / cross-region backup)

## Context

D6 names `il-central-1` primary and `eu-central-1` "fallback" but specifies no replication,
backup strategy, or RPO/RTO. For an append-only **money ledger**, recovery is not optional —
and "fallback region" with nothing replicated to it is aspirational, not a plan.

Two constraints:
- The PRD availability target is **99.5%** (~3.6 h/month) — lenient; **single-region active
  meets it**. Active-passive multi-region is not required for the SLA.
- **Cognito has no multi-Region replication in `il-central-1`** (ADR-0004) — native identity
  failover across regions is not even available.

## Decision

**Single-region active in `il-central-1`; `eu-central-1` is a DR / restore target, not a hot
failover.** Backups replicate there; recovery is restore-based.

**Mandatory for MVP:**
- **Aurora PITR** (continuous, in-region) — guards corruption / accidental loss; **RPO ~minutes**.
- **Cross-region backup copy → `eu-central-1`:** Aurora automated snapshot copy; S3 versioning
  + cross-region replication for the event/audit (funnel + audit) data; Secrets Manager
  replication. Region-loss recovery with **RTO ~hours**.
- Audit-log hash-chain (§14) complements backups for tamper-evidence.

**Explicit targets:** RPO ~minutes (PITR) / ~hours of data for cross-region restore; RTO
~hours for a full region-loss rebuild. Stated as a conscious choice, not a gap.

**Deferred (post-MVP):** active-passive failover — Aurora Global Database, multi-region API,
and an identity-failover strategy (which Cognito's lack of `il-central-1` replication would
force to be non-native, e.g. user export/restore). Revisit if the SLA tightens beyond 99.5%
or identity region-loss becomes a hard requirement.

## Consequences

- A region incident has a **defined recovery path** (restore from cross-region backups),
  not a hope — at RTO hours, acceptable for 99.5%.
- Cross-region backups copy **Israeli PII into EU (`eu-central-1`)** — within the SDD's
  "IL/EU" residency tolerance (PRD §9.3); recorded here as a conscious data-flow.
- D6 wording should change from "fallback region" to "DR/restore region" with these RPO/RTO
  numbers.
- Identity (Cognito) has **no** cross-region recovery in MVP — a known, accepted limitation
  given the SLA and the residency-driven region choice.
