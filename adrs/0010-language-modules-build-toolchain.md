# ADR 0010 — Language, modules & build toolchain

- **Status:** Accepted
- **Date:** 2026-06-28
- **Revised:** 2026-06-29 — Node 20 → **Node 24**. Node 20 reached end-of-life (Apr 2026) and is
  deprecated on AWS Lambda (`nodejs20.x`); Node 24 "Krypton" is the current LTS, supported on
  `nodejs24.x` until Apr 2028.
- **Related:** [ADR-0001](0001-monorepo-structure-and-contracts.md) (monorepo)

## Context

Every package is TypeScript and everything ships through a **bundler** — esbuild for the Lambdas
(via CDK `NodejsFunction`), Vite for the web app (ADR-0016). We need one language baseline: module
system, resolution, target, and how handlers are bundled.

## Decision

- **TypeScript strict**, `target: ES2022`, **Node 24** (Krypton LTS) runtime.
- **ESM everywhere.** `module: "ESNext"`, `moduleResolution: "bundler"` — bundler resolution lets
  us write clean imports with **no `.js`-extension burden**, which is safe because everything is
  bundled. One `tsconfig.base.json`; per-package tsconfigs extend it.
- **Lambda bundling:** esbuild via `NodejsFunction` — `format: ESM`, `target: node24`, minify +
  source maps, `@aws-sdk/*` externalised (provided by the runtime).
- **CDK app run with `tsx`** (not ts-node) to execute ESM TypeScript without config friction.

## Alternatives considered

- **CommonJS** — lower historical tooling friction, but against the grain of the ESM-first stack
  (Hono / Vitest / Zod); the only real ESM pain (CDK entrypoint) is removed by `tsx`.
- **`moduleResolution: "NodeNext"`** — forces explicit `.js` extensions on relative imports; an
  unnecessary tax since we bundle. `bundler` is cleaner.
- **ts-node for the CDK app** — flaky under ESM; `tsx` is the modern replacement.

## Consequences

- No `__dirname`/`require` — use `import.meta.url` where needed.
- Each handler is bundled per-function from the shared tree; the AWS SDK is not bundled.
- All new packages inherit ESM + strict + bundler resolution from the base config.
