# ADR 0008 — Consumer attribution model (no click-log lookup)

- **Status:** Accepted
- **Date:** 2026-06-28
- **Related:** [ADR-0007](0007-landing-path-and-latency.md) (where attribution is injected), [ADR-0009](0009-conversion-ingestion-poller.md) (where it is resolved)

## Context

Each conversion must resolve **who the referrer is** (always) and **who the consumer is** (when
attributable), efficiently. Clicks are written only to Firehose → S3, an analytics store — not a
fast transactional point-lookup — so resolving a per-click `click_id → consumer` against a click
log has no efficient path.

The key realisation: **attribution is decided at click-through, not at conversion time.** A
consumer reward only exists for member-attributed conversions, and in every such case the
consumer's identity is available client-side at click time (the SPA holds the JWT; the app is
cookieless — ADR-0008/0007). Guests earn nothing, so there is nothing to attribute for them. The
retailer echoes back our injected `custom_parameters` on the order, so we can carry the identity
we need on the order itself.

## Decision

Resolve attribution entirely from values injected into `custom_parameters` — **no click store.**

- **At link generation:** nothing referrer-specific is baked — the affiliate URL is **product-level**
  (one `link.generate` per product, shared across everyone who recommends it). The recommendation
  that points at it carries the referrer (its owner) **and a snapshot of the cashback split rates**
  (referrer/consumer bps) taken from the CONFIG policy at creation — so the link's economics are
  locked and later policy changes affect only new links.
- **At click/redirect (client-driven resolve, ADR-0007):** append the whole `custom_parameters` —
  `ref` (the `recommendation_id`, always) **plus** the consumer key: member → the client sends its
  Bearer token and the resolve endpoint injects the member's canonical id — the Cognito `sub`
  (ADR-0020) — as `{ ref, c: sub }`; guest → the client sends an opaque, random **`guestId`** from
  **localStorage** and the endpoint injects it (`{ ref, g: guestId }`). Opaque ids only — nothing
  internal leaks to the retailer.
- **At registration:** map `guestId → sub` (the canonical id, ADR-0020) in a small **DynamoDB**
  `guest_attribution`
  item — many-to-one (a person may accrue several `guestId`s across devices). It is
  **opaque→opaque (non-PII)** and **best-effort**, so it lives in DynamoDB, *outside* the atomic
  Aurora registration transaction. The redirect path neither reads nor writes it — the client
  already holds `guestId` in localStorage; the mapping is written at registration and read at
  conversion.
- **At conversion (poller):** `ref` (the `recommendation_id`) → look up the recommendation → its
  **referrer** (owner) + **product** (always resolvable); `c` → member consumer, credited directly;
  else `g` → `guest_attribution[g]` (a DynamoDB point lookup from the non-VPC Retailer Proxy) →
  member if mapped, else guest; neither consumer key → untracked.

## Alternatives considered

- **`click_id → consumer` via a click log** — the click store is analytics-only (Firehose → S3);
  there is no fast transactional lookup, leaving the headline two-sided reward without a path.
- **Inject `customer_id` only (no guest id)** — drops one best-effort case: a guest who buys and
  then registers while the conversion is still open. The opaque `guestId` (localStorage) recovers it.
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
- **To confirm at integration:** the retailer reliably **round-trips redirect-appended
  `custom_parameters`** — both `ref` and the consumer key are added at the resolve step onto a
  **product-level** affiliate URL (nothing per-referrer is baked at `link.generate`). `guestId`
  lives in first-party `localStorage` (functional storage), not a cookie — consent-gated before set.
