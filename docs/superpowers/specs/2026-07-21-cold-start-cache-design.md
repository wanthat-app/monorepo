# Cold-start cache: last known wallet + activity with a "counting the money" indicator

**Date:** 2026-07-21 · **Status:** approved design, pre-implementation

## Problem

Aurora Serverless v2 scales to zero; the first `member-wallet` request after idle rides a cold
resume. API Gateway cuts the connection at 30s while the Lambda's pg connect timeout waits up to
60s, so a cold start surfaces in the SPA as either a long pending state or an outright failed
request — today that renders skeletons and then the "load failed / retry" card. The member sees
an empty wallet for no good reason: the app knew their balance a minute (or a day) ago.

## Decision

Cache the last successful wallet response and the first page of the merged activity feed in
localStorage, per user. While fresh data is pending or failing, render the cached values with a
playful, clearly-not-final "Counting the money…" indicator and retry silently in the background.
The indicator's layout is admin-configurable; its animated glyph is chosen at random per page
view.

Decisions locked during brainstorming:

- Cached data + auto-retry covers **both** the slow-pending state and the outright cold-start
  failure. The retry card only appears when there is no cache at all.
- Scope: Home balance card, Home recent-activity strip, and the `/activity` page's first page.
- Two indicator layouts (admin key), two glyphs (random): gold ₪ coin bounce / mint
  bill-counting machine.
- No layout shift, ever: all indicator slots are height-locked and animations are
  transform-only (verified in the approved mockup).
- The permanent "Estimated" chip is renamed to "At current FX rates" (Hebrew: «לפי שערי מטבע»).

## 1. Cache layer — `apps/web/src/lib/stale-cache.ts`

A small typed module over localStorage. No new dependencies.

- **Keys are per-user**: `wanthat.cache.wallet.<sub>` and `wanthat.cache.activity.<sub>`
  (Cognito `sub`, the canonical user id per ADR-0020). A shared device never shows another
  member's numbers.
- **Envelope**: `{ v: 1, savedAt: <epoch ms>, data: <wire payload> }`. A version bump or an
  unparsable entry reads as a miss and overwrites on the next save.
- **TTL**: entries older than **7 days** read as a miss — a week-old balance presented as
  "counting" would mislead.
- **Write** on every successful fresh fetch: the wallet response verbatim; the activity feed's
  first merged page (the first `pageSize` items).
- **Robustness**: every storage access is try/catch-wrapped (Safari private mode, storage
  disabled, quota). Any throw degrades to a cache miss / silent no-write — behavior is then
  exactly today's.
- **Sign-out clears** both keys for the signed-out sub (alongside the token clearing in
  `user/store.ts`).

## 2. Wallet balance card (Home)

State selection (per render):

| Query state | Cache | Render |
|---|---|---|
| fresh data | — | normal card (writes cache) |
| pending | hit | stale card + counting indicator |
| pending | miss | today's skeleton |
| error (retrying) | hit | stale card + counting indicator |
| error | miss | today's retry card |

- **Silent auto-retry**: when the wallet query fails and a cache hit is showing, keep
  refetching with exponential backoff **capped at 30s** between attempts, for as long as the
  page is open (react-query `retry` + capped `retryDelay`, plus a capped `refetchInterval`
  while in error with cache). This matches the cold-start shape: the first call dies at API
  Gateway's 30s; the retry lands after Aurora resumes. No cap on attempts — the indicator keeps
  honestly saying "counting" until data lands.
- **Indicator layout — admin-configurable** via the existing public runtime-config projection:
  new public key `wallet.countingIndicator` with values `"chip" | "hero"`, default `"chip"`
  (also the fallback when the config read fails or returns junk).
  - `"chip"`: a mint pill chip in the card's header row (where the FX chip sits), glyph +
    "Counting the money…"; the stale amount stays big at reduced opacity with a slow breathe
    (opacity .55↔.8, 2s).
  - `"hero"`: the animation + text take the main-total slot (exact 46px line box); the last
    known total moves to the holdings row as a mint chip — "Last counted: ≈₪X" (Hebrew:
    «נספר לאחרונה: ≈₪X») — replacing the per-currency chips while stale.
  - The config endpoint **already supports batch reads** (`GET /config?keys=…`, up to 20 keys)
    — the new key rides the Home page's existing `home.recentActivityLimit` call; no extra
    request, no backend endpoint change.
- **Glyph — random per page view** (50/50 at mount): gold ₪ coin with a gentle bounce-and-tilt,
  or a mint bill-counting machine riffling bills with a blinking LED. Both are pure
  CSS/SVG-in-JSX, sized inside a fixed box (18px in the chip, ~34–42px in the hero), animated
  with `transform`/`opacity` only, overflowing their box without affecting layout.
- **No-jump invariants** (from the mockup): the header row keeps `min-height` equal to the chip
  height (26px) in every state; the hero occupies the identical 46px amount slot; the
  last-counted chip matches the holdings-chip height (26px row).
- **Chip copy change (always-on, not cold-start-specific)**: `home.estimated` becomes
  "At current FX rates" / «לפי שערי מטבע» — short enough for the 11px chip in both languages.

## 3. Activity feed (Home strip + `/activity`)

- `useActivityFeed` gains cache awareness: on mount with a cache hit, `items` starts as the
  cached first page flagged `stale: true`; the real first page **replaces the stale list
  wholesale** when it lands (and writes the cache). Row markup is unchanged, so stale and fresh
  rows have identical heights — no jump on swap.
- While stale: a **small counting chip** (same glyph as the balance card's random pick, small
  size) sits on the section header — both on the Home strip and the `/activity` page header
  area. "Load more" stays hidden; pagination begins only from fresh state.
- Failure with cache: silent auto-retry with the same capped backoff; the existing
  failed-state UI appears only on a cache miss (unchanged from today: quiet on the Home strip,
  retry button on `/activity`).
- The hook's "in-memory only" doc comment is updated — persistence now exists, deliberately
  limited to the first page.

## 4. Contracts / config

- `packages/contracts`: add `wallet.countingIndicator` to the config-key schema and the
  `CONFIG_PUBLIC` allow-list, typed `"chip" | "hero"` with default `"chip"`.
- Admin console: the key becomes editable wherever runtime-config keys are edited today
  (no bespoke UI beyond the existing config editing surface).
- No API shape changes; no new endpoints; no infra changes.

## 5. i18n

New strings (en + he), all short enough for their slots:

| key | en | he |
|---|---|---|
| `home.counting` | Counting the money… | סופרים את הכסף… |
| `home.lastCounted` | Last counted: {amount} | נספר לאחרונה: {amount} |
| `home.estimated` (changed) | At current FX rates | לפי שערי מטבע |

## 6. Testing

- **stale-cache module**: per-sub keying, TTL expiry, version mismatch, corrupt JSON,
  storage-throws (get/set both), sign-out clearing.
- **State selection**: unit tests for the wallet card's five-row state table and for
  `useActivityFeed`'s stale-then-replace flow (cache hit → stale items → fresh replace;
  cache miss → today's behavior; failure with hit → still stale, retrying).
- **Config**: `wallet.countingIndicator` parse/fallback (junk value → `"chip"`).
- Animations are visual-only — covered by `pnpm lint` / `typecheck` / `build` (CI gates);
  no snapshot tests of keyframes.

## Out of scope

- Caching beyond the first activity page; offline mode; caching admin-console views
  (admin reads Aurora too but is an internal tool); any change to `member-wallet` or the
  API; service-worker/PWA caching.
