# ADR 0014 — Dev tooling: Biome (lint + format)

- **Status:** Accepted
- **Date:** 2026-06-28
- **Related:** [ADR-0010](0010-language-modules-build-toolchain.md) (TS/ESM baseline)

## Context

One greenfield ESM monorepo needs consistent linting and formatting without a sprawl of plugins
and two competing tools. A money system also wants the async-safety net that catches un-awaited
writes (the dropped-write footgun in ADR-0007).

## Decision

**Biome** for both linting and formatting — a single fast tool with one root `biome.json`. It runs
in the editor, in CI (`biome ci`), and (optionally later) in a pre-commit hook. Enable the
recommended rules plus the type-aware **`noFloatingPromises`** (covers the un-awaited-write risk).

## Alternatives considered

- **ESLint + typescript-eslint + Prettier** — broader, more battle-tested type-aware rules
  (`no-misused-promises`, `await-thenable`, …) plus the security/import plugin ecosystem, but
  slower, two tools, and more config. Now that Biome v2 covers `noFloatingPromises`, the marginal
  extra rules don't outweigh Biome's speed and single-config simplicity for a small team.

## Consequences

- `biome ci` gates CI; formatting drift fails the build.
- Revisit if a specific type-aware or security rule we need is missing from Biome — at which point
  ESLint can be layered for that ruleset only.
