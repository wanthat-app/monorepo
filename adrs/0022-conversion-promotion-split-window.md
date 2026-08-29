# ADR 0022 — Conversion promotion: split the poll window by status (`listbyindex` filters by paid time)

- **Status:** Accepted (implemented — v0.1.20)
- **Date:** 2026-08-29
- **Refines:** [ADR-0009](0009-conversion-ingestion-poller.md) (resolves its open integration point
  on the re-scan window; corrects the "re-read overlapping windows so status transitions are
  captured" mechanism with the observed `listbyindex` filter behaviour)
- **Related:** [ADR-0008](0008-consumer-attribution-model.md) (attribution resolved in the scan),
  [ADR-0002](0002-app-compute-topology.md) (sole money writer), [ADR-0021](0021-retailer-api-throttling-interim.md)
  (sequential retailer calls)

## Context

ADR-0009 ingests conversions with a scheduled poll of `aliexpress.affiliate.order.listbyindex` over
a `[now − lookback, now]` window, and **assumed re-reading overlapping windows would capture status
transitions** (`pending → confirmed`). It explicitly left the window sizing as an **open
integration point**: "the re-scan window must cover an order's full maturation … the value is to be
decided during integration once that latency is observed."

Integration observation resolves it — and contradicts the assumption. Probing the prod affiliate
account (2026-08-26, read-only; scripts under `scripts/probe-*.ts`):

- **`listbyindex`'s `start_time`/`end_time` filter on the order's PAID time**, not a
  status-change/modified time. Evidence: **14 orders in `Buyer Confirmed Receipt`** (paid 48–76
  days earlier) appeared **only** in a ~90-day window covering their paid time — **never** in the
  recent (3h / 72h) windows.
- The steady-state poll window is `[watermark − overlap, now]` with the watermark advancing to `now`
  each run, so it only ever sees orders **paid in the last ~interval**. A confirmation that matures
  days-to-weeks after payment sits at an **old** paid time, outside that window → **never re-read →
  never promoted.** The `Buyer Confirmed Receipt` branch matched nothing; **`pending → confirmed`
  was effectively dead for every order** (14 orphaned confirmed orders sat uncredited in prod).
- **Widening `poller.lookbackHours` cannot fix it in steady state** — the watermark start dominates
  `max(floor, watermark − overlap)` — and `listbyindex` enforces a **maximum window span**
  (empirically < ~90 days; a 365-day query returns nothing), so an arbitrarily wide lookback is
  impossible.
- **`aliexpress.affiliate.order.get` (by-id) exists but returns empty** for known order ids, so
  there is no by-id fallback to refresh a specific order's status.

## Decision

Split the poll window **by status** — the two statuses have opposite time profiles under a
paid-time filter:

- **New orders — narrow watermark scan** (`pollOrders`): `Payment Completed` over
  `[watermark − overlap, now]` → the `pending` row. Correct, because a new order is seen promptly at
  its recent paid time.
- **Maturation — wide, slow-cadence scan** (`scanConfirmedOrders`, new): `Buyer Confirmed Receipt`
  over a **wide fixed window `[now − poller.confirmScanDays, now]`**, decoupled from the watermark,
  on its own cadence → the `confirmed` row (and clawback). This re-reads far enough back (by paid
  time) to catch a late maturation, kept **under the `listbyindex` span cap**. Idempotent on the
  `(order_id, kind, status)` unique index, so re-reading the whole window every tick never
  double-credits.
- **Manually-attributed orders** (no `custom_parameters` → `no_ref`): the wide scan injects the
  stored `unattributed_order.claim` (recommendation → owner as referrer, `consumer: none`) so they
  promote through the **same** path as tracked orders — no separate mechanism, no dependence on the
  (unusable) by-id API.

Two new admin-tunable CONFIG keys (alongside ADR-0009's `poller.*`): **`poller.confirmScanDays`**
(default 80) and **`poller.confirmScanIntervalMinutes`** (default 720). The ledger event-log, the
derived balance, the snapshotted split (ADR-0008), the sole writer (ADR-0002), and the
conversion-event analytics of ADR-0009 are **unchanged** — this ADR refines only the
window/cadence mechanism.

## Alternatives considered

- **Widen `poller.lookbackHours` to span maturation** — defeated by the watermark (steady-state
  start dominates) and capped by the `listbyindex` max span; also re-processes the entire window
  every 30-min heartbeat.
- **By-id refresh via `aliexpress.affiliate.order.get`** — the API answers `The result is empty`
  for our order ids (probed with/without `tracking_id`/`fields`); not viable.
- **Postback/webhook low-latency hint that triggers an early pull** — deferred, as in ADR-0009.

## Consequences

- Confirmation latency is bounded by `poller.confirmScanIntervalMinutes` (default 12h) — acceptable;
  confirmed money is not latency-sensitive and the buyer-confirm window is days-to-weeks.
- The wide scan re-reads the whole confirm window each cadence tick (idempotent no-ops on the unique
  index); cost is bounded and small at MVP volume. It runs off its own `poller_state`
  (`aliexpress#confirmed`) cadence gate, independent of the narrow scan's watermark.
- **Coverage ceiling:** an order confirming later than `confirmScanDays`, or older than the
  `listbyindex` max span, would be missed and needs a one-off wider sweep. Current confirmations are
  within ~80 days.
- The wide scan invokes `ledger-writer` on a possibly-cold Aurora; the `waitForDb` probe-timeout
  hardening (v0.1.21/v0.1.22) keeps that invoke from hanging the whole budget.
- Monitoring shifts from ADR-0009's single "poll lag" to also watching the **confirmed-scan
  summary** (`fetched` / `injected` / `written`) and its cadence gate.

**Evidence:** `scripts/probe-listbyindex.ts`, `scripts/probe-order-get.ts`; design spec
`docs/superpowers/specs/2026-08-26-confirmed-promotion-and-manual-attribution-design.md`.
