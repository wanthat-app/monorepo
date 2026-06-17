# ADR 0008 — Repository structure (monorepo) & contract strategy

- **Status:** Accepted
- **Date:** 2026-06-18
- **Context refs:** Solution Design Document D2, §12; ADR-0005 (compute topology)
- **Related:** [ADR-0005](0005-app-compute-topology.md) (the services this repo houses)

## Context

Two questions: how to lay out the code repositories, and how to share contracts/types
across web + the four compute units (identity+links+wallet Lambdalith, admin, redirect,
poller). D2 already leans "monorepo with shared types." Options ranged from a single
monorepo to repo-per-function, and for contracts from hand-written TS types to full
spec-first IDL + codegen (OpenAPI/Protobuf/GraphQL).

## Decision

### Repository: single monorepo

One repo (pnpm workspaces + Turborepo), infra folded in. Repo-per-function is rejected — it
fights D2 (shared types become a published, cross-repo-versioned package), forces cross-repo
CDK artifact passing, and adds coordination overhead unjustified for a 4-function MVP /
small team. Isolation we need is already provided at the deploy/IAM/stack layer (ADR-0005),
not the repo layer. Infra lives in the monorepo (CDK bundles handlers from the same tree;
infra + app share config/resource-name contracts); infra-change governance via CODEOWNERS on
`infra/` + branch protection + a CI job gating deploy behind `cdk diff`.

Layout:

```
wanthat/
├─ apps/web/                      # Next.js/React SPA
├─ services/
│  ├─ app-api/                    # identity+links+wallet Lambdalith
│  ├─ admin-api/                  # admin Lambda
│  ├─ redirect/                   # redirect service
│  └─ conversion-poller/          # scheduled poller
├─ packages/
│  ├─ contracts/                  # Zod schemas: domain model, API + custom_parameters + disclosure
│  ├─ domain/                     # ledger math, commission split, attribution logic
│  ├─ aliexpress/                 # signed client (link.generate, order.listbyindex)
│  └─ config/                     # env schema + typed config (services AND infra)
├─ infra/                         # AWS CDK app (stacks)
├─ adrs/                          # decision records (repo root)
├─ pnpm-workspace.yaml · turbo.json · tsconfig.base.json
```

### Contracts: schema-first (Zod), spec derived on demand

Source of truth = **Zod schemas** in `packages/contracts`. From one definition we get the
**runtime validator** and the **inferred TS type** (`z.infer`) — no codegen step. Validators
run at every trust boundary: untrusted API request bodies; external AliExpress payloads
(`order.listbyindex`, `link.generate`); the `custom_parameters` attribution parse; env/config
at boot (SDD §12, fail-fast).

This is chosen over:
- **hand-written TS types** — give types but no runtime validation (types erase at runtime);
  this system's boundaries (money, external payloads) need validation.
- **full spec-first IDL + codegen** — solves cross-language drift / external-consumer /
  governance problems we don't have yet (TS-only, single-team, one monorepo where the
  monorepo already removes cross-repo versioning). Adds a codegen pipeline + drift risk for
  no current payoff.

**Spec is deferred, not forbidden:** when a real external / non-TS consumer appears (public
API, native mobile, partner), **emit OpenAPI _from_ the Zod schemas** (`zod-to-openapi` /
`ts-rest`) — a derived artifact, single source of truth preserved, no drift.

Internal web ↔ app-api boundary: REST handlers validated by the shared Zod schemas (or
`ts-rest` for a typed REST contract). `tRPC` rejected as the primary style — RPC-only /
TS-only would fight the SDD's REST contracts (§7.4, §8.4) and the public redirect/webhook +
future-partner surfaces.

## Consequences

- `wanthat-infra` becomes the monorepo (`wanthat`); current infra content moves under
  `infra/`; ADRs graduate to the repo root.
- Tooling: pnpm workspaces + Turborepo (affected-graph CI); CDK `NodejsFunction` bundles each
  service. CI deploys only changed stacks.
- One `packages/contracts` (Zod) is the single source for types + validation + (later) OpenAPI.

## Revisit if

Multiple teams own services independently; a component needs open-sourcing; compliance
mandates a physically separate infra repo; or a service needs a non-TS toolchain — then peel
that one out and/or introduce a spec as the source of truth for the cross-language surface.
