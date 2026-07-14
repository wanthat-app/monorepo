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
  attribution, runtime config/kill switches, counters, FX cache, notification outbox),
  Kinesis Firehose → S3 + Glue/Athena (funnel analytics), EventBridge Scheduler,
  CloudFront + WAF, Secrets Manager. **No RDS Proxy and no NAT Gateway**; in-VPC Lambdas use
  IAM database authentication.
- **Contracts:** schema-first with **Zod** in `packages/contracts` (single source of truth —
  types inferred + runtime validation at boundaries). OpenAPI is derived on demand, only when
  an external/non-TS consumer appears (ADR-0001).

## Layout

```
apps/web/                  Vite + React SPA (cookieless, Hebrew/RTL; runtime config.json)
services/
  app-links/               member catalog: products.resolve + recommendations (non-VPC)
  app-core/                member wallet + activity (in-VPC → Aurora as app_rw)
  admin-api/               admin stats/config/orders (in-VPC → Aurora as app_ro)
  admin-credentials/       admin Cognito moderation + retailer-secret rotation (non-VPC)
  landing/                 public /p/ landing + attributed redirect (non-VPC → DynamoDB)
  retailer-proxy/          sole retailer egress + order-poll fetcher (non-VPC, sole secret reader)
  conversion-poller/       in-VPC writer — the ONLY money writer (invoked by retailer-proxy)
  fx-rates/                scheduled FX rate cache updater (non-VPC → fx_rate)
  message-sender/          Cognito custom SMS sender: WhatsApp/SMS OTP, kill-switched (non-VPC)
  post-confirmation/       Cognito post-confirmation trigger: welcome outbox + guest attribution
  whatsapp-dispatcher/     notification_outbox stream consumer (non-VPC, DLQ)
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

Compute is sliced by real seams (ADR-0002, reshaped by ADR-0006): the member surface is the
non-VPC `app-links` (catalog + recommendations) + in-VPC `app-core` (wallet); the admin
surface is the in-VPC `admin-api` (SQL stats + config) + non-VPC `admin-credentials` (Cognito
moderation, secret writes); plus the public `landing`, the conversion pipeline
(`retailer-proxy` fetcher → in-VPC `conversion-poller` writer, on a 15-min EventBridge
heartbeat), and the messaging pair (`message-sender`, `whatsapp-dispatcher`). **There is no
auth service** — the browser calls Cognito directly (SignUp / InitiateAuth / WEB_AUTHN).
Money mutations flow only through the poller-writer into the append-only ledger +
hash-chained audit log, enforced by per-function Postgres roles.

**Datastore is polyglot (ADR-0003 + ADR-0006):** Aurora holds **money only** —
`wallet_entry` (append-only, keyed by the Cognito `sub`, ADR-0020) + `audit_log`. **All
customer PII lives in Cognito user attributes.** Everything else — products,
recommendations, guest attribution, runtime config, counters, FX cache, outbox — lives in
DynamoDB (non-PII).

**Network is NAT-free (ADR-0004):** the only things in the VPC are Aurora and the four
functions that touch it (`app-core`, `admin-api`, `conversion-poller`, `db-migrator`) — they
connect directly via IAM database auth (no RDS Proxy) and reach DynamoDB via the free gateway
endpoint. Everything else runs **outside** the VPC; all retailer calls (AliExpress et al.,
IPv4-only) go through the single non-VPC `retailer-proxy`, which holds the secret-scoped
retailer credential and invokes the in-VPC writer. The app is **cookieless** — the SPA
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
- **Key decisions (ADRs):** monorepo + Zod contracts (0001); compute topology + DB-grant
  least-privilege (0002); polyglot Aurora + DynamoDB, no RDS Proxy (0003); NAT-free non-VPC
  chaining (0004); single-region active + cross-region backups (0005); Cognito-native auth +
  customer PII in Cognito (0006); redirect resolves in DynamoDB, relaxed-but-reachable p95
  (0007); attribution via `custom_parameters`, no click-log lookup (0008); conversion via
  scheduled `order.listbyindex` poller, not a webhook (0009); currency: hold settlement
  currency, ILS is a display estimate (0017); Cognito `sub` is the canonical user id (0020).
- **Lambda layout:** function source in `services/*`, infra in `infra/`, shared logic in
  `packages/*`; CDK `NodejsFunction` bundles each handler from the same tree. New `packages/*`
  imported by a Lambda must also be added to infra devDependencies (the filtered Deploy build
  breaks otherwise).
- **Environment strategy:** per-environment CDK stacks (dev/prod, one AWS account); no manual
  console changes. Merge to `main` deploys dev; prod promotes explicitly.
