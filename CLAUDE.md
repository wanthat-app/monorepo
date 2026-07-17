# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

`wanthat` (repo: `wanthat-mono`) is the monorepo for **Wanthat** — an Israeli two-sided
affiliate-cashback MVP on AWS, serverless-first, **AWS CDK + TypeScript**, region
**il-central-1 (Tel Aviv)**. Architecture decisions are recorded in [`adrs/`](./adrs)
(see [`adrs/README.md`](./adrs/README.md) for the full index) — **read those before changing
structure, compute topology, datastore, network, attribution, or auth.** ADRs are locked:
change a decision by adding a new superseding ADR, not by editing an accepted one in place.

## Stack & tooling

- **Monorepo:** pnpm workspaces + Turborepo. TypeScript everywhere (Node 24, arm64 Lambdas).
- **IaC:** AWS CDK v2 (`aws-cdk-lib`) in `infra/`.
- **Cloud (serverless-first):** Lambda, API Gateway HTTP API, Cognito (two pools — customer
  PII lives in Cognito attributes, ADR-0006), **Aurora Serverless v2** (PostgreSQL,
  scale-to-zero) for **money only** (append-only wallet ledger + hash-chained audit log),
  **DynamoDB** (on-demand) for everything non-money (product cache, recommendations, guest
  attribution, runtime config/kill switches, counters, FX cache — nine tables),
  Kinesis Firehose → S3 + Glue/Athena (funnel analytics), EventBridge Scheduler,
  CloudFront + WAF, Secrets Manager. **No RDS Proxy and no NAT Gateway**; in-VPC Lambdas use
  IAM database authentication.
- **Contracts:** schema-first with **Zod** in `packages/contracts` (single source of truth —
  types inferred + runtime validation at boundaries). OpenAPI is derived on demand, only when
  an external/non-TS consumer appears (ADR-0001).

## Layout

```
apps/web/                  Vite + React SPA (cookieless, Hebrew/RTL; runtime config.json)
services/                    one dir per Lambda; slug = wanthat-{env}-{slug} (registry: infra/lib/config.ts)
  landing/                 public /p/ landing + attributed redirect (non-VPC → DynamoDB)
  member-catalog/          member catalog: products.resolve + recommendations + /config (non-VPC)
  member-wallet/           member wallet views (in-VPC → Aurora as wallet_reader, read-only)
  admin-console/           ALL admin actions + Dynamo views: moderation, config, claims, secrets (non-VPC)
  admin-ledger-view/       admin Aurora record-reads: money stats, activity, user wallet (in-VPC, ledger_reader)
  retailer-linkgen/        sync link mint against the retailer API (invoke-only from member-catalog)
  retailer-settlement/     scheduled order poll + attribution + claim settlement (15-min heartbeat)
  ledger-writer/           the ONLY money writer (in-VPC, ledger_writer; invoked by retailer-settlement)
  audit-writer/            hash-chained audit appends (in-VPC, audit_writer = EXECUTE audit_append only)
  otp-sender/              Cognito custom SMS sender: WhatsApp/SMS OTP, kill-switched (non-VPC)
  post-confirmation/       Cognito post-confirmation trigger: async welcome + audit + guest attribution
  notification-sender/     WhatsApp notification worker (async-invoked; retry ×2 → SQS DLQ)
  fx-rates/                FX rate cache updater (scheduled + admin-invoked, non-VPC → fx_rate)
  role-bootstrap/          deploy-time Postgres role creator (in-VPC, CDK Trigger, runs before migrator)
  db-migrator/             deploy-time SQL migration runner (in-VPC, CDK Trigger)
packages/
  contracts/  domain/  db/  dynamo/  aliexpress/  whatsapp/  config/
infra/                     AWS CDK app (stacks → see infra/lib/README.md)
adrs/                      architecture decision records
docs/                      consolidated overview: docs/AWS_Architecture.md
```

## Commands

> pnpm + Turborepo at the root; CDK runs inside `infra/`. Confirm against `package.json`
> scripts before relying on these.

```bash
pnpm install             # install all workspaces
pnpm build               # turbo build (respects the dependency graph)
pnpm typecheck
pnpm test                # turbo test; `pnpm --filter <pkg> test` for one workspace
pnpm lint                # biome — CI runs this; run it before every PR
pnpm synth               # cdk synth — cheapest correctness check, no AWS creds needed
pnpm diff                # cdk diff — ALWAYS run before deploy
pnpm deploy              # cdk deploy
```

