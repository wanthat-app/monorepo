# ADR 0013 — Testing strategy: Vitest + CDK assertions + Testcontainers

- **Status:** Accepted
- **Date:** 2026-06-28
- **Related:** [ADR-0010](0010-language-modules-build-toolchain.md) (ESM), [ADR-0012](0012-data-access-and-migrations.md) (DB layer)

## Context

Three test layers are needed: **unit** (commission split, hash-chain, attribution parsing, HMAC
signing), **infra** (the CDK templates synth and assert correctly), and **integration** (the DB
repositories run against a real Postgres with migrations applied).

## Decision

- **Vitest** as the single runner across all TS packages — ESM-native (ADR-0010), fast, no
  transform setup.
- **`aws-cdk-lib/assertions`** for infra: synth each stack and assert on the template
  (resources, properties, IAM). `cdk-nag` can be layered later for security rules.
- **Testcontainers (PostgreSQL)** for `packages/db` and money-critical domain logic: spin a real
  Postgres, apply the plain-SQL migrations, and verify the ledger / hash-chain / append-only
  behaviour against the actual engine.

## Alternatives considered

- **Jest** — heavier ESM story (ts-jest / transforms) and slower; Vitest is the ESM-native fit.
- **LocalStack for everything** — heavier than needed for the DB layer; Testcontainers-pg is
  lighter and exact. LocalStack can be added later for AWS-integration e2e.

## Consequences

- `turbo test` runs unit tests everywhere; integration tests require Docker (Testcontainers) and
  run in CI on a Docker-enabled runner.
- The money-critical logic gets real-database coverage, not mocks.
