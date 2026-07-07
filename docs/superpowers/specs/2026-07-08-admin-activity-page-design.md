# Admin Activity page — design

**Date:** 2026-07-08
**Status:** approved design, spec under review
**Slice:** one deployable use-case slice (migration + contracts + admin-api + SPA + infra), per the PR-slice convention.
**Mock:** https://claude.ai/code/artifact/873094da-ed18-470c-b8c7-bd96c263c057 (approved)

## User story

An admin opens the new **Activity** entry in the sidebar (Overview group) and sees one paged
feed, newest first: user registrations, user deletions, and — in dev only — the live OTP codes
from the dev sink, so codes are grabbed from the admin panel instead of the AWS CLI. Deletions
and registrations are durable, tamper-evident audit-log entries; the feed is where any future
audited admin action will surface automatically.

## Decisions (approved during brainstorm)

1. **`audit_log` becomes the single Aurora source of the feed.** Registration is written to the
   audit log at register time (it is the beginning of the customer's wallet — a money-relevant
   genesis event), and existing customers are **backfilled** one audit row each. No
   `UNION customer` on read.
2. **Deletion joins the audit log** atomically with the delete, carrying the deleted user's
   identity (name/phone/email) and the acting admin — the identity survives the row.
3. **The hash chain gets its first implementation.** `prev_hash`/`entry_hash` have been inert
   since 0001; this slice adds the single append path that computes them.
4. **OTP activity is dev-only and read from the existing `dev_otp_sink`** — no new writers, no
   OTP persistence in prod (the sink table does not exist in prod; fail-closed).

## Migration `0005_audit_append.sql`

### `audit_append(p_payload jsonb, p_at timestamptz DEFAULT now()) RETURNS bigint`

The **only** append path to `audit_log`. `SECURITY DEFINER` (owner `wanthat_migrator`),
`SET search_path = public, pg_temp`:

- `pg_advisory_xact_lock(hashtext('audit_log'))` — serialises appends so the chain never forks
  under concurrent writers (registration volume is tiny; the lock is uncontended in practice).
- Reads the last row's `entry_hash` (by `id DESC`) as `prev_hash` (NULL for the first row).
- `entry_hash = encode(digest(coalesce(prev_hash,'') || '|' || p_payload::text || '|' || p_at::text, 'sha256'), 'hex')`
  (pgcrypto is already enabled in 0001).
- Inserts `(prev_hash, entry_hash, payload, created_at := p_at)` and returns the new `id`.

Grants: `REVOKE ALL ... FROM PUBLIC`; `GRANT EXECUTE TO app_rw` (the registration writer).
`app_ro` does **not** get it — admin deletions go through `admin_delete_customer`, which calls
it in definer context. (`poller_writer` keeps its direct INSERT grant for now; moving the
poller onto `audit_append` lands with the poller slice.)

### `admin_delete_customer(p_customer_id uuid, p_actor text)`

New two-arg version of 0004's function, same guard/outcome contract
(`deleted | not_found | has_wallet_history`, returns phone), plus: on successful delete it
captures the row (`RETURNING`) and calls
`audit_append('{type: "user_deleted", customerId, phone, firstName, lastName, email, actor}')`
in the same transaction. `GRANT EXECUTE TO app_ro`.

The 0004 one-arg function is **left in place untouched** so the previous admin-api code keeps
working during the deploy window (DataStack migrates before AdminStack updates the Lambda);
a later cleanup migration drops it.

### Backfill

