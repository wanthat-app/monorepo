# Architecture Decision Records

Each ADR is a self-contained decision: context, the decision, alternatives considered, and
consequences. **0001–0009** cover the architecture (foundation-first: structure → compute → data
→ network → DR, then the consumer journey: identity → landing → attribution → conversion);
**0010–0016** cover the implementation stack; **0017** extends the architecture set with the
currency / FX model; **0018** fixes the EdgeStack composition (one CloudFront distribution: SPA +
landing); **0019** WhatsApp messaging; **0020** the canonical user identifier; **0021** interim
retailer API throttling; **0006** carries the full auth + customer-PII story (Cognito-native).

> **Renumbered 2026-07-09 (pre-release).** After the auth consolidation into a single record,
> the set was renumbered contiguously (0001-0021). Git history and archived plans under
> `docs/superpowers/` may cite pre-renumber numbers; the mapping is in the commit that
> renumbered.

| # | Decision |
|---|---|
| [0001](0001-monorepo-structure-and-contracts.md) | Monorepo structure & contract strategy (pnpm + Turborepo, Zod schema-first) |
| [0002](0002-app-compute-topology.md) | App compute topology & least-privilege: fifteen functions from one naming registry, one Postgres role per function, a six-arrow invoke matrix, transactional-core/orchestrating-edge + exposure-rule patterns (rewritten 2026-07-17) |
| [0003](0003-datastore-aurora-and-dynamodb.md) | Datastore: Aurora (money ledger only — PII lives in Cognito, 0006) + DynamoDB (nine on-demand tables incl. the redirect path) |
| [0004](0004-network-topology-nat-free-egress.md) | Network topology: NAT-free egress via non-VPC chaining |
| [0005](0005-disaster-recovery-posture.md) | DR posture: single-region active + cross-region backups |
| [0006](0006-cognito-native-auth-and-pii.md) | Cognito-native customer auth + ALL customer PII in Cognito: browser calls `SignUp`/`InitiateAuth`/native `WEB_AUTHN` directly (userless passkey login waived, remembered-phone auto-prompt kept), profile = ID-token claims, Aurora = money only keyed by sub, kill switch enforced in otp-sender, WAF on the pool, lifecycle via disable/delete (replaces the former identity/auth-foundation/passkey records) |
| [0007](0007-landing-path-and-latency.md) | Landing path, latency & front door: HTTP API behind CloudFront `/p/*`, OG-injected SPA shell, client-side identity, DynamoDB hot path |
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
| [0018](0018-edge-front-door-cloudfront.md) | Edge front door: one CloudFront distribution (SPA default + landing `/p/*`), us-east-1 cert + WAF |
| [0019](0019-whatsapp-messaging-capability.md) | WhatsApp messaging capability: reusable `@wanthat/whatsapp` + Cognito Custom SMS Sender (`otp-sender`) over AWS End User Messaging Social (WhatsApp-default OTP + `optin_welcome`); notifications via direct async invoke of `notification-sender` + SQS DLQ — the outbox table/stream is retired (refines [0006](0006-cognito-native-auth-and-pii.md)) |
| [0020](0020-canonical-user-identifier.md) | Canonical user identifier: the Cognito `sub` everywhere (DynamoDB items, attribution `custom_parameters`, invoke payloads, Aurora money rows — no `customer` table since 0006) |
| [0021](0021-retailer-api-throttling-interim.md) | Retailer API throttling, INTERIM: sequential calls in dependency order + one ban-window retry on `ApiCallLimit`; no cross-invoke limiter — revise at poller slice / real traffic / app approval *(Accepted, temporary)* |

## Status & change policy

The **architecture** ADRs (0001–0009) are **locked**: to change one, add a new ADR that
**supersedes** it (linking both ways via `Supersedes:` / `Superseded by:`, flipping the old
record's **Status** to `Superseded`, and updating this index). The **stack** ADRs (0010–0016) are
accepted but still being finalized alongside the initial scaffold, so they may be edited in place
until the scaffold settles — after which the same supersede-don't-edit policy applies.

**Pre-production consolidation (exception while unreleased):** while the MVP is not yet in
production, superseding ADRs may be merged back into (or replace) the records they supersede (see
the numbering note above — applied 2026-07-07 and 2026-07-09) to keep the set small; the replaced
designs live on as *Alternatives considered*. Once the MVP is in production this exception ends
and the supersede-don't-edit policy is absolute.

Region: **il-central-1 (Tel Aviv)**, AWS serverless, CDK + TypeScript.
