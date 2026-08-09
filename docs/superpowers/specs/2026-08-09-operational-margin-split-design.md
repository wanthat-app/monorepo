# Operational margin + buyer↔recommender split (admin settings)

**Date:** 2026-08-09
**Scope:** Issue #1 of a four-issue batch. Issues #2 (assign buyer + recommender on
unattributed claims), #3 (recommender-only orders revert the buyer share to the recommender
after the lockdown window), and #4 (missing AliExpress unassigned orders) are **out of scope**
here and will each get their own spec.

## Problem

The admin margins panel today exposes two independent percent sliders — `cashback.referrerBps`
(recommender's cut, default 50%) and `cashback.consumerBps` (buyer's cut, default 0%) — each an
absolute fraction of the gross affiliate commission. The "operational margin" the house keeps is
only the implicit residual (`gross − referrer − consumer`), never surfaced as a knob.

We want the panel to speak the operator's mental model instead:

1. **Operational margin** — a percentage taken off the top for operational cost.
2. **Buyer↔recommender split** — how the *remainder* is divided between recommender and buyer.

## Decisions (locked with the user)

- **Replace**, not add: the margins section shows exactly these two sliders (plus the unrelated
  `fx.conversionCommissionBps`, untouched). The old two absolute-% sliders are removed from the UI.
- **New-links-only semantics preserved.** Each recommendation still snapshots its split at creation
  (`CashbackSplit`). A margins change affects links created afterward (and the deleted-recommendation
  fallback), exactly as today. No retroactive re-pricing.
- **No DB / config-key / migration changes.** The canonical stored values remain
  `cashback.referrerBps` and `cashback.consumerBps`. Margin and split are **derived on the fly**
  from those two — nothing downstream (`splitCommission()`, the per-recommendation snapshot, the
  ledger writer, money-stats, the member SPA) changes, because they all keep reading the same two
  BPS values.
- **Derivation lives server-side** in the `admin-console` lambda, backed by a shared, unit-tested
  pure helper in `packages/domain`. The SPA stays thin — it renders two sliders bound to
  `{ marginBps, recommenderSplitBps }` and never does the math itself.

## The math

All values are basis points (`Bps`, integer 0–10000), the existing money unit.

**Forward (sliders → stored BPS)** — `deriveBpsFromMarginSplit(marginBps, recSplitBps)`:

```
remainderBps = 10000 − marginBps
referrerBps  = round(remainderBps × recSplitBps / 10000)
consumerBps  = remainderBps − referrerBps        // subtract, don't round twice
```

Subtracting `consumerBps` (rather than rounding it independently) guarantees
`referrerBps + consumerBps = remainderBps` exactly, so `margin` is always exact and there is no
rounding drift. Both outputs are valid `Bps` in [0, 10000].

**Inverse (stored BPS → sliders)** — `deriveMarginSplitFromBps(referrerBps, consumerBps)`:

```
sum          = min(referrerBps + consumerBps, 10000)   // clamp: legacy data could exceed 100%
marginBps    = 10000 − sum
recSplitBps  = sum === 0 ? 10000 : round(referrerBps × 10000 / sum)
```

- `recommenderSplitBps` is the recommender's share of the remainder (0 = all to buyer, 10000 = all
  to recommender).
- **Edge — margin 100% (`sum === 0`):** the remainder is empty, so the split is indeterminate; we
  report `recSplitBps = 10000` (default) and the UI disables the split slider.
- **Clamp** covers pre-existing configs where someone set `referrer + consumer > 100%` directly
  (the schema allows each independently); such a state reads back as margin 0.

Round-trip: for any `(marginBps, recSplitBps)` on the slider grid,
`deriveMarginSplitFromBps(deriveBpsFromMarginSplit(...))` returns the same pair (within the 50-bps
slider step). The default `referrer 5000 / consumer 0` reads back as **margin 50% · recommender
100% / buyer 0%**, so nothing changes economically on deploy.

## Components

### `packages/domain` — pure helpers
Add `deriveBpsFromMarginSplit` and `deriveMarginSplitFromBps` (co-located with `splitCommission`
in `src/index.ts`, or a new `src/margin-split.ts` re-exported from the index). No I/O. Fully
unit-tested (see Testing).

### `packages/contracts/src/config/margins.ts` — new Zod schemas
- `MarginSplitView` — `{ marginBps: Bps, recommenderSplitBps: Bps, referrerBps: Bps, consumerBps: Bps, updatedAt: string }`.
  (`referrerBps`/`consumerBps` are included so the UI preview line needs no client math.)
