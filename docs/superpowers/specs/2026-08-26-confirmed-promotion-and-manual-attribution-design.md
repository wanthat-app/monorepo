# Design — Confirmed-order promotion + manual-attribution completion

**Date:** 2026-08-26
**Status:** approved (design); implementation pending
**Owner:** Dennis
**Related:** ADR-0008 (attribution via `custom_parameters`), ADR-0009 (scheduled poller; ledger as
derived projection), ADR-0002 (single money writer), ADR-0020 (Cognito `sub` = canonical id)

## Problem

A manually-attributed order (admin claims an unattributed AliExpress order) is credited to the
member's wallet as **`pending`** but never advances to **`confirmed`**, so the money is never
released. The reported symptom: Dennis's wallet shows a reward stuck in `pending` in prod.

Investigation showed the cause is **not** specific to manual orders. The pending→confirmed
promotion is broken **system-wide**:

- The settlement poller (`services/retailer-settlement/src/poll-orders.ts`) sweeps
  `aliexpress.affiliate.order.listbyindex` over a window `[watermark − 1h, now]`, and the watermark
  advances to `now` after every successful run. So in steady state the window is only ~the last
  ~90 minutes, filtered by the order's **paid time**.
- `listbyindex` filters by **paid time**, not by status-change time (proven — see Evidence). A
  "Buyer Confirmed Receipt" transition happens days-to-weeks after payment, at an unchanged (old)
  paid time, so it never falls inside the recent window. The `"Buyer Confirmed Receipt"` branch of
  the poll therefore effectively never matches, and **no order is ever promoted to `confirmed`**.

**Live evidence (prod, 2026-08-26):** 14 orders are currently in `"Buyer Confirmed Receipt"` (paid
June–July), none of which appear in the recent/72h windows — only in a ~90-day historical window.
None were promoted in our ledger. Every `"Payment Completed"` query returned 0, so Dennis's stuck
order is almost certainly one of these 14 (confirmed on AliExpress, frozen at `pending` in the
wallet because promotion never ran).

## Evidence

Two read-only probes were run against the live prod affiliate account (scripts committed under
`scripts/`, reproducible):

- **[E1]** `listbyindex` filters by **paid time**; recent windows miss matured orders. 14 orders in
  `"Buyer Confirmed Receipt"` (paid 48–76 days ago) appeared **only** in a ~90-day window covering
  their paid time, **never** in `recent-3h` or `lookback-72h`. Source:
  `scripts/probe-listbyindex.ts`. Tier: live observation (equivalent to T1 for our account).
- **[E2]** `aliexpress.affiliate.order.get` **exists but is unusable for our lookup**: it returns
  `405 "The result is empty"` for a known-good order id across param variations (with/without
  `tracking_id`, with/without `fields`). Source: `scripts/probe-order-get.ts`. → A by-id refresh is
  **not** a viable mechanism.
- **[E3]** A wide `listbyindex` window **works**: an 87-day window returned all 14 confirmed orders.
  A 365-day window returned **0** despite containing that range → `listbyindex` enforces a **maximum
  window span** (empirically `∈ (87, 365)` days). Source: `scripts/probe-listbyindex.ts`.

### Unverified assumptions

- **[A3]** The exact maximum `listbyindex` window span is unknown (between 87 and 365 days; 87 is
  proven to work). The design stays safely under it (`confirmScanDays` default 80). Confirm the
  exact cap during implementation if a wider window is ever wanted.
- **[A4]** AliExpress's buyer-confirm/auto-confirm period is assumed to fall within ~80 days of
  payment (buyer-protection windows are typically ≤60 days). Orders that confirm later than
  `confirmScanDays` would be missed and need a one-off wider sweep. The 14 current orders are all
  ≤76 days, so they are covered.

## Design

