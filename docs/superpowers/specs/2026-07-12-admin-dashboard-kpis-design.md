# Admin dashboard: real KPIs + trends

**Date:** 2026-07-12
**Status:** Approved
**Slice:** one PR — the dashboard shows real user/activity/recommendation numbers end to end.

## Goal

The admin dashboard leads with real numbers for the MVP's headline metrics — registered
users, active users, and recommendations — plus 30-day trend charts for signups, active
members, and recommendations created. Today the users KPI and recommendation/product
counts are live; everything else is a "—" placeholder, and the users panel renders
"metrics unavailable" because `/admin/stats/users` returns an empty object (the Aurora
customer table it aggregated was removed by the Cognito-native auth migration, ADR-0027).

**Definition of "active":** a member who *used the app* — made any authenticated
member-API call — within the window. Deliberately NOT "signed in recently": the SPA keeps
sessions alive via refresh tokens, so fresh Cognito sign-ins are rare and would undercount
badly.

## Decisions (approved 2026-07-12)

1. Headline KPIs first: users (registered/active) and recommendations. Money KPIs
   (cashback, pending, conversions) stay as placeholders for a later slice.
2. Active = used the app (last-seen stamping in the member APIs), not fresh sign-ins.
3. Numbers **and** trend charts, not numbers only.
4. Sourcing approach: **counters everywhere** (approach B) — daily counter items in
   DynamoDB for all three trends. Uniform O(1) reads forever; the accepted trade-off is
   that charts start empty and fill from deploy day forward (pre-launch days read as
   zero).

## Data model — new items in the existing OpsCounters table

All new items live in the existing `OpsCounters` table (PK attribute `counterKey`),
following the `customerCounter` sentinel-counter pattern (atomic ADD; a missing item
reads as zero).

| Item key                    | Attributes           | Written by |
| --------------------------- | -------------------- | ---------- |
| `signupsDaily#<YYYY-MM-DD>` | `count` (atomic ADD) | Post-Confirmation trigger, alongside its existing `customerCounter` increment |
| `recsDaily#<YYYY-MM-DD>`    | `count` (atomic ADD) | `app-links`, after a successful recommendation create — fire-and-forget, stats-grade; a counter failure never fails the create |
| `activeDaily#<YYYY-MM-DD>`  | `count` (atomic ADD) | `app-core` + `app-links`, on a member's first authenticated touch of the day |
| `presence#<sub>`            | `lastSeenDate`       | Same writers — the first-touch-of-day detector |

### Active-user mechanics

On any authenticated member request, a shared helper (new module in `packages/dynamo`)
runs a conditional update of `presence#<sub>` with condition `lastSeenDate <> :today`
(or attribute-not-exists). When the conditional write succeeds — i.e. this is the
member's first touch today — the helper also bumps `activeDaily#<today>`. When the
condition fails, the member was already counted today and nothing else happens.

- A per-container in-memory memo (`sub → date`) skips the DynamoDB call entirely for
  members already stamped today by this container, so warm Lambdas add zero chatter after
  the first request. Steady-state cost: ~1 conditional write + 1 counter ADD per active
  member per day.
- Stamping is fire-and-forget: failures are logged (structured warn), never surfaced to
  the member, never delay the response.
- Both member-facing services stamp: `app-core` (identity/wallet, in-VPC) and `app-links`
  (links, non-VPC). A member touching either counts as active.

### Window counts vs daily counters

Distinct users in a 7/30-day window canNOT be summed from daily counters (repeat visitors
would double-count). So:

- **Active 7d / 30d KPI:** admin-api counts `presence#` items with
  `lastSeenDate >= cutoff` — a scan filtered to the `presence#` key prefix. One tiny item
  per member ever seen; trivially small at MVP scale. If scale ever makes this scan hurt,
  swap the implementation behind the same contract field.
- **DAU trend chart:** reads the `activeDaily#` items directly.

### Time

All date bucketing (`today`, window cutoffs) computed in `Asia/Jerusalem`, so "today"
on the dashboard matches how the admin reads the charts. No TTL on the new items for
now — they are tiny; revisit if the table ever matters.

## Contracts + admin-api (no new endpoints)

Both existing endpoints stop returning stubs; shapes updated in `@wanthat/contracts`
(Zod, single source of truth):

- `GET /admin/stats/users` → real `UsersStats`:
  `{ newToday, new7d, new30d, active7d, active30d, dailySignups[30], dailyActive[30] }`.
  Sourced from a BatchGet of the 30 `signupsDaily#` + 30 `activeDaily#` items plus the
  presence count. `newToday/new7d/new30d` are sums of the daily signup counters.
- `GET /admin/stats/catalog` → gains `dailyCreated[30]` (the recommendations trend) from
  the `recsDaily#` items; existing exact totals unchanged.

`dailySignups` / `dailyActive` / `dailyCreated` entries are `{ date: "YYYY-MM-DD",
count: number }`, oldest first, exactly 30 entries with missing days as zero — the shape
the existing `SignupTrend` component already renders.

## Dashboard UI (`apps/web/src/features/admin/AdminPage.tsx`)

- **KPI row reordered to the headliners:** Registered users · **Active (30d)** (new
  card) · Recommendations · Products. The money placeholders (Cashback / Pending /
  Conversions) move to a second row, still "—" — they are the next slice's job, not
  deleted.
- **Users panel revived:** tiles for New today / 7d / 30d and Active 7d / 30d; the
  existing 30-bar signup trend renders real data again. The "metrics unavailable" state
  goes away (kept only as the error fallback).
- **Two more trend charts** reusing the existing bar-trend component, generalized to a
  `DailyTrend` that takes a label + data: Active members (30d) and Recommendations
  created (30d).
- RTL/i18n: new strings in both admin languages via the existing admin i18n bundle;
  trend charts stay `dir="ltr"` so time reads left→right (existing convention).

## Infra (CDK)

- OpsCounters **write** grants for `app-core` and `app-links` (post-confirmation already
  has one); admin-api already reads the table.
- `OPS_COUNTERS_TABLE` env var added to `app-core` + `app-links`.
- No new tables, no new Lambdas, no VPC changes. ASCII-only description fields, as
  always. NEVER reserve Lambda concurrency (account limit 10).

## Testing

- Unit tests (vitest, existing patterns): presence conditional logic + memo, daily
  counter ADD + date bucketing (Asia/Jerusalem edge: UTC evening vs local date), stat
  aggregation in admin-api (missing days → zero fill, window sums, presence count),
  fire-and-forget behavior (counter failure does not fail the create / the request).
- Verification: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm synth`; `cdk diff`
  before deploy.

## Out of scope

- Money KPIs (cashback / pending / conversions) — next slice, needs the wallet ledger
  aggregation.
- Backfilling trend history for days before deploy (approach B trade-off, accepted).
- TTL/archival for daily counter items.
- Any change to the users PAGE header semantics (it deliberately keeps the approximate
  whole-pool estimate including UNCONFIRMED signups; the dashboard counts CONFIRMED only).
