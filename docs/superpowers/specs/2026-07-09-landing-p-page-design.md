# Landing `/p/` page — real render, attributed redirect, funnel analytics

**Date:** 2026-07-09
**Status:** Approved (design review with Dennis, 2026-07-09)
**Slice:** replaces the mock `/p/` landing (server + SPA) with the real ADR-0007/0008 flow, and lands the deferred funnel-analytics pipeline.

## Context

Today both halves of `/p/{recommendationId}` are mock:

- `services/landing` serves the SPA shell with a hardcoded `MOCK_PRODUCT` in the OG tags
  and bot snapshot; it never reads DynamoDB (`services/landing/src/handler.ts`,
  `landing-page.ts`).
- `apps/web` `SharedProductPage` renders a hardcoded product and sends everyone
  (member or guest) to `https://www.aliexpress.com/` with no attribution.
- The `Resolve*` and `GetLandingResponse` contracts exist in
  `packages/contracts/src/landing/` but no service implements them.
- Funnel events are `console.log`-ed but the CloudWatch Logs -> Firehose -> S3 -> Athena
  pipeline is explicitly deferred (`infra/lib/observability-stack.ts`), so they land nowhere.

Governing decisions: ADR-0007 (cookieless client-driven resolve, p95 < 500ms, OG injection,
funnel events via log subscription), ADR-0008 (attribution decided at click-through via
`custom_parameters`: `ref` + `c`/`g`; guestId in localStorage is consent-gated; the redirect
path never touches `guest_attribution`), ADR-0009 (conversion via scheduled poller).

## 1. Server render — `GET /p/{recommendationId}` (landing Lambda)

One DynamoDB `GetItem` on the `recommendation` projection, then the SPA shell is returned
with three injections:

1. **OG/Twitter tags** from real data: `og:title` = product title, `og:image` = absolute
   HTTPS product image, description = referrer review text, else the cashback disclosure
   line. Same page for bots and humans — no user-agent sniffing (SDD F3-R9).
2. **Server-rendered product content in `#root`** — the real human-visible card: image,
   title, ILS price, "earn X cashback", "<FirstName> recommends this" + review quote,
   using the same Tailwind token classes as the SPA so the page is content-first before
   any JS executes. This replaces the current bot-only snapshot.
3. **`window.__WANTHAT_LANDING__`** — a `GetLandingResponse`-shaped JSON snapshot
   (`LandingView` + `countdownSeconds`). The SPA Zod-validates it and mounts the identical
   card over the server markup (no visual flash), then adds the auth module beneath.

Details:

- **ILS display:** price/cashback are converted for display via the `fx_rate` table
  (landing already holds the read grant) using the same domain estimate helper the
  create-link flow uses. Estimates are display-only, never stored (contracts
  `CashbackEstimate`).
- **Countdown config:** `landing.countdownSeconds` is read from `runtime_config`
  per request with a short (~30s) in-memory cache. It is already editable in the admin
  panel (generic runtime-config panel, `PUT /admin/config/:key`), so changes take effect
  without a deploy.
- **Not found:** HTTP 200 with a `notFound: true` snapshot and generic OG tags — a real
  404 would be swallowed by CloudFront's distribution-wide 403/404 -> `/index.html`
  rewrite. The SPA renders a "link not found" state.
- **Impression event** (already emitted) now carries the real recommendationId; emitted
  on render only, as structured `console.log` (ADR-0007 — never an un-awaited PutRecord).
- `SITE_ORIGIN` stays env-configured, never derived from request headers.

## 2. Client-driven resolve — `POST /p/{recommendationId}/resolve` (same landing Lambda)

Implements the existing contracts `ResolveParams` / `ResolveBody` / `ResolveResponse`.
Non-VPC, no JWT authorizer (would break anonymous, ADR-0007); same-origin from the SPA
via CloudFront `/p/*`, so no CORS or preflight.

- **Member:** `Authorization: Bearer` verified **offline** with `aws-jwt-verify`
  (JWKS cached across invocations; the hot path never calls Cognito synchronously).
  Attribution params: `{ ref: recommendationId, c: sub }`.
- **Guest:** validated opaque `guestId` in the body -> `{ ref, g: guestId }`.
- **Neither, or invalid/expired token:** `{ outcome: "authRequired" }`.
- Params are appended to the **stored** `RecommendationItem.affiliateUrl` by a new pure
  helper in `packages/domain` (unit-tested). Open-redirect safe: the URL only ever comes
  from the projection item (SDD F3-R7). `affiliateUrl` itself is never exposed by any
  read API — only the resolved redirect URL leaves the server.
- Emits the **click** `FunnelEvent` (structured `console.log`) with
  `consumer: member | guest`; click is logged only on redirect-through.
- Returns `{ outcome: "redirect", url }`; the SPA performs the navigation.

## 3. Referrer first name — projection change

`RecommendationItem` gains `referrerFirstName: string | null`, written by `app-links` at
`POST /recommendations`:

- Source: the caller's token claims if `given_name` is present; otherwise one Cognito
  `GetUser` at creation time. Link creation is low-frequency — a creation-time Cognito
  call is acceptable; the redirect hot path is untouched. (Which token the app SPA sends
  to app-links is verified during implementation; that determines which source fires.)
- `LandingView` contract gains nullable `referrerFirstName`.
- Existing dev links lack the field -> landing falls back to generic copy
  ("Someone sent you a cashback link"). No backfill.

## 4. SPA — `SharedProductPage` rewrite