- `cdk synth` is the cheapest feedback loop — prefer it before deploying.
- **Always `cdk diff` before `cdk deploy`.**

## Architecture (big picture)

Compute is sliced by real seams (ADR-0002, rewritten for the 2026-07 fifteen-function
topology): the member surface is the non-VPC `member-catalog` + in-VPC `member-wallet`
(read-only; the activity feed is composed client-side in the SPA); the admin surface is the
non-VPC `admin-console` (all actions + Dynamo views, audit-or-fail via `audit-writer`) +
in-VPC `admin-ledger-view` (Aurora record-reads); plus the public `landing`, the conversion
pipeline (`retailer-settlement` poll on a 15-min EventBridge heartbeat → in-VPC
`ledger-writer`), and the messaging pair (`otp-sender`, `notification-sender`). **There is no
auth service** — the browser calls Cognito directly (SignUp / InitiateAuth / WEB_AUTHN).
Money mutations flow only through `ledger-writer` into the append-only ledger + hash-chained
audit log, enforced by one Postgres role per function; the only lambda-to-lambda arrows are
the six of ADR-0002's invoke matrix.

**Datastore is polyglot (ADR-0003 + ADR-0006):** Aurora holds **money only** —
`wallet_entry` (append-only, keyed by the Cognito `sub`, ADR-0020) + `audit_log`
(`audit_append` is the only door in). **All customer PII lives in Cognito user attributes.**
Everything else — products, recommendations, guest attribution, poller state, unattributed
orders, runtime config, counters, FX cache, otp sink — lives in DynamoDB (nine tables,
non-PII).

**Network is NAT-free (ADR-0004):** the only things in the VPC are Aurora and the six
functions that touch it (`member-wallet`, `admin-ledger-view`, `ledger-writer`,
`audit-writer`, plus the deploy-time `role-bootstrap` + `db-migrator`) — they connect
directly via IAM database auth (no RDS Proxy) and reach DynamoDB via the free gateway
endpoint. Everything else runs **outside** the VPC; all retailer calls (AliExpress et al.,
IPv4-only) go through the non-VPC `retailer-linkgen` / `retailer-settlement` pair, which
holds the secret-scoped retailer credential; settlement invokes the in-VPC writer. The app is **cookieless** — the SPA
carries the Cognito JWT as a Bearer header; `landing` serves the OG landing page behind a
public HTTP API fronted by CloudFront `/p/*` (il-central-1 has no Lambda Function URLs) and
verifies member tokens offline via JWKS (ADR-0007). **Never reserve Lambda concurrency** —
the account limit is 10 until the quota is raised.

- **Stack boundaries / order:** `Network → Data → Identity → Api / Admin / EdgeServices /
  WhatsApp → Edge → Observability` (+ prod-only `Dns`) — see
  [`infra/lib/README.md`](./infra/lib/README.md) for what each owns and its ADR.
- **us-east-1 caveat:** the CloudFront ACM cert + CloudFront WAF web ACL must be created in
  `us-east-1` (control-plane only; traffic terminates at the edge). WhatsApp sends go through
  `eu-central-1` (End User Messaging Social is not in il-central-1). Everything else is
  `il-central-1`.
- **Key decisions (ADRs):** monorepo + Zod contracts (0001); fifteen-function topology,
  per-function Postgres roles, six-arrow invoke matrix + exposure rule (0002); polyglot
  Aurora + DynamoDB, no RDS Proxy (0003); NAT-free non-VPC chaining (0004); single-region
  active + cross-region backups (0005); Cognito-native auth + customer PII in Cognito (0006);
  redirect resolves in DynamoDB, relaxed-but-reachable p95 (0007); attribution via
  `custom_parameters`, no click-log lookup (0008); conversion via scheduled
  `order.listbyindex` poller, not a webhook; conversion stats are a derived ledger projection
  (0009); currency: hold settlement currency, ILS is a display estimate (0017); notifications
  via direct async invoke + DLQ, no outbox (0019); Cognito `sub` is the canonical user id
  (0020).
- **Lambda layout:** function source in `services/*`, infra in `infra/`, shared logic in
  `packages/*`; CDK `NodejsFunction` bundles each handler from the same tree. New `packages/*`
  imported by a Lambda must also be added to infra devDependencies (the filtered Deploy build
  breaks otherwise).
- **Environment strategy:** per-environment CDK stacks (dev/prod, one AWS account); no manual
  console changes. Merge to `main` deploys dev; prod promotes explicitly.
