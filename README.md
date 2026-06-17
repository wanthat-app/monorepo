# wanthat

Monorepo for Wanthat — an Israeli two-sided affiliate-cashback MVP on AWS (serverless,
CDK/TypeScript). Region: **il-central-1 (Tel Aviv)**.

## Layout

```
apps/web/                  Next.js/React SPA
services/
  app-api/                 identity + links + wallet Lambdalith
  admin-api/               admin Lambda (separate role/exposure)
  redirect/                public redirect service
  conversion-poller/       scheduled AliExpress order poller
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
an OpenAPI spec is derived on demand only when an external/non-TS consumer appears (ADR-0008).

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

Architecture decisions live in [`adrs/`](./adrs) (ADR-0001–0008). Read those before changing
the topology, datastore, attribution, or auth.
