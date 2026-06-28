# ADR 0015 — CI/CD & environment promotion: GitHub Actions + OIDC

- **Status:** Accepted
- **Date:** 2026-06-28
- **Related:** [ADR-0001](0001-monorepo-structure-and-contracts.md) (cdk-diff governance), [ADR-0005](0005-disaster-recovery-posture.md) (per-env stacks)

## Context

We need automated quality gates and safe deploys to per-environment stacks (dev/staging/prod)
without long-lived AWS keys, with infra changes gated behind `cdk diff` (ADR-0001 governance).

## Decision

- **GitHub Actions.** PR CI: `pnpm install` → **Biome** (`biome ci`) → `typecheck` → **Vitest** →
  `build` → **`cdk synth`**, scoped by the **Turborepo affected-graph** so only touched workspaces
  run.
- **Deploy via OIDC** federation to per-environment IAM roles — **no static access keys**. `main`
  auto-deploys **dev**; promotion to **staging** then **prod** runs behind a **manual approval**
  (GitHub Environments). `cdk diff` is required/posted before `cdk deploy`. CODEOWNERS on `infra/`.

## Alternatives considered

- **Static IAM access keys in repo secrets** — long-lived credential risk; rejected in favour of
  the AWS-recommended keyless OIDC pattern.
- **Deploy everything on every push** — rejected; the affected-graph + a manual prod gate keep
  blast radius and cost down.

## Consequences

- Three GitHub Environments (dev/staging/prod), each with a scoped OIDC deploy role; prod requires
  approval.
- Only changed stacks deploy; `cdk diff` is the human checkpoint before any prod change.
