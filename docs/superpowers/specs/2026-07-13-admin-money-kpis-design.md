# Admin dashboard: money KPIs (approach A — derive from the ledger)

**Date:** 2026-07-13
**Status:** Approved (approach A chosen 2026-07-12; running-total alternative rejected 2026-07-13 — ledger stays fact-only)
**Slice:** one PR — the dashboard's money cards show real ledger-derived numbers end to end.

## Goal

Replace the dashboard's money placeholders with real numbers derived at read time from the
append-only `wallet_entry` ledger, and surface the PRD §3.2 go/no-go metric (avg cashback per
active member / month, thresholds >₪5 M1 / >₪20 M3) — computable now that active-member counts
exist (2026-07-12 slice).

## Decisions

1. **Approach A — read-time Aurora aggregation.** No stored totals anywhere: money is derived
   from the ledger per request, mirroring `deriveBalances` semantics. A per-row running-total
   design was considered and rejected (2026-07-13): reward lifecycle rows are not self-contained
   deltas, stored totals freeze interpretation into an UPDATE-revoked table, and windowed KPIs
   would still scan. Designated future optimization if reads ever hurt: disposable snapshot/
   checkpoint rows OUTSIDE the ledger (event-sourcing pattern) — never per-row totals.
2. **KPIs:** Cashback earned (confirmed, all-time), Pending cashback, Conversions (30d) +
   30-day trend, ₪ per active member (30d). Conversion RATE and CTR (PRD §3.2) stay out of
   scope — they need the click-tracking funnel slice (`recommendation.clicks` is a placeholder).
3. **"Pending payouts" is renamed "Pending cashback"** — no payout flow exists (withdraw is
   "coming soon"), so pending *cashback* is the honest label.
4. **₪ figures are display-only estimates**, converted exactly like the member wallet:
   `convertMinor(amount, cached USD→ILS rate, fx.conversionCommissionBps)` (ADR-0017). Per-
   currency raw totals travel alongside; the SPA leads with the ₪ estimate.

## Semantics (must mirror `deriveBalances`)

- Reward rows only: `kind IN ('referrer_cashback','consumer_reward')`. Adjustments/withdrawals
  are member-level movements, not platform cashback — excluded from these KPIs.
- **Lifecycle collapse:** group rows by `(currency, order_id, kind)`; the furthest-advanced
  status wins (`pending < confirmed < clawback`); clawback contributes 0. Rows with NULL
  `order_id` stand alone (same orphan rule as `deriveBalances`).
- **Cashback earned (all-time):** Σ collapsed rewards at `confirmed`, per currency.
- **Pending cashback:** Σ collapsed rewards at `pending`, per currency.
- **Conversions:** DISTINCT `order_id` having any reward row (an order with both a referrer and
  a consumer reward is ONE conversion). Bucketed to the Asia/Jerusalem date of the order's
  EARLIEST reward row (first ingest). `conversions30d` = distinct orders bucketed in the window;
  `dailyConversions` = dense, ascending, exactly 30 `DailyCount` entries (matches the existing
  trend contract). Orphan rows (NULL order_id) are not conversions.
- **₪ per active member (30d):** (Σ rewards whose collapsed status is `confirmed` AND whose
  confirmed-row `created_at` bucket falls in the 30-day window, converted to ILS) ÷
  `active30d` (presence count, existing `OpsMetricsRepo.countActiveSince`). Null when no FX
  rate is cached or `active30d` is 0.
- All date bucketing Asia/Jerusalem via the existing `jerusalemDate`/`lastNDates` helpers; the
  pure derivation stays in `@wanthat/domain` and receives rows pre-stamped with their bucket
  date (domain does not import the dynamo package).

## Components

- **`@wanthat/db`** — `listRewardRows(db)`: one SELECT of reward rows (`kind, amount_minor,
  currency, order_id, status, created_at`). MVP volumes are bounded (same justification as
  `listEntriesForSub`); no SQL aggregation yet.
- **`@wanthat/domain`** — `deriveMoneyStats(rows, dates)`: pure exact-bigint derivation of the
  semantics above. Input rows carry `{kind, amountMinor, currency, orderId, status, date}`
  (date = pre-computed Jerusalem bucket); `dates` = the dense 30-day axis. Output: per-currency
  all-time confirmed/pending totals, per-currency confirmed-in-window totals, conversions30d,
  daily conversion counts.
- **`@wanthat/contracts`** — `MoneyStats`:
  ```
  {
    totals: [{ currency, confirmed: Money, pending: Money }],   // per currency, all-time
    ilsEstimate: { confirmed: Money, pending: Money } | null,   // null = USD held but no rate
    conversions30d: int,
    dailyConversions: DailyCount[30],
    cashbackPerActive30d: Money | null,                         // ILS; null: no rate or 0 actives
  }
  ```
  Money travels per the existing wire rule (bigint code-side, decimal-string on the wire via
  the `moneyJson` serializer already used by admin-api's user wallet route).
- **admin-api** — new `GET /admin/stats/money`: reward rows (as `app_ro` — SELECT on
  `wallet_entry` already granted) → stamp buckets → `deriveMoneyStats` → ILS conversion (new
  `fx: FxRateRepo` in context + the existing config repo for the commission bps) →
  `active30d` via the existing `opsMetrics`. Served separately from the DynamoDB stats so a
  scale-to-zero Aurora resume (~20s) delays ONLY the money cards.
- **infra** — AdminStack: `fxRateTable` prop + `FX_RATE_TABLE` env + `grantReadData` on the
  admin-api function; wire the table in `infra/bin/wanthat.ts`. Nothing else.
- **web** — the dashboard's second row becomes four LIVE cards: Cashback earned (₪≈, raw
  per-currency in the subtitle), Pending cashback (₪≈), Conversions (30d), ₪/active member
  (30d). Own fetch + skeleton (`/admin/stats/money` loads late on a cold cluster; the DynamoDB
  rows above render immediately). New "Conversions" panel with the 30-day `DailyTrend` chart.
  i18n (en+he): rename `stats.cashback` → "Cashback earned", `stats.pending` → "Pending
  cashback", `stats.conversions` → "Conversions (30d)"; add `stats.perActive30d`; panel strings.

## Error handling

- FX rate missing → `ilsEstimate`/`cashbackPerActive30d` are null; the SPA shows the raw USD
  totals (same fallback contract as the member wallet).
- Money fetch failure → the four money cards show "—" with the existing error styling; the
  rest of the dashboard is unaffected (independent fetches).
- Aurora cold resume: no special handling — admin-api's activity page already rides it out;
  the cards keep their skeleton until the response lands.

## Testing

- domain: `deriveMoneyStats` unit tests — lifecycle collapse (pending→confirmed→clawback),
  distinct-order conversion counting (two kinds = one conversion), window edges, orphan rows,
  multi-currency, empty ledger.
- db: `listRewardRows` against the Testcontainers harness (existing wallet.test.ts pattern).
- admin-api: route test with mocked context (shape, null-FX fallback, active30d=0 → null).
- web: typecheck + i18n parity; existing vitest suites.
- `pnpm lint && pnpm typecheck && pnpm test && pnpm synth`; check-deploy on the PR.

## Out of scope

- Click tracking / conversion rate / CTR (own future slice).
- Withdrawal/payout flows and their KPIs.
- Snapshot rows (documented future optimization only).
- `StatsOverview` placeholder fields (`totalCashbackMinor` etc.) stay untouched — the dashboard
  reads the new endpoint; the overview keeps serving only `usersCount`.