The evidence rules **out** a by-id refresh (`order.get` unusable) and rules **in** the simpler
pull-driven loop — provided the window strategy is **split by status**. The fix is three focused
changes; `settle-claims` and the narrow new-order scan are unchanged.

### 1. Split the poll window strategy by status

- **New orders** (`"Payment Completed"`) — keep the existing narrow, watermark-bounded scan in
  `pollOrders`. This is correct: a new order is seen promptly at payment time and gets its `pending`
  row. **Remove `"Buyer Confirmed Receipt"` from `POLL_STATUSES`** (it is useless in the narrow
  window — proven).
- **Maturation** (`"Buyer Confirmed Receipt"`) — a **new step, `scanConfirmedOrders`**, sweeps a
  **wide window `[now − confirmScanDays, now]`, decoupled from the watermark**, on a **slower
  cadence**. This is what actually catches confirmations (proven: the 90-day window returns them).
  Idempotent via the existing `(order_id, kind, status)` unique index, so re-scanning the same
  window every run never double-credits.

`scanConfirmedOrders` runs each heartbeat alongside `pollOrders` + `settleClaims` in
`services/retailer-settlement/src/handler.ts`, self-gated on its own cadence.

### 2. Manual-attribution injection in the `no_ref` branch

Manual orders have no `custom_parameters`, so `resolveOrder` returns `no_ref`. In
`scanConfirmedOrders`, when an order resolves to `no_ref`, look up its `unattributed_order` entity;
if it carries a **`claim`**, resolve the reward from the stored claim
(recommendation → owner as referrer at the **snapshotted** split, `consumer: none`) at
`mapStatus(order.status)` and write it through the ledger-writer — the **same** path tracked orders
take. This is the "unify manual into the pull loop" approach: manual orders ride the wide confirmed
scan exactly like tracked ones. The claim→`ConversionWrite` assembly is shared with `settle-claims`
(extracted into one helper) so the money math lives in one place.

Orders with no claim (unclaimed unattributed) remain sightings — correct, there is no one to credit.

### 3. Unchanged: initial manual credit stays in `settle-claims`

`settle-claims` still performs the **initial `pending` credit** of a claimed order by reading the
`claimed` DynamoDB queue — reliable and independent of whether the poll happens to re-fetch the
order. (The narrow `"Payment Completed"` scan cannot be relied on to re-show an order after the
admin claims it, so `settle-claims` remains the initial-credit path.) `scanConfirmedOrders` then
handles the later promotion to `confirmed`.

### Resulting lifecycle

| Order kind | `pending` (initial credit) | `confirmed` (promotion) |
|---|---|---|
| Tracked (has `custom_parameters`) | narrow `Payment Completed` scan (`pollOrders`) | **wide `scanConfirmedOrders`** |
| Manual (admin-claimed) | `settle-claims` (unchanged) | **wide `scanConfirmedOrders` + claim injection** |

## Self-heal & backfill

Because `scanConfirmedOrders` sweeps a wide window each run, the **14 currently-orphaned confirmed
orders are the backfill** — no separate script:

- Dennis's order (almost certainly among the 14): on the first `scanConfirmedOrders` after deploy it
  is fetched at `"Buyer Confirmed Receipt"`, resolves `no_ref` → its `unattributed_order` item has a
  `claim` → a `confirmed` row is appended → the wallet shows `confirmed`. Deterministic (paid ≤76d,
  within `confirmScanDays` = 80).
- The other 13: promoted if attributed (tracked → `custom_parameters`; manual → claim injection);
  left as sightings if unclaimed/unattributed (correct).

## Components / changes

- `services/retailer-settlement/src/poll-orders.ts` — remove `"Buyer Confirmed Receipt"` from
  `POLL_STATUSES` (narrow scan = new orders only).
