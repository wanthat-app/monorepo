# ADR 0001 — Monorepo structure & contract strategy

- **Status:** Accepted
- **Date:** 2026-06-28

## Context

The system spans a web SPA, four backend compute units (an identity+links+wallet Lambdalith,
an admin API, a public redirect service, and a scheduled conversion poller), shared domain
logic, and AWS infrastructure. Two questions: how to lay the code out, and how to share
contracts/types across all of it. The codebase is TypeScript-only, owned by one small team.

## Decision

**Single monorepo** — pnpm workspaces + Turborepo, with infrastructure folded in:

```
wanthat/
├─ apps/web/                      # Next.js/React SPA
├─ services/
│  ├─ app-api/                    # identity+links+wallet Lambdalith
│  ├─ admin-api/                  # admin Lambda
│  ├─ redirect/                   # redirect service
│  └─ conversion-poller/          # scheduled poller (fetcher + writer)
├─ packages/
│  ├─ contracts/                  # Zod schemas: domain model, API I/O, custom_parameters
│  ├─ domain/                     # ledger math, commission split, attribution logic
│  ├─ aliexpress/                 # signed retailer client (link.generate, order.listbyindex)
│  └─ config/                     # env schema + typed config (services AND infra)
├─ infra/                         # AWS CDK app (stacks)
├─ adrs/                          # decision records
├─ pnpm-workspace.yaml · turbo.json · tsconfig.base.json
```

**Contracts are schema-first with Zod** in `packages/contracts`. Each contract is defined once
as a Zod schema; the static type is inferred (`z.infer`) and the same schema validates at every
trust boundary — untrusted API request bodies, external retailer payloads, the
`custom_parameters` attribution parse, and env/config at boot (fail-fast). No codegen step. An
**OpenAPI spec is derived on demand** (`zod-to-openapi`) only if a real external / non-TS
consumer appears (public API, native mobile, partner) — a generated artifact, source of truth
preserved.

## Alternatives considered

- **Repo-per-function** — rejected: shared types become a published, cross-repo-versioned
  package; CDK must pass artifacts across repos; coordination overhead unjustified for a
  four-function MVP. The isolation we need is provided at the deploy/IAM/stack layer, not the
  repo layer.
- **Separate infra repo** — rejected: CDK bundles each handler from the same tree, and infra
  shares config/resource-name contracts with the services; splitting forces cross-repo artifact
  passing for no governance gain a monorepo can't provide (CODEOWNERS on `infra/` + branch
  protection + a CI `cdk diff` gate).
- **Hand-written TS types for contracts** — rejected: types erase at runtime, leaving the
  money/external boundaries unvalidated.
- **Full spec-first IDL + codegen (OpenAPI/Protobuf/GraphQL)** — rejected: solves
  cross-language drift / external-consumer / governance problems we don't have (TS-only, single
  team, one monorepo); adds a codegen pipeline + drift risk for no current payoff.
- **tRPC as the primary API style** — rejected: RPC-only / TS-only fights the REST contracts
  and the public redirect + future-partner surfaces.

## Consequences

- Turborepo's affected-graph drives CI; CDK `NodejsFunction` bundles each service; CI deploys
  only changed stacks.
- One `packages/contracts` is the single source for types + runtime validation + (later)
  OpenAPI.
- Infra-change governance via CODEOWNERS on `infra/`, branch protection, and a CI job gating
  deploy behind `cdk diff`.

## Revisit if

Multiple teams own services independently; a component needs open-sourcing; compliance mandates
a physically separate infra repo; or a service needs a non-TS toolchain — then peel that one out
and/or introduce a spec as the source of truth for the cross-language surface.
