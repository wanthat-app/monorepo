# ADR 0012 — Data access & migrations: Kysely + plain-SQL migrations

- **Status:** Accepted
- **Date:** 2026-06-28
- **Related:** [ADR-0003](0003-datastore-aurora-and-dynamodb.md) (Aurora, IAM auth, no RDS Proxy), [ADR-0002](0002-app-compute-topology.md) (per-function Postgres roles)

## Context

Aurora PostgreSQL with **direct connections via IAM database auth** (no RDS Proxy — ADR-0003): a
fresh ~15-min token is the password, TLS required. Handlers are **esbuild-bundled** (no native
binaries / query-engine sidecars). The append-only ledger + hash-chained audit + reconciliation
queries demand **explicit, auditable SQL**, and the per-function **roles/GRANTs** (ADR-0002) are
DDL that must live in migrations.

## Decision

- **Kysely** — a type-safe SQL query builder (not an ORM) over **`node-postgres` (`pg`)**, in
  `packages/db`. SQL stays visible and reviewable (ledger INSERTs, `SUM()` balances, reconciliation
  windows, hash-chain) while results are fully typed. Pure TS → bundles cleanly.
- **Connection:** a `pg.Pool` whose `password` is an async provider calling
  `@aws-sdk/rds-signer.getAuthToken()` (cached ~14 min), `ssl` required; the per-function Postgres
  user is selected by role. Kysely's `PostgresDialect` wraps the pool.
- **Migrations:** the **Kysely migrator** running **plain-SQL** files in `packages/db/migrations`
  (tables, append-only constraints, hash-chain, `CREATE ROLE` + `GRANT`/`REVOKE`). SQL is the
  hand-authored source of truth.
- `packages/db` exports the typed `Database` interface + repositories (ledger, audit-chain,
  customer, links).

## Alternatives considered

- **Drizzle ORM** — closest call (schema-in-TS, generated migrations, good DX), but for a ledger we
  want the **SQL migration** to be the reviewed source of truth, and roles/GRANTs/triggers aren't
  expressible in its schema anyway → Kysely's SQL transparency wins.
- **Prisma** — a Rust query-engine binary that doesn't bundle into a Lambda cleanly and is awkward
  with rotating IAM tokens. Rejected.
- **Raw `pg`** — maximal control but loses compile-time result typing; Kysely gives the transparency
  with types.

## Consequences

- Money DDL/DML is explicit, reviewable SQL; balances re-derivable; GRANTs enforce the money
  guarantee (ADR-0002) at the engine.
- The IAM-token pool must refresh before expiry — **verify** token caching + TLS at provisioning.
