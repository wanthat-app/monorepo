# wanthat

Monorepo for Wanthat — an Israeli two-sided affiliate-cashback MVP on AWS (serverless,
CDK/TypeScript). Region: **il-central-1 (Tel Aviv)**.

## Layout

```
apps/web/                  Next.js/React SPA
services/
  app-api/                 identity + links + wallet Lambdalith
  admin-api/               admin Lambda (separate role/exposure)
  landing/                 public landing service (non-VPC → DynamoDB)
  conversion-poller/       scheduled poll writer (in-VPC)
  retailer-proxy/          sole non-VPC egress to retailer APIs (link.generate, order.listbyindex)
packages/
  contracts/               Zod schemas — single source of truth (types + validation)
  domain/                  ledger math, commission split, attribution logic
  aliexpress/              signed AliExpress client (api-sg, HMAC-SHA256)
  config/                  env schema + typed config (fail-fast)
infra/                     AWS CDK app (stacks)
adrs/                      architecture decision records
```

## Tooling

pnpm workspaces + Turborepo. TypeScript everywhere. Contracts are schema-first (Zod);
an OpenAPI spec is derived on demand only when an external/non-TS consumer appears (ADR-0001).

### Node version

This repo standardizes on **Node 24.x** (ADR-0010; it's the AWS Lambda runtime and the esbuild
bundle target). Local development must use Node 24:

- [`.nvmrc`](.nvmrc) pins it — run `nvm use` (or `fnm use`) before working in the repo.
- `engines.node` is `24.x` and [`.npmrc`](.npmrc) sets `engine-strict=true`, so `pnpm install`
  **fails fast** on the wrong major.
- CI reads the same `.nvmrc` (`setup-node` with `node-version-file`), so local and CI never drift.

Node 24 "Krypton" is the current LTS; AWS Lambda supports `nodejs24.x` to Apr 2028. (We moved off
Node 20, which reached end-of-life in Apr 2026 and is deprecated on Lambda.) A future bump to the
next even LTS changes `LAMBDA_RUNTIME` (`infra/lib/config.ts`), `.nvmrc`, and `engines` together.

## Commands

```bash
pnpm install
pnpm build           # turbo build (respects the dependency graph)
pnpm typecheck
pnpm test
pnpm synth           # cdk synth (infra)
pnpm diff            # cdk diff  (run before deploy)
pnpm deploy          # cdk deploy
```

## Decisions

Architecture decisions live in [`adrs/`](./adrs) (ADR-0001–0009; see the
[index](./adrs/README.md)). Read those before changing structure, compute, datastore, network,
attribution, or auth. The data layer is polyglot — Aurora (PII + ledger) + DynamoDB (redirect
path) — with **no RDS Proxy** and a **NAT-free** network (ADR-0003 / ADR-0004). ADRs are locked;
revise by adding a superseding ADR.
