# ADR 0003 — Consumer attribution model (no click-log lookup)

- **Status:** Accepted
- **Date:** 2026-06-17
- **Context refs:** Solution Design Document §8.1, §9.1, §10.1, §18 #4; AWS Architecture (MVP) §3.3, §4
- **Related:** [ADR-0002](0002-conversion-ingestion-scheduled-poller.md) (the poller that resolves attribution)
- **Revises:** SDD's `click_id`-in-click-log resolution path

## Context

Crediting needs to resolve, per conversion, **who the referrer is** (always) and **who the
consumer is** (when attributable). The SDD's §8.1 design injected a per-click `click_id` and
resolved `click_id → consumer` against a click log — but clicks are written only to
Firehose → S3 (D7), which is an analytics store, not a fast transactional point-lookup. That
left the headline two-sided-reward feature with no efficient lookup path.

Key realisation: **attribution is decided at click-through, not at conversion time.** A
consumer reward only exists for *member*-attributed conversions, and in every such case we
already hold the consumer's `customer_id` at the instant we build the outgoing 301
(logged-in → auto-redirect; or anonymous → sign-up/login → then redirect). Guests earn
nothing, so there is nothing to attribute for them. AliExpress's
`aliexpress.affiliate.order.listbyindex` echoes back our injected `custom_parameters`
(JSON), so we can carry the identity we need on the order itself.

A naive "inject `customer_id` directly" drops one best-effort case: a guest who buys and then
**registers while the conversion is still open** (SDD §9.1 "attribute a still-open
conversion"). That is recovered with an opaque guest id carried in the existing first-party
cookie, mapped to the customer **at registration** (off the hot path).

## Decision

Resolve attribution entirely from values we inject into `custom_parameters` — **no click-log
lookup, no high-volume transactional click store.**

**At link generation:** the referrer's `short_id` is baked into the affiliate link as the
SubID (always present → referrer always resolvable).

**At click/redirect time**, append a consumer key to `custom_parameters`:
- **Authenticated consumer →** inject `customer_id` (`{ ref: short_id, c: customer_id }`).
  Resolves directly, no lookup. Also avoids the "logged-in on a fresh browser" gap.
- **Anonymous consumer →** inject an opaque, random **`guestId`** carried in the existing
  **30-day first-party attribution cookie** (SDD §9.1) (`{ ref: short_id, g: guestId }`).
  Opaque id → nothing internal leaks to AliExpress.

**At registration:** map the cookie's `guestId` → new `customer_id` in a small
`guest_attribution(guest_id PK, customer_id, linked_at)` table — **many-to-one** (a person
may accrue several `guestId`s across devices before registering). This write happens at
registration (low frequency), **not** on the redirect hot path — so the hot path stays
write-free to Postgres and D7 is preserved.

**At conversion (poller, ADR-0002) resolve `custom_parameters`:**
- `ref` → referrer (always).
- `c` present → consumer credited directly (member).
- else `g` present → `guest_attribution[g]` → consumer if mapped (member), else guest.
- neither → untracked.

This preserves the §10.1 three-way attribution (member / guest / untracked).

## Consequences

- The headline two-sided reward has a fast, transactional resolution path with **no click
  store on the hot path** and **no Athena-per-conversion**.
- No internal identifier leaks to AliExpress for guests (opaque `guestId`); members carry
  `customer_id` (opaque UUID, not PII — acceptable; swap to a per-purpose token if desired).
- **Retro-attribution is naturally bounded:** because the poller upserts by `order_id` and
  re-reads overlapping windows, a guest conversion is upgraded to member only if registration
  happens **while the order is still in the poll window** (still open). Closed/aged-out orders
  are not retro-credited — consistent with SDD §9.1.
- Adds a `guest_attribution` table (tiny) and a `customer_id`/`guestId` branch in the redirect.

## Dependencies / to confirm at integration

- AliExpress allows **appending a click-time value** to `custom_parameters` on the outgoing
  URL (the SubID is fixed at `link.generate`; the consumer key is added at redirect). SDD
  §8.1 already assumes this; verify on the `api-sg` gateway.
- **Cookie consent** gates setting `guestId` (SDD §18 #4). Declined → guest-no-reward fallback.
