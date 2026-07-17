# ADR 0002 — Application compute topology & least-privilege model

- **Status:** Accepted
- **Date:** 2026-07-17 — **rewritten in place** for the 2026-07 lambda-topology refactor
  (pre-MVP consolidation convention, precedent ADR-0006; the original 2026-06-28 record's
  four-unit shape survives under *Alternatives considered*)
- **Related:** [ADR-0003](0003-datastore-aurora-and-dynamodb.md) (datastore),
  [ADR-0004](0004-network-topology-nat-free-egress.md) (VPC placement & egress),
  [ADR-0006](0006-cognito-native-auth-and-pii.md) (auth is browser-to-Cognito),
  [ADR-0009](0009-conversion-ingestion-poller.md) (conversion pipeline),
  [ADR-0019](0019-whatsapp-messaging-capability.md) (notification delivery)

## Context

Compute should be sliced by **real seams** — divergent workload, exposure, privilege, scaling,
and deploy cadence — not by the domain diagram. A single monolithic function gives one execution
role the union of every permission, which is wrong for the money-writing and admin surfaces; a
microservice-per-module split invites distributed-transaction complexity a small team can't
justify. The system grew slice by slice to that principle, and the 2026-07 refactor then
re-cut the accumulated functions along the seams that had actually emerged: trust boundary
(customer-parsed input vs the money path), privilege (one Postgres role per function, scoped to
exactly what it does), and exposure (user-facing HTTP vs privileged worker).

## Decision

### Fifteen functions, named from one registry

Every service Lambda has the physical name **`wanthat-{env}-{slug}`** and source directory
**`services/{slug}`**; the slug → construct-id/name mapping lives in **one registry,
`infra/lib/config.ts` (`SERVICES`)** — the single source of truth for naming, observability
order, and funnel membership. The naming grammar: **`{audience}-{concern}`** for request
surfaces (`member-*`, `admin-*`), a **`retailer-*`** tier for retailer egress, and
**`{object}-{action}`** for workers (`ledger-writer`, `audit-writer`, `notification-sender`,
`otp-sender`, `role-bootstrap`, `db-migrator`).

| Function | Trigger / exposure | VPC | DB privilege | Does |
|---|---|---|---|---|
| `landing` | public HTTP (`/p/*` via CloudFront) | no | — | OG landing + attributed resolve (DynamoDB reads only) |
| `member-catalog` | app HTTP API (customer JWT) | no | — | product resolve, recommendations CRUD, public `/config`; invokes `retailer-linkgen` |
| `member-wallet` | app HTTP API (customer JWT) | yes | `wallet_reader` (SELECT `wallet_entry`) | wallet balance + entries; read-only on money |
| `admin-console` | admin HTTP API (employee JWT) | no | — | ALL admin actions + DynamoDB views: moderation, config (sole writer), claims, ops stats, otp-sink, secret rotation, FX refresh |
| `admin-ledger-view` | admin HTTP API (employee JWT) | yes | `ledger_reader` (SELECT only) | money stats, audit activity feed, per-user wallet, `/admin/health` |
| `retailer-linkgen` | invoke-only (from `member-catalog`) | no | — | sync link mint against the retailer API; sole `product` writer |
| `retailer-settlement` | EventBridge schedule only (15 min) | no | — | order poll, attribution, claim settlement, conversion-total SETs; sole invoker of `ledger-writer` |
| `ledger-writer` | invoke-only (from `retailer-settlement`) | yes | `ledger_writer` (INSERT `wallet_entry` + `audit_append`) | **the only money writer**; pure Aurora, zero DynamoDB |
| `audit-writer` | invoke-only (sync from `admin-console`, async from `post-confirmation`) | yes | `audit_writer` (EXECUTE `audit_append` ONLY) | appends hash-chained audit events; payload shaping in TypeScript |
| `otp-sender` | Cognito custom-SMS-sender trigger | no | — | WhatsApp/SMS OTP delivery, kill-switched; parks codes in `otp_sink` |
| `post-confirmation` | Cognito post-confirmation trigger | no | — | guest attribution + counters; async-invokes `notification-sender` + `audit-writer`; never throws |
| `notification-sender` | async invoke from producers | no | — | WhatsApp notification delivery; retry ×2 → SQS DLQ; kill-switch returns success |
| `fx-rates` | EventBridge schedule (12 h) + sync invoke from `admin-console` | no | — | FX rate cache updater (sole `fx_rate` writer) |
| `role-bootstrap` | deploy-time CDK Trigger (before the migrator) | yes | `wanthat_master` via IAM token | idempotently creates/retires the service Postgres roles (R1/R2 as code) |
| `db-migrator` | deploy-time CDK Trigger | yes | `wanthat_migrator` (DDL) | plain-SQL migration runner |

### Three architectural patterns

1. **Transactional core, orchestrating edge.** In-VPC functions are **transactional** — they
   succeed entirely or fail entirely, and they never emit notifications or other side effects
   beyond their own datastore writes. The **non-VPC upstream orchestrator** emits
   notifications/events only *after* the transactional call has succeeded. (This is why
   `ledger-writer` is pure Aurora and `retailer-settlement` applies the DynamoDB projections
   and funnel events around it.)