- `PutMarginSplitBody` — `{ marginBps: Bps, recommenderSplitBps: Bps }`.
- `MarginSplitResponse` — `{ item: MarginSplitView }`.

Reuse the existing `Bps` schema from `packages/contracts/src/common/money.ts`.

### `services/admin-console` — new routes
Mounted alongside the existing config routes (`services/admin-console/src/handler.ts`), guarded by
`requireAdmin`:

- **`GET /admin/config/margins`** → reads `cashback.referrerBps` + `cashback.consumerBps` from
  `RuntimeConfigRepo` (defaults applied for unset keys), runs `deriveMarginSplitFromBps`, returns
  `MarginSplitView`. `updatedAt` = the later of the two keys' `updatedAt` (or `EPOCH0` if both unset).
- **`PUT /admin/config/margins`** → parse `PutMarginSplitBody`, run `deriveBpsFromMarginSplit`,
  write **both** `cashback.referrerBps` and `cashback.consumerBps` via `config.put`, each chained to
  a `config_changed` audit event (audit-or-fail → 500 `audit_failed`, matching the existing
  single-key PUT behavior). Return the fresh `MarginSplitView`.

**Partial-write note:** DynamoDB has no cross-key transaction here (consistent with the project's
no-cross-table-transaction stance). Derive both values first, then write referrer, then consumer.
If the second write or its audit fails, return 500; both keys are independently valid `Bps` at all
times, so the worst case is a transiently skewed margin until the admin retries. Acceptable for the
MVP; no rollback needed.

### `apps/admin` — settings UI
`apps/admin/src/features/AdminPage.tsx`, `ConfigView` / `FIELDS`:

- Remove the `cashback.referrerBps` and `cashback.consumerBps` entries from the generic `FIELDS`
  array so they are no longer double-managed by the per-key mechanism.
- Add a dedicated **Margins** block in the `margins` section that:
  - loads via `adminApi.getMargins()` (`GET /admin/config/margins`) into a local draft
    `{ marginBps, recommenderSplitBps }`;
  - renders two `RangeSlider`s (reusing the existing `"percent"` styling, min 0 / max 10000 /
    step 50, formatted as `%`): **Operational margin** and **Buyer↔Recommender split** (the split
    slider's live label reads e.g. *"Recommender 60% · Buyer 40%"*);
  - shows a read-only **preview line**: *"Recommender 48% · Buyer 32% · House 20% of each
    commission,"* computed from the `referrerBps`/`consumerBps`/`marginBps` the endpoint returns;
  - when margin = 100% (remainder 0), **disables** the split slider and shows "no reward pool";
  - participates in the existing sticky **save / discard** bar: its dirty state joins the page's
    dirty set, and `save()` also calls `adminApi.putMargins(draft)` (`PUT /admin/config/margins`).
- `apps/admin/src/lib/admin-api.ts`: add `getMargins()` and `putMargins(body)`.

### i18n
New strings (Hebrew + English), following the existing `admin.keys.*` / section conventions:
`admin.keys.operational_margin.{title,desc}`, `admin.keys.buyer_recommender_split.{title,desc}`,
`admin.margins.preview` (with `{recommender}` / `{buyer}` / `{house}` placeholders),
`admin.margins.splitLabel` (`{recommender}` / `{buyer}`), and `admin.margins.noRewardPool`.

## Testing

- **`packages/domain`**: unit tests for `deriveBpsFromMarginSplit` and `deriveMarginSplitFromBps`:
  - the default case (50/0 ↔ margin 50 · split 100%);
  - a rounding case (e.g. margin 20% · split ⅓) verifying `referrer + consumer = remainder` exactly;
  - the margin-100% / remainder-0 edge (split reported as 100%, disabled);
  - the legacy over-100% clamp;
  - a round-trip property over the slider grid.
- **`services/admin-console`**: handler tests for `GET`/`PUT /admin/config/margins` — read with
  defaults, write derives + persists both keys, audit-or-fail returns 500 on audit failure,
  `requireAdmin` rejects non-admins.
- `pnpm lint` + `pnpm typecheck` before PR (biome format is CI-gated).

## Out of scope

Issues #2, #3, #4 — separate specs. Note only: #3 (recommender-only orders route the buyer share to
the recommender after the lockdown window) is a *settlement-time runtime decision*, independent of
this reparameterization; it does not require the config model to change.
