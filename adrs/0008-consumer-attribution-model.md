# ADR 0008 — Consumer attribution model (no click-log lookup)

- **Status:** Accepted
- **Date:** 2026-06-28
- **Related:** [ADR-0007](0007-redirect-path-and-latency.md) (where attribution is injected), [ADR-0009](0009-conversion-ingestion-poller.md) (where it is resolved)

## Context

Each conversion must resolve **who the referrer is** (always) and **who the consumer is** (when
attributable), efficiently. Clicks are written only to Firehose → S3, an analytics store — not a
fast transactional point-lookup — so resolving a per-click `click_id → consumer` against a click
log has no efficient path.

The key realisation: **attribution is decided at click-through, not at conversion time.** A
consumer reward only exists for member-attributed conversions, and in every such case we already
hold the consumer's `customer_id` at the instant we build the outgoing `301` (logged-in →
auto-redirect; or anonymous → sign-up/login → then redirect). Guests earn nothing, so there is
nothing to attribute for them. The retailer echoes back our injected `custom_parameters` on the
order, so we can carry the identity we need on the order itself.

## Decision

Resolve attribution entirely from values injected into `custom_parameters` — **no click store.**

- **At link generation:** the referrer's `short_id` is baked into the affiliate link as the
  SubID (always present → referrer always resolvable).
- **At click/redirect:** append a consumer key — authenticated → `customer_id`
  (`{ ref: short_id, c: customer_id }`); anonymous → an opaque, random **`guestId`** carried in
  the 30-day first-party cookie (`{ ref: short_id, g: guestId }`). The opaque id leaks nothing
  internal to the retailer.
- **At registration:** map the cookie's `guestId → customer_id` in a small **DynamoDB**
  `guest_attribution` item — many-to-one (a person may accrue several `guestId`s across devices).
  It is **opaque→opaque (non-PII)** and **best-effort**, so it lives in DynamoDB, *outside* the
  atomic Aurora registration transaction. The redirect hot path neither reads nor writes it — the
  browser already carries `guestId` in its cookie; the mapping is written at registration and
  read at conversion.
- **At conversion (poller):** `ref` → referrer (always); `c` → member, credited directly; else
  `g` → `guest_attribution[g]` (a DynamoDB point lookup from the non-VPC poller-fetcher) →
  member if mapped, else guest; neither → untracked.

## Alternatives considered

- **`click_id → consumer` via a click log** — the click store is analytics-only (Firehose → S3);
  there is no fast transactional lookup, leaving the headline two-sided reward without a path.
- **Inject `customer_id` only (no guest id)** — drops one best-effort case: a guest who buys and
  then registers while the conversion is still open. The opaque cookie `guestId` recovers it.
- **Store `guest_attribution` in Aurora** — unnecessary: it's non-PII and best-effort, so it
  needs none of Aurora's ACID/immutability guarantees; keeping it in DynamoDB also preserves the
  option to resolve it on the (non-VPC) redirect path later.

## Consequences

- The two-sided reward has a fast, transactional resolution path with no click store on the hot
  path and no Athena-per-conversion.
- No internal identifier leaks to the retailer for guests; members carry an opaque `customer_id`.
- **Retro-attribution is naturally bounded:** because the poller upserts by `order_id` and
  re-reads overlapping windows, a guest conversion is upgraded to member only if registration
  happens while the order is still in the poll window. Closed/aged-out orders aren't retro-credited.
- The best-effort `guest_attribution` write can fail without affecting registration (the
  guest-no-reward fallback).
- **To confirm at integration:** the retailer allows appending a click-time value to
  `custom_parameters` on the outgoing URL (the SubID is fixed at `link.generate`; the consumer
  key is added at redirect). Cookie consent gates setting `guestId`.
