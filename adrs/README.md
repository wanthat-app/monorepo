# Architecture Decision Records

Each ADR is a self-contained decision: context, the decision, alternatives considered, and
consequences. Ordered foundation-first (structure → compute → data → network → DR), then the
consumer journey (identity → redirect → attribution → conversion).

| # | Decision |
|---|---|
| [0001](0001-monorepo-structure-and-contracts.md) | Monorepo structure & contract strategy (pnpm + Turborepo, Zod schema-first) |
| [0002](0002-app-compute-topology.md) | App compute topology & least-privilege (four Lambda units) |
| [0003](0003-datastore-aurora-and-dynamodb.md) | Datastore: Aurora (PII + ledger) + DynamoDB (redirect path) |
| [0004](0004-network-topology-nat-free-egress.md) | Network topology: NAT-free egress via non-VPC chaining |
| [0005](0005-disaster-recovery-posture.md) | DR posture: single-region active + cross-region backups |
| [0006](0006-identity-sms-otp-and-passkeys.md) | Identity: SMS OTP + passkeys, with an SMS-abuse kill switch |
| [0007](0007-redirect-path-and-latency.md) | Redirect path & latency |
| [0008](0008-consumer-attribution-model.md) | Consumer attribution model (no click-log lookup) |
| [0009](0009-conversion-ingestion-poller.md) | Conversion ingestion: scheduled reconciliation poller |

## Status & change policy

These ADRs are **locked** — accepted, design-phase complete. From here on an accepted ADR is
**not edited in place**: to change a decision, add a **new ADR that supersedes** the affected one,
linking both ways (`Supersedes:` / `Superseded by:`), flipping the old record's **Status** to
`Superseded`, and updating this index.

Region: **il-central-1 (Tel Aviv)**, AWS serverless, CDK + TypeScript.
