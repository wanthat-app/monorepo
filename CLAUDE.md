# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

`wanthat` (repo: `wanthat-mono`) is the monorepo for **Wanthat** — an Israeli two-sided
affiliate-cashback MVP on AWS, serverless-first, **AWS CDK + TypeScript**, region
**il-central-1 (Tel Aviv)**. Architecture decisions are recorded in [`adrs/`](./adrs)
(ADR-0001–0009; see [`adrs/README.md`](./adrs/README.md)) — **read those before changing
structure, compute topology, datastore, network, attribution, or auth.** ADRs are locked:
change a decision by adding a new superseding ADR, not by editing an accepted one in place.

## Stack & tooling

- **Monorepo:** pnpm workspaces + Turborepo. TypeScript everywhere (Node 20).
- **IaC:** AWS CDK v2 (`aws-cdk-lib`) in `infra/`.
- **Cloud (serverless-first):** Lambda, API Gateway HTTP API, Cognito (SMS OTP + passkeys),
  **Aurora Serverless v2** (PostgreSQL, scale-to-zero) for PII + ledger, **DynamoDB** (on-demand)
  for the redirect projection + guest attribution, Kinesis Firehose → S3 + Athena, EventBridge
  Scheduler, CloudFront + WAF, Secrets Manager. **No RDS Proxy and no NAT Gateway**; Lambdas use
  IAM database authentication.
- **Contracts:** schema-first with **Zod** in `packages/contracts` (single source of truth —
  types inferred + runtime validation at boundaries). OpenAPI is derived on demand, only when
  an external/non-TS consumer appears (ADR-0001).

## Layout

```
apps/web/                  Next.js/React SPA (placeholder)
services/
  app-api/                 identity + links + wallet Lambdalith (in-VPC)
  admin-api/               admin Lambda (in-VPC, separate role/exposure)
  redirect/                public redirect service (non-VPC → DynamoDB)
  conversion-poller/       scheduled poller (non-VPC fetcher + in-VPC writer)
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

Four compute units, sliced by real seams (ADR-0002): the `app-api` Lambdalith
(identity+links+wallet), a separate `admin-api`, the public `redirect` service, and the
scheduled `conversion-poller`. Money mutations flow only through the poller-writer into the
append-only ledger + hash-chained audit log.

**Datastore is polyglot (ADR-0003):** Aurora holds all PII + the money ledger + audit log +
referral graph + authoritative links; DynamoDB holds the two non-PII hot-path lookups
(`short_id → affiliate_url` and `guest_attribution`).

**Network is NAT-free (ADR-0004):** the only things in the VPC are Aurora and the functions that
touch it (Lambdalith, admin, poller-writer) — they connect directly via IAM database auth (no
RDS Proxy), capped by reserved concurrency. Everything else runs **outside** the VPC: `redirect`
reads DynamoDB; retailer calls (AliExpress et al., which are IPv4-only) go through thin non-VPC
**fetcher** functions that hold the secret-scoped retailer credential and invoke in-VPC
**writer** functions.

- **Stack boundaries / order:** `Network → Data → Identity → Api / Admin / EdgeServices →
  Edge → Observability` — see [`infra/lib/README.md`](./infra/lib/README.md) for what each
  owns and its ADR.
- **us-east-1 caveat:** the CloudFront ACM cert + CloudFront WAF web ACL must be created in
  `us-east-1` (control-plane only; traffic terminates at the edge). Everything else is
  `il-central-1`.
- **Key decisions (ADRs):** monorepo + Zod contracts (0001); four-unit compute topology +
  DB-grant least-privilege (0002); polyglot Aurora + DynamoDB, no RDS Proxy (0003); NAT-free
  non-VPC chaining (0004); single-region active + cross-region backups (0005); SMS OTP +
  passkeys + SMS kill switch (0006); redirect resolves in DynamoDB, relaxed-but-reachable p95
  (0007); attribution via `custom_parameters`, no click-log lookup (0008); conversion via
  scheduled `order.listbyindex` poller, not a webhook (0009).
- **Lambda layout:** function source in `services/*`, infra in `infra/`, shared logic in
  `packages/*`; CDK `NodejsFunction` bundles each handler from the same tree.
- **Environment strategy:** per-environment CDK stacks (dev/staging/prod); no manual console
  changes.