- `services/retailer-settlement/src/scan-confirmed.ts` (new) — `scanConfirmedOrders(deps)`: wide
  fixed window, cadence-gated via its own poller-state entry (`aliexpress#confirmed`, `lastRunAt`
  only — no watermark needed), paginate `listbyindex` for `"Buyer Confirmed Receipt"`, resolve each
  (tracked via `resolveOrder`; manual via claim injection), batch-invoke the writer.
- `services/retailer-settlement/src/manual-claim.ts` (new, or shared into `attribution.ts`) —
  `resolveManualClaim(order, item, deps) → ConversionWrite`, reusing `splitCommission` + `mapStatus`;
  used by both `scanConfirmedOrders` and `settle-claims` (single source of the manual money math).
- `services/retailer-settlement/src/handler.ts` — call `scanConfirmedOrders` each heartbeat; wire an
  `unattributed` lookup (`get` / batched `get`) into its deps.
- `packages/dynamo/src/unattributed-order.ts` — add a `get(orderId)` / batched lookup if not present
  (the `no_ref` branch needs the item by id; batch for efficiency across a page).
- `packages/contracts/src/config/keys.ts` — new keys **`poller.confirmScanDays`** (default `80`,
  bounded < the [A3] cap) and **`poller.confirmScanIntervalMinutes`** (default `720` = 12h; confirmed
  money is not latency-sensitive) with schemas + defaults; they surface in the admin config page like
  any other key.
- `packages/dynamo/src/poller-state.ts` — no change (generic by `stateKey`; the confirmed scan uses a
  new key).

## Idempotency, safety, constraints

- **Money one door only:** all credits still flow through `ledger-writer` via `invokeWriter`
  (audit-or-fail); the in-VPC writer is never called from admin (ADR-0002/0004). Unchanged.
- **Append-only + unique index** `(order_id, kind, status)` makes every re-scan write a no-op — safe
  to re-sweep the wide window on each cadence tick (ADR-0009).
- **Attribution source:** manual injection reads **our** stored `claim` (DynamoDB
  `unattributed_order`), never AliExpress `custom_parameters` — consistent with the existing
  `settle-claims` design and ADR-0008 (which only governs the tracked path).
- **ADR-0009 note:** ADR-0009 assumed "overlapping re-reads capture status transitions." Evidence
  [E1] shows that is false for the narrow window. This design corrects it via the split window
  strategy; worth a short ADR-0009 amendment/appendix documenting the paid-time filter + the wide
  confirmed scan (not a superseding ADR — the poller decision stands).

## Efficiency

- `scanConfirmedOrders` re-processes the whole confirmed set within `confirmScanDays` each tick
  (idempotent no-ops for already-written rows). At MVP volume (tens of orders) this is trivial; the
  slow cadence (12h default) keeps it cheap. Optional future optimization: mark manual items
  `finalized` once a `confirmed`/`clawback` row is written to skip them (tracked orders have no
  entity to mark, so they would still re-write idempotently — acceptable).
- Retailer calls stay sequential with the ADR-0021 throttle. The wide window is paginated like the
  existing scan.

## Testing

Pure-unit with fakes (fake AliExpress client, fake writer, fake repos), no live calls:

- `scanConfirmedOrders`: cadence gating (skips when not due); fixed wide window bounds; pagination.
- tracked confirmed order → `confirmed` write via `resolveOrder`.
- manual claimed order (`no_ref` + `claim`) in the confirmed scan → injection → `confirmed` write.
- `no_ref` with **no** claim → sighting only (unchanged behavior).
- idempotent re-scan → writer dedups, no double-credit.
- `resolveManualClaim` money math (referrer at snapshotted split, `consumer: none`).
- new config keys parse + defaults.
- `pollOrders` narrow scan no longer queries `"Buyer Confirmed Receipt"`.

## Out of scope

- The by-id `order.get` path (proven unusable, [E2]).
- Orders confirming later than `confirmScanDays` ([A4]) — a one-off wider sweep if it ever occurs.
- A general "order" entity for tracked orders (tracked attribution stays on `custom_parameters`).
