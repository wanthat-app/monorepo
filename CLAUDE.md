# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

`wanthat` (repo: `wanthat-mono`) is the monorepo for **Wanthat** — an Israeli two-sided
affiliate-cashback MVP on AWS, serverless-first, **AWS CDK + TypeScript**, region
**il-central-1 (Tel Aviv)**. Architecture decisions are recorded in [`adrs/`](./adrs)
(ADR-0001–0008) — **read those before changing topology, datastore, attribution, or auth.**

## Stack & tooling

- **Monorepo:** pnpm workspaces + Turborepo. TypeScript everywhere (Node 20).
- **IaC:** AWS CDK v2 (`aws-cdk-lib`) in `infra/`.
- **Cloud (serverless-first):** Lambda, API Gateway HTTP API, Cognito, Aurora Serverless v2
  (PostgreSQL, scale-to-zero) + RDS Proxy, Kinesis Firehose → S3 + Athena, EventBridge
  Scheduler, CloudFront + WAF, Secrets Manager.
- **Contracts:** schema-first with **Zod** in `packages/contracts` (single source of truth —
  types inferred + runtime validation at boundaries). OpenAPI is derived on demand, only when
  an external/non-TS consumer appears (ADR-0008).

## Layout

```
apps/web/                  Next.js/React SPA (placeholder)
services/
  app-api/                 identity + links + wallet Lambdalith
  admin-api/               admin Lambda (separate role/exposure)
  redirect/                public redirect service
  conversion-poller/       scheduled AliExpress order poller
packages/
  contracts/  domain/  aliexpress/  config/
infra/                     AWS CDK app (stacks → see infra/lib/README.md)
adrs/                      architecture decision records
```

## Commands

> pnpm + Turborepo at the root; CDK runs inside `infra/`. Confirm against `package.json`
> scripts before relying on these.

```bash
pnpm install             # install all workspaces
pnpm build               # turbo build (respects the dependency graph)
pnpm typecheck
pnpm test                # turbo test; `pnpm --filter <pkg> test` for one workspace
pnpm synth               # cdk synth — cheapest correctness check, no AWS creds needed
pnpm diff                # cdk diff — ALWAYS run before deploy
pnpm deploy              # cdk deploy
```

- `cdk synth` is the cheapest feedback loop — prefer it before deploying.
- **Always `cdk diff` before `cdk deploy`.**

## Architecture (big picture)

Four compute units, sliced by real seams (ADR-0005): the `app-api` Lambdalith
(identity+links+wallet), a separate `admin-api`, the public `redirect` service, and the
scheduled `conversion-poller`. All run **Lambda-in-VPC + RDS Proxy** against Aurora
Serverless v2 (ADR-0006). Money mutations flow only through the poller into the append-only
ledger + hash-chained audit log.

- **Stack boundaries / order:** `Network → Data → Identity → Api / Admin / EdgeServices →
  Edge → Observability` — see [`infra/lib/README.md`](./infra/lib/README.md) for what each
  owns and its ADR.
- **us-east-1 caveat:** the CloudFront ACM cert + CloudFront WAF web ACL must be created in
  `us-east-1` (control-plane only; traffic terminates at the edge). Everything else is
  `il-central-1`.
- **Key decisions:** relaxed redirect latency (0001); conversion via scheduled
  `order.listbyindex` poller, not a webhook (0002); attribution via `custom_parameters`
  (`customer_id` / `guestId`), no click-log lookup (0003); SMS-only OTP + passkeys, WhatsApp
  deferred, SMS kill switch (0004); Aurora Serverless v2 scale-to-zero (0006); single-region
  active + cross-region backups, failover deferred (0007).
- **Lambda layout:** function source in `services/*`, infra in `infra/`, shared logic in
  `packages/*`; CDK `NodejsFunction` bundles each handler from the same tree.
- **Environment strategy:** per-environment CDK stacks (dev/staging/prod); no manual console
  changes.