- Hydrates from `window.__WANTHAT_LANDING__` (Zod-validated). If absent or id-mismatched
  (client-side navigation edge case), forces a full page load of `/p/{id}` so the server
  renders it.
- Renders with design-system components (`ProductCard`, `AttributionChip`,
  `RecommendationQuote`) instead of the current inline card. Content-first rule stands:
  the product card never waits on auth.
- **Signed-in member:** redirect interstitial per the design handoff ("Taking you to
  AliExpress...", "You'll earn X on this order"), auto-redirect after `countdownSeconds`
  (admin-configured, default 3), plus an immediate "Continue to AliExpress" button.
  Calls resolve with Bearer.
- **Returning passkey device:** existing armed auto-prompt stays; after login the member
  path runs.
- **Anonymous:** content-first, no auto-redirect. CTAs: "Sign up & earn X" / "Log in"
  (existing `/auth?...&ref={id}` routes) and "Continue as guest — no cashback" with a
  one-line consent notice on the CTA. Clicking guest **is** the consent (ADR-0008
  consent gate): mint `crypto.randomUUID()` guestId -> localStorage -> resolve with
  `g=` -> redirect. No separate consent banner.
- `notFound` snapshot -> "link not found" state.

## 5. Funnel analytics pipeline (new infra)

ADR-0007's chosen shape: structured `console.log` -> CloudWatch Logs subscription filter
-> Kinesis Firehose -> S3 -> Athena.

- **Contracts:** add `ConversionEvent` to the `FunnelEvent` union now (fields aligned
  with ADR-0009: recommendationId, attribution outcome, order reference, amount, at) so
  the Athena schema is stable before the poller slice starts emitting it.
- **Infra (observability stack):**
  - Analytics S3 bucket with lifecycle rules.
  - One Firehose delivery stream + a small processor Lambda that unwraps the gzipped
    CloudWatch Logs envelope into one JSON event per line, partitioned by event date.
  - Subscription filters on the **landing** log group (impression + click) and the
    **conversion-poller** log group (same `$.type` pattern) — conversion events flow
    through the same pipe the day the poller emits them, with no infra change in that
    slice.
- **Athena:** Glue database + table defined in CDK with date partition projection, so
  queries work immediately after deploy.
- All new AWS description fields ASCII-only, no parentheses (WAFv2/EC2 charset traps).
- Firehose -> S3 is in the CLAUDE.md region stack list for il-central-1; `pnpm synth`
  and `cdk diff` confirm before deploy.

## 6. Infra and plumbing

- Landing fn: add `@wanthat/dynamo` (table grants already exist; wire table-name env
  vars), Cognito user-pool + client IDs for offline JWT verification.
- Any newly bundled `packages/*` import must appear in `infra` devDependencies
  (filtered turbo Deploy-build trap); a red Check Deploy is blocking.
- No new stacks; observability stack gains the analytics constructs. Watch cross-stack
  export ordering if any exports change (deploy consumers first).
- No CORS changes (same-origin). No SG or description edits to existing resources.

## 7. Error handling summary

| Failure | Behavior |
|---|---|
| Recommendation not found | 200 shell, `notFound` snapshot, generic OG, SPA not-found state |
| DynamoDB error on render | 200 shell, `notFound` snapshot, generic OG. The server **always** injects a snapshot — a truly absent snapshot only happens on SPA client-side navigation, so the §4 force-reload cannot loop |
| Invalid/expired Bearer on resolve | `authRequired` outcome (SPA refreshes session or shows login) |
| Malformed guestId | 400 (Zod validation at the boundary) |
| Resolve DynamoDB error | 500 JSON; SPA shows retryable error on the CTA |

## 8. Testing

- **Landing handler:** OG injection with real data + HTML escaping, notFound flow,
  DynamoDB-error fallback, resolve outcomes (member / guest / none / invalid token),
  click emission, open-redirect safety, snapshot shape matches `GetLandingResponse`.
- **Domain:** attribution-param URL helper (append to URLs with/without existing query).
- **app-links:** `referrerFirstName` written from claims / GetUser fallback.
- **SPA:** three consumer states, guest consent -> localStorage -> resolve call,
  countdown skip button, snapshot-missing full reload, notFound state.
- `pnpm lint` (biome) + `pnpm typecheck` + `pnpm test` + `pnpm synth` before each PR;
  `cdk diff` before deploy.

## 9. PR slicing (each independently deployable, opened ready — not draft)

- **PR A — referrer name denorm:** contracts (`LandingView.referrerFirstName`,
  `ConversionEvent`), dynamo item + repo, app-links write. Invisible; unblocks B/C.
- **PR B — real landing render:** landing reads DynamoDB, real OG + server-rendered
  card + snapshot; SPA hydrates real data (redirect still legacy/mock).
- **PR C — attributed redirect:** resolve endpoint + domain URL helper + SPA member
  countdown / guest consent flows + click event.
- **PR D — analytics pipeline:** Firehose + S3 + processor + Glue/Athena + subscription
  filters. Independent of B/C; can land in parallel after A.

## 10. Open items (flagged, non-blocking)

1. Which token the app SPA sends to app-links (`given_name` claim vs creation-time
   `GetUser`) — verified in PR A.
2. ADR-0008's own integration caveat: AliExpress must round-trip redirect-appended
   `custom_parameters`. First real click on dev confirms; the conversion slice depends
   on it.
3. Admin SPA config panel is generic and should list `landing.countdownSeconds`
   automatically — visually confirmed during PR B/C verification.
