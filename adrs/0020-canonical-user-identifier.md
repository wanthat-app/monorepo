# ADR 0020 — Canonical user identifier: the Cognito `sub`

- **Status:** Accepted
- **Date:** 2026-07-09
- **Related:** [ADR-0003](0003-datastore-aurora-and-dynamodb.md) (datastore), [ADR-0008](0008-consumer-attribution-model.md) (attribution), [ADR-0006](0006-cognito-native-auth-and-pii.md) (auth + PII)

## Context

Two user identifiers had crept into the system: the Cognito `sub` (present in every verified JWT)
and the Aurora `customer.id` (the relational row's uuid PK). Different seams picked whichever was
at hand — recommendations stored the sub, guest attribution stored `customer.id`, the attribution
`custom_parameters` spec said `customer_id`. Two interchangeable-looking uuids for the same person
is a standing invitation for cross-wiring bugs, and resolving `sub → customer.id` requires an
Aurora read — which the non-VPC edge functions (links module, landing) deliberately cannot make
(ADR-0004).

## Decision

**The Cognito `sub` is the single canonical user identifier everywhere outside Aurora's own
foreign keys**: DynamoDB items (`recommendation.ownerId`, `guest_attribution` mapping target),
attribution `custom_parameters` (`c` = sub), invoke payloads, events, and logs.

- Every service gets the sub for free from the gateway-verified JWT — no datastore read, so
  Aurora-free paths stay Aurora-free.
- Since ADR-0006 there is no `customer` table: Aurora money rows (`wallet_entry`,
  `audit_log`) are keyed **directly by the sub**. Anything crossing a service or store
  boundary carries the sub; no resolution step exists.
- Both are opaque uuids; neither is PII (ADR-0008 posture unchanged).

## Alternatives considered

- **`customer.id` everywhere** — needs an Aurora read (or a custom JWT claim maintained via
  Cognito attribute writes) on paths that must not touch Aurora; more moving parts for no gain.
- **Keep both ad hoc** — the status quo this ADR ends.

## Consequences

- A future Cognito pool migration would rotate subs and require a re-mapping pass over the
  sub-keyed money rows — accepted.
- The conversion poller writes ledger rows keyed by the `c`/attributed sub directly.
