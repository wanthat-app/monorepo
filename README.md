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
