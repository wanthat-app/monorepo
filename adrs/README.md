# Architecture Decision Records

Each ADR is a self-contained decision: context, the decision, alternatives considered, and
consequences. **0001–0009** cover the architecture (foundation-first: structure → compute → data
→ network → DR, then the consumer journey: identity → landing → attribution → conversion);
**0010–0016** cover the implementation stack; **0017** extends the architecture set with the
currency / FX model; **0018** supersedes ADR-0007's landing front-door (Function URL → HTTP API);
**0019** fixes the EdgeStack composition (one CloudFront distribution: SPA + landing).

| # | Decision |
|---|---|
| [0001](0001-monorepo-structure-and-contracts.md) | Monorepo structure & contract strategy (pnpm + Turborepo, Zod schema-first) |
| [0002](0002-app-compute-topology.md) | App compute topology & least-privilege (four Lambda units) |
| [0003](0003-datastore-aurora-and-dynamodb.md) | Datastore: Aurora (PII + ledger) + DynamoDB (redirect path) |
| [0004](0004-network-topology-nat-free-egress.md) | Network topology: NAT-free egress via non-VPC chaining |
| [0005](0005-disaster-recovery-posture.md) | DR posture: single-region active + cross-region backups |
| [0006](0006-identity-sms-otp-and-passkeys.md) | Identity: SMS OTP + passkeys, with an SMS-abuse kill switch |
| [0007](0007-landing-path-and-latency.md) | Landing path & latency *(front door superseded by [0018](0018-landing-front-door-http-api.md))* |
| [0008](0008-consumer-attribution-model.md) | Consumer attribution model (no click-log lookup) |
| [0009](0009-conversion-ingestion-poller.md) | Conversion ingestion: scheduled reconciliation poller |
| [0010](0010-language-modules-build-toolchain.md) | Language, modules & build toolchain (ESM, Node 24, esbuild, tsx) |
| [0011](0011-backend-service-stack.md) | Backend service stack: Hono + Powertools |
| [0012](0012-data-access-and-migrations.md) | Data access & migrations: Kysely + plain-SQL migrations |
| [0013](0013-testing-strategy.md) | Testing: Vitest + CDK assertions + Testcontainers |
| [0014](0014-dev-tooling-biome.md) | Dev tooling: Biome (lint + format) |
| [0015](0015-cicd-and-environment-promotion.md) | CI/CD & environment promotion: GitHub Actions + OIDC |
| [0016](0016-frontend-stack.md) | Frontend stack: Vite + React SPA |
| [0017](0017-currency-model-and-fx-rate-sourcing.md) | Currency model & FX rate sourcing (hold settlement currency, convert at withdrawal, Bank of Israel rate) |
| [0018](0018-landing-front-door-http-api.md) | Landing front door: API Gateway HTTP API (supersedes ADR-0007's Function URL — unavailable in il-central-1) |
| [0019](0019-edge-front-door-cloudfront.md) | Edge front door: one CloudFront distribution (SPA default + landing `/p/*`), us-east-1 cert + WAF |

## Status & change policy

The **architecture** ADRs (0001–0009) are **locked**: to change one, add a new ADR that
**supersedes** it (linking both ways via `Supersedes:` / `Superseded by:`, flipping the old
record's **Status** to `Superseded`, and updating this index). The **stack** ADRs (0010–0016) are
accepted but still being finalized alongside the initial scaffold, so they may be edited in place
until the scaffold settles — after which the same supersede-don't-edit policy applies.

Region: **il-central-1 (Tel Aviv)**, AWS serverless, CDK + TypeScript.