A `DO` block iterates existing customers ordered by `created_at, id` and calls
`audit_append('{type: "user_registered", customerId, phone, firstName, lastName, email, backfilled: true}', c.created_at)` —
so pre-existing users appear in the feed at their true registration time, and the chain is
seeded in deterministic order. (`created_at` carries feed ordering; chain integrity is by `id`
order, so historical timestamps don't break it.)

## Registration writes an audit row (`packages/db` + app-core)

`insertCustomer` (`packages/db/src/customer.ts`) becomes transactional:
`INSERT ... ON CONFLICT (cognito_sub) DO NOTHING RETURNING id`; **iff a row was inserted**,
`SELECT audit_append('{type: "user_registered", ...}')` in the same transaction. The
idempotent re-register path (conflict → no row) writes no audit entry, exactly as before it
wrote no customer. app-core's `/auth/register` handler is unchanged — the write moves with the
insert it belongs to.

## Audit payload shapes (documented, not schema-enforced)

`payload` stays free-form jsonb; the writer sets, and the reader tolerates:

```jsonc
{ "type": "user_registered", "customerId": "…", "phone": "+972…",
  "firstName": "…", "lastName": "…", "email": "…?", "backfilled": true? }
{ "type": "user_deleted",    "customerId": "…", "phone": "+972…",
  "firstName": "…", "lastName": "…", "email": "…?", "actor": "admin@…" }
```

Unknown/future `type`s must still render in the feed (generic badge, raw type string) — the
reader never throws on unrecognised payloads.

## Contracts (`packages/contracts/src/activity/admin.ts`, new domain dir)

```ts
export const ListActivityQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export const ActivityItem = z.object({
  id: z.string(),            // "audit_<id>" | "otp_<phone>"
  type: z.string(),          // "user_registered" | "user_deleted" | "otp_sent" | future
  at: z.string().datetime(),
  phone: z.string().optional(),
  name: z.string().optional(),      // "First Last" when known
  email: z.string().optional(),
  actor: z.string().optional(),     // user_deleted: acting admin
  channel: OtpChannel.optional(),   // otp_sent only
  code: z.string().optional(),      // otp_sent only — dev sink code
  expiresAt: z.string().datetime().optional(), // otp_sent only
});

export const ListActivityResponse = z.object({
  items: z.array(ActivityItem), total: z.number().int(),
  page: z.number().int(), pageSize: z.number().int(),
});
```

Barrel-wired: `src/activity/index.ts` → root `src/index.ts`.

## Backend — admin-api

- **`packages/db/src/activity.ts`**: `listAuditLog(db, {page, pageSize})` mirroring
  `listCustomers` — page query (`ORDER BY created_at DESC, id DESC`, limit/offset) and
  `COUNT(*)` in parallel; returns raw rows `{id, payload, created_at}`. Exported from the
  package barrel.
- **Payload→item mapping is a pure function** (`toActivityItem`) in admin-api (pattern:
  `users-stats.ts` separates pure logic from I/O) — unit-testable, tolerant of unknown types.
- **`GET /admin/activity`** in `handler.ts` (already behind `requireAdmin`; the `/{proxy+}`
  catch-all + CORS GET already cover it — zero routing/CORS changes):
  `ListActivityQuery.safeParse` → 400 `{error:"invalid_request"}` → `listAuditLog` → map →
  `ListActivityResponse.parse`.
- **Dev OTP merge:** only when `DEV_OTP_SINK_TABLE` is set (never in prod — the table doesn't
  exist there) **and `page === 1`**: `Scan` the sink (new `scanAll()` on `DevOtpSinkRepo`),
  drop client-side any item with `ttl` past (DynamoDB TTL deletion lags), map to
  `otp_sent` items (`at := createdAt`, `expiresAt := ttl`), merge into the page by `at`
  descending. `total` includes the live sink count. Page 1 may exceed `pageSize` by the sink
  size — accepted dev-only looseness.
- **Actor:** the delete route passes the acting admin from the JWT claims (email claim,
  falling back to `username`/`sub`) into `adminDeleteCustomer(db, id, actor)` (updated
  `packages/db` wrapper calling the two-arg function).

## Frontend (`apps/web`)

- `AdminView` union gains `"activity"`; new `NavItem` (pulse icon, Overview group, between
  Users and the Settings label) in `AdminLayout.tsx`; `heading` record entry in
  `AdminPage.tsx` ("Activity" / "Audit log and user activity, newest first").
- **`ActivityView.tsx`** mirrors `UsersView.tsx`: `{ token }` prop, `PAGE_SIZE = 20`, 1-based
  `page`, `data | null` + `loading` + `loadFailed`, skeleton rows (`aria-busy`), hand-rolled
  flex table in the `rounded-card` container, prev/next footer. **No search/filters in v1.**
- Columns per the approved mock: **Time** (HH:MM bold over short date, tabular/LTR) ·
  **Event** (badge: registered → confirmed-green, deleted → rejected-red, OTP → pending-amber
  with a solid `DEV` tag; unknown type → neutral badge with the raw type) · **User**
  (name over phone; OTP rows phone only) · **Details** (deleted: "by {actor} · audit #{id}";
  OTP: channel + mono code chip + relative expiry; registered: "—").
- `adminApi.listActivity(token, {page, pageSize})` in `lib/admin-api.ts`
  (`URLSearchParams` + `adminRequest`, 401-refresh free).
- **i18n:** EN + HE keys for every new string (nav label, heading, column headers, badge
  labels, details templates, empty/error states, pagination).

## Infra (`infra/lib/admin-stack.ts` + app wiring)

- `AdminStack` gains an optional `devOtpSinkTable?: dynamodb.ITable` prop (same pattern as
  `identity-stack.ts:25`), passed from `DataStack` in the CDK app wiring.
- When present: `DEV_OTP_SINK_TABLE` env on the admin-api function +
  `grantReadData(adminApiFn)`. Absent in prod → no env, no grant, handler merge disabled —
  fail-closed.
- No new routes, no CORS change, no new workspace packages (`@wanthat/dynamo` is already an
  admin-api dep — the bundled-workspace-deps trap doesn't fire). ASCII-only descriptions as
  always.

## States & errors

- **Loading:** 5 skeleton rows, same treatment as UsersView.
- **Load failure:** inline error line + the page controls stay usable (retry via prev/next);
  same pattern as UsersView `loadError`.
- **Empty feed:** "No activity yet" empty line (post-backfill this only happens on a fresh
  environment).
- **Unknown audit types:** rendered generically, never dropped, never throw.

## Testing

- **admin-api** (`handler.test.ts` pattern): `/admin/activity` returns contract-valid shape;
  bad `page`/`pageSize` → 400; `toActivityItem` unit tests — registered/deleted/backfilled/
  unknown-type payloads, OTP sink item mapping incl. expired-TTL filtering; dev merge only
  when env present + page 1.
- **db:** `listAuditLog` query-shape test if the existing package tests support it (no live-DB
  harness exists; the SQL function is exercised on dev post-deploy).
- **SPA:** i18n completeness (EN+HE) for the new keys.
- **Verification:** `pnpm typecheck && pnpm test && pnpm synth`; `cdk diff` before deploy.
  Post-deploy on dev: existing users appear backfilled at their registration dates; register a
  test user → `user_registered` row; delete it → `user_deleted` row with actor; request an OTP
  → code visible on page 1 and expires out; spot-check the chain
  (`entry_hash` of row N recomputes from row N-1) with a one-off SQL query.

## Out of scope (later slices / follow-ups)

- OTP activity in **prod** (needs its own persistence + PII design; ADR-worthy).
- Login events for returning users (nothing is written today).
- Audit rows for past deletions (unrecoverable — nothing was written).
- Chain **verification** tooling/endpoint (manual SQL spot-check for now).
- Feed filters/search, per-type pages, CSV export.
- Dropping the legacy one-arg `admin_delete_customer` (cleanup migration after this deploys).
- Moving `poller_writer` onto `audit_append` (lands with the conversion-poller slice).
