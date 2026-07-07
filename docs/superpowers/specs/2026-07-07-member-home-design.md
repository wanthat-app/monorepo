# Member Home (wallet dashboard) — design

**Date:** 2026-07-07
**Status:** approved for planning
**Slice:** one deployable use-case slice (contracts + app-core + SPA), per the PR-slice convention.

## User story

A signed-in member lands on Home and sees their wallet — estimated-ILS headline, holdings,
pending note, recent activity — fetched from the authenticated wallet endpoints. Create
link, Activity, Profile, "See all", and Withdraw are visible per the design but
intentionally non-functional this slice. The Face ID prompt card keeps today's
working passkey enrolment.

The backend this slice is a **stub with the real contract**: `GET /wallet` returns a fixed
₪0.00 wallet and `GET /wallet/entries` an empty page. The SPA wiring is end-to-end real (the
numbers come from the endpoint, not the client), but the ledger queries, FX-estimate math,
and the final wallet schema are deferred to the AliExpress conversion-poller slice — the
first thing that actually writes wallet entries.

## Design reference

`design/design_handoff_wanthat_app/designs/Wanthat Wallet - Flow.dc.html` — the **Home**
screen (README §Wallet flow #4). High fidelity; copy for both locales lifted from the file's
`T` dictionary. The design-system components shipped in PR #98 (`BalanceCard`, `ActivityRow`,
`PromptCard`, `TopNav`, `TabBar`, `Avatar`) are already mock-faithful, including skeleton
loading states.

## Contracts (`packages/contracts`)

`GET /wallet` — extend `GetWalletResponse` with a display-estimate block; `balances` is
unchanged:

```ts
export const WalletEstimate = z.object({
  available: Money, // ILS
  pending: Money,   // ILS
});

export const GetWalletResponse = z.object({
  balances: z.array(WalletBalance),      // unchanged: real per-currency truth
  estimated: WalletEstimate.nullable(),  // null when any held currency lacks an FX rate
});
```

- The block is an **estimate for display** (design: `≈` prefix + "Estimated" chip); settled
  money stays per-currency in `balances`. The contract's job is only to mark the block as
  estimate; presentation (`≈`, chip) is the SPA's.
- `estimated` is `null` when a held currency has no cached FX rate — fail honest; the SPA
  then shows holdings only, no headline estimate.
- `GET /wallet/entries` (`ListWalletEntriesQuery` = `PageQuery`, response = `page(WalletEntry)`)
  is already fully specified — no change.

## Backend — stub endpoints with the real contract

app-core replaces the wallet 501 stubs with two authenticated routes (same customer
resolution by Cognito `sub` as `/me` — the auth guard is real, only the data is canned):

- `GET /wallet` — returns the fixed empty wallet:
  `{ balances: [], estimated: { available: ₪0, pending: ₪0 } }` (a zero estimate needs no FX
  rate, so `estimated` is non-null here). Zod-parsed through `GetWalletResponse` on the way
  out, so the stub cannot drift from the contract.
- `GET /wallet/entries` — parses `PageQuery` (validation is real), returns
  `{ items: [], nextCursor: null }`.

**Deferred to the AliExpress conversion-poller slice** (the first writer of wallet entries):
the `wallet_entry` aggregation queries, `packages/db/src/wallet.ts`, the FX-rate read +
estimate math in app-core, and any wallet-schema finalisation the poller needs. The route
handlers and the SPA won't change shape when the stub becomes real — only the handler
internals do.

### Infra

- **No infra changes.** No FX table access, no new grants, no new packages (the
  bundled-workspace-deps trap doesn't fire).
- API routes: `GET /wallet` and `GET /wallet/entries` are new **GET** routes on the app HTTP
  API — CORS `allowMethods` already includes GET (checked; the PR #103 lesson).

## Frontend (`apps/web`)

Rebuild `features/home/HomePage.tsx` on the design system:

- **Shell:** desktop `TopNav` (wordmark, Home active, Activity link, green **Create link**
  button, avatar) / mobile `TabBar` (Home, Activity, Profile) + create affordance. All inert
  except Home this slice; future pages plug into the same shell. Extracted as a reusable
  authenticated-shell component so Activity/Profile/Create pages reuse it.
- **Sign-out stays reachable** even though Profile is inert: avatar menu on desktop, the
  profile tab placeholder area on mobile. (The design parks sign-out in Profile; we don't
  drop it in the meantime.)
- **BalanceCard:** skeleton while loading → estimated-ILS headline with `≈` + "Estimated"
  chip, per-currency holdings chips (from `balances[].available`), "held in original
  currencies" note, `≈` pending note (from `estimated.pending`), mint **Withdraw cash** CTA
  (present, disabled/no-op). When `estimated` is null: holdings chips only, no headline.
- **Face ID `PromptCard`:** shown when passkeys are supported and not enrolled (today's
  local-state behaviour, restyled per design); triggers the existing `enrollPasskey` flow.
- **Recent activity:** up to 4 `ActivityRow`s from `GET /wallet/entries?limit=4`, each with
  a status label (confirmed/pending) and the entry's **real source-currency amount**. The
  design's dual-amount display (estimated ILS large over the real amount) needs per-entry
  estimates, which this slice does not compute — that refinement lands with the Activity
  slice. "See all" link present, inert. Empty ledger → "no activity yet" empty state.
- **API client:** extend `lib/api.ts` with `getWallet` / `listWalletEntries` (Bearer, Zod
  parse — same shape as existing member calls).
- **i18n:** EN + HE keys for every new string, lifted from the design `T` dictionary; money
  rendered LTR/tabular with leading ₪ (DS already enforces this inside `BalanceCard` /
  `ActivityRow`).

## States & errors

- **Loading:** DS skeletons (BalanceCard skeleton + activity-row skeletons).
- **API failure:** inline error with retry, same pattern as admin `UsersView`.
- **Empty wallet (the only data state the stub produces):** `≈₪0.00` headline, no holdings
  chips, empty-state activity.
- **`estimated: null` (contract case):** the SPA still implements the fallback — holdings-only
  card, no estimate headline — even though the stub never returns it; the real backend will.

## Testing

- **app-core:** handler tests mirroring `admin-api/handler.test.ts`: both routes return the
  contract-valid stub shapes, `PageQuery` validation (bad `limit` → 400), auth guard.
- **SPA:** i18n completeness (both locales), component render states if the existing test
  setup covers components (lib-level tests exist; no component harness is added just for
  this).
- **Verification:** `pnpm typecheck && pnpm test && pnpm synth`, `cdk diff` before deploy;
  after merge+deploy, sign in on dev → Home shows zeros/empty from the real endpoint (network
  tab shows `/wallet` + `/wallet/entries` 200s).

## Out of scope (lands in later slices)

- **Real wallet reads** — `wallet_entry` aggregation, `packages/db/src/wallet.ts`, FX-rate
  read + ILS-estimate math, wallet-schema finalisation: all land with the AliExpress
  conversion-poller slice (the first writer of wallet entries).
- Create link flow, Activity page, Profile page, Withdraw flow (all inert affordances here).
- Per-entry ILS estimates (activity rows' dual-amount display).
- Passkey-existence from the server (prompt card uses local heuristics for now).
- Live FX-rate freshness UI (staleness indicators etc.).