2. **The exposure rule.** A function is **HTTP-exposed iff it serves user requests under
   gateway-verified JWT claims** (`landing`, `member-*`, `admin-*`); it is **invoke-chained iff
   it is a privileged worker** (`retailer-linkgen`, `ledger-writer`, `audit-writer`,
   `notification-sender`). Never front a worker chain with an HTTP-exposed Lambda passing
   claims onward: a compromised front Lambda could forge the claims it forwards, whereas
   invoke-only workers trust nothing but their IAM-authenticated caller and their own payload
   validation.
3. **The naming registry.** `infra/lib/config.ts` maps slug → directory / construct id /
   physical name / observability labels. Construct ids drive CloudFormation logical ids, so a
   rename is always its own deliberate PR, never a side effect.

### The invoke matrix

These are the **only six** Lambda-to-Lambda arrows in the system (everything else is an HTTP
API route, a Cognito trigger, or a schedule):

| Caller | Callee | Mode | Why |
|---|---|---|---|
| `member-catalog` | `retailer-linkgen` | sync | the user waits for the affiliate link |
| `retailer-settlement` | `ledger-writer` | sync | money append must succeed before projections are applied |
| `admin-console` | `audit-writer` | sync | moderation/config changes are **audit-or-fail** |
| `admin-console` | `fx-rates` | sync | manual on-demand FX refresh returns the run result |
| `post-confirmation` | `notification-sender` | async | welcome message; the trigger never blocks sign-up |
| `post-confirmation` | `audit-writer` | async | `user_registered` audit event; best-effort |

Invoke direction always exploits the ADR-0004 asymmetry: the non-VPC (or gateway-fronted) side
initiates, so no paid interface endpoints are needed.

### Least-privilege model

- Lambda IAM is **coarse per function** (one role = that function's needs), with narrowed
  resource-level grants where DynamoDB supports them: `admin-console`'s Recommendation access
  is read + `DeleteItem` + `UpdateItem` **conditioned to the `#counter` leading key** (no
  `PutItem` — the console can erase and count, never mint); `retailer-settlement`'s
  Recommendation write is `UpdateItem`-only (absolute conversion-total SETs).
- The **money guarantee is enforced at the database**, via one Postgres role per function:
  `wallet_reader` and `ledger_reader` are genuinely SELECT-only; `ledger_writer` is the sole
  INSERT path into `wallet_entry` (append-only — UPDATE/DELETE revoked everywhere);
  `audit_writer` holds EXECUTE on `audit_append` and **nothing else**. `audit_append`
  (SECURITY DEFINER) is the **only door into `audit_log`** for every role. Roles are created
  by the deploy-time `role-bootstrap` (as `wanthat_master` over IAM auth), granted by
  migrations run as `wanthat_migrator`.
- The **retailer credential** is readable only by the two `retailer-*` functions;
  `admin-console` can rotate it write-only (`PutSecretValue`) but never read it back.
  Splitting `retailer-linkgen` from `retailer-settlement` means **customer-parsed input never
  shares an execution role with the money-path invoke**: linkgen parses member-pasted URLs but
  cannot reach `ledger-writer`; settlement invokes the money writer but takes input only from
  the schedule and the retailer API.

## Alternatives considered

- **The previous four-unit topology** (this ADR's original decision: an app Lambdalith, an
  admin function, landing, and a retailer-proxy + poller-writer pair; later grown to twelve
  functions by ADR-0006/0019 slices). Worked, but accreted mismatched seams: one
  `retailer-proxy` held the secret for both the customer-input path and the money-invoke path;
  the admin split (`admin-api` / `admin-credentials`) was cut by VPC placement rather than by
  actions-vs-record-reads; `app-core` needed Recommendation access only to merge an activity
  feed the SPA can compose client-side; and the Postgres roles (`app_rw`, `app_ro`,
  `poller_writer`) were broader than any single function needed.
- **Single modular-monolith function** — one IAM role = union of all permissions; can't give
  the admin/money surface its own privilege or exposure.
- **Microservice-per-domain-module on the shared DB** — distributed transactions and ops
  overhead for no isolation we actually need. The current cut is by *seam*, not by module.
- **HTTP + JWT all the way down** (workers behind authorizers instead of invoke-only) — a
  fronting Lambda can forge the claims it forwards, and every worker would gain a public
  attack surface. Rejected by the exposure rule.
- **Always-on Fargate** — pays for idle while the scale-to-zero DB (ADR-0003) is paused.
- **RDS Proxy for connection pooling** — unneeded once the redirect resolves in DynamoDB; the
  remaining low-concurrency callers connect directly (ADR-0003).

## Consequences

- Fifteen deploy units whose names state their trust tier; the registry makes the naming
  mechanical and the observability wiring (alarms, dashboards, funnel subscriptions) derive
  from it.
- The integrity property — no user-facing surface can mutate money — holds via DB grants
  (`*_reader` roles are SELECT-only) + the invoke-only `ledger-writer`, over direct IAM-auth
  connections, with no standing proxy cost.
- The conversion-stat shown on a recommendation is a **derived projection of the ledger**
  (ADR-0009): `ledger-writer` returns absolute totals, `retailer-settlement` applies them as
  idempotent SETs — the ledger stays the source of truth.
- Two more cold-start surfaces than strictly necessary (the split admin + retailer pairs) —
  accepted; all functions are 256 MB arm64 with small bundles.
- Lambda-vs-container is settled as Lambda.
