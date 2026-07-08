# Architecture Decision Records

Each ADR is a self-contained decision: context, the decision, alternatives considered, and
consequences. **0001–0009** cover the architecture (foundation-first: structure → compute → data
→ network → DR, then the consumer journey: identity → landing → attribution → conversion);
**0010–0016** cover the implementation stack; **0017** extends the architecture set with the
currency / FX model; **0019** fixes the EdgeStack composition (one CloudFront distribution: SPA +
landing); **0020** carries the auth foundation incl. the auth-edge/core split; **0022** the full
passkey story; **0023** WhatsApp messaging; **0025** the canonical user identifier.

> **Numbering gaps are deliberate.** Pre-production (2026-07-07) the set was consolidated: each
> superseding ADR was folded into the record it superseded, with the replaced design preserved
> under *Alternatives considered* — 0018 → [0007](0007-landing-path-and-latency.md),
> 0021 → [0020](0020-auth-foundation.md), 0024 → [0022](0022-faceid-passkey-authentication.md).
> The numbers 0018/0021/0024 are retired and must not be reused.

| # | Decision |
|---|---|
| [0001](0001-monorepo-structure-and-contracts.md) | Monorepo structure & contract strategy (pnpm + Turborepo, Zod schema-first) |
| [0002](0002-app-compute-topology.md) | App compute topology & least-privilege (four Lambda units) |
| [0003](0003-datastore-aurora-and-dynamodb.md) | Datastore: Aurora (PII + ledger) + DynamoDB (redirect path) |
| [0004](0004-network-topology-nat-free-egress.md) | Network topology: NAT-free egress via non-VPC chaining |
| [0005](0005-disaster-recovery-posture.md) | DR posture: single-region active + cross-region backups |
| [0006](0006-identity-sms-otp-and-passkeys.md) | Identity: SMS OTP + passkeys, with an SMS-abuse kill switch |
| [0007](0007-landing-path-and-latency.md) | Landing path, latency & front door: HTTP API behind CloudFront `/p/*`, OG-injected SPA shell, client-side identity, DynamoDB hot path (absorbed 0018) |
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
| [0019](0019-edge-front-door-cloudfront.md) | Edge front door: one CloudFront distribution (SPA default + landing `/p/*`), us-east-1 cert + WAF |
| [0020](0020-auth-foundation.md) | Auth foundation: `customer` provisioned in `/auth/register`, non-VPC auth edge + in-VPC core split, Ed25519 ticket bridge (verification secretless), DynamoDB kill switch, unified flow, employee pool (absorbed 0021) |
| [0022](0022-faceid-passkey-authentication.md) | FaceID = platform WebAuthn passkeys: custom discoverable ceremony (`@wanthat/webauthn` + `passkey_credential`), automatic biometric login (auto-modal armed on focus / conditional-UI autofill), admin token exchange to Cognito tokens, OTP recovery (absorbed 0024) |
| [0023](0023-whatsapp-messaging-capability.md) | WhatsApp messaging capability: reusable `@wanthat/whatsapp` + Cognito Custom SMS Sender over AWS End User Messaging Social (WhatsApp-default OTP + `optin_welcome`); DynamoDB-Streams outbox NAT-free bridge (refines [0006](0006-identity-sms-otp-and-passkeys.md)) *(Proposed)* |
| [0025](0025-canonical-user-identifier.md) | Canonical user identifier: the Cognito `sub` everywhere outside Aurora's own FKs (DynamoDB items, attribution `custom_parameters`, invoke payloads); `customer.id` stays Aurora-internal, joined via unique `cognito_sub` |

## Status & change policy

The **architecture** ADRs (0001–0009) are **locked**: to change one, add a new ADR that
**supersedes** it (linking both ways via `Supersedes:` / `Superseded by:`, flipping the old
record's **Status** to `Superseded`, and updating this index). The **stack** ADRs (0010–0016) are
accepted but still being finalized alongside the initial scaffold, so they may be edited in place
until the scaffold settles — after which the same supersede-don't-edit policy applies.

**Pre-production consolidation (one-time exception, 2026-07-07):** while the MVP is not yet in
production, superseding ADRs were merged back into the records they superseded (see the numbering
note above) to keep the set small; the replaced designs live on as *Alternatives considered*. Once
the MVP is in production this exception ends and the supersede-don't-edit policy is absolute.

Region: **il-central-1 (Tel Aviv)**, AWS serverless, CDK + TypeScript.
