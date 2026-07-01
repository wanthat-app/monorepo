# ADR 0021 — app-api split: non-VPC auth edge + in-VPC core (resolve Managed Login vs PrivateLink)

- **Status:** Accepted
- **Date:** 2026-07-01
- **Supersedes (in part):** [ADR-0020](0020-auth-foundation.md) decision 2 (in-VPC `cognito-idp`
  egress — the Lambdalith no longer calls Cognito from in-VPC)
- **Refines:** [ADR-0002](0002-app-compute-topology.md) (compute topology — app-api becomes two
  functions), [ADR-0004](0004-network-topology-nat-free-egress.md) (network — reuses the non-VPC-edge
  pattern, removes an interface endpoint)
- **Related:** [ADR-0006](0006-identity-sms-otp-and-passkeys.md), [ADR-0003](0003-datastore-aurora-and-dynamodb.md)

## Context

The first real `POST /auth/start` on dev failed at the Cognito lookup:

> `InvalidParameterException: PrivateLink access is disabled for the user pool that has ManagedLogin
> configured.`

Three separately-accepted choices are **mutually exclusive on AWS**:

1. `app-api` is **in-VPC, NAT-free** (ADR-0004) and reaches Cognito over the **`cognito-idp`
   PrivateLink interface endpoint** (ADR-0020 decision 2).
2. The **customer pool uses the new Managed Login** hosted UI, required for **discoverable / userless
   passkey login** (ADR-0020 consequences; ADR-0006).
3. **AWS disables PrivateLink access to any user pool configured with the new Managed Login.**

Discoverable passkey login is a **product requirement, not deferrable**, so Managed Login stays on the
customer pool. Therefore `app-api`'s Cognito calls **cannot** use PrivateLink and must egress another
way — **without** a NAT (ADR-0004) and **without** exposing Aurora (ADR-0003). The auth flow already
separates cleanly along a Cognito/Aurora seam, which the fix exploits.

## Decision

Split the `app-api` Lambdalith into **two functions behind the one HTTP API**, along its existing
Cognito-vs-Aurora seam:

1. **`app-auth` — a non-VPC "auth edge."** Serves the endpoints that touch **only Cognito + DynamoDB**:
   `/auth/start`, `/auth/resend`, `/auth/verify`, `/auth/refresh`, `/auth/signout`, and the passkey
   register/authenticate endpoints. It runs **outside the VPC**, so it reaches the Cognito control
   plane — including the Managed-Login pool — over the **public AWS endpoint** (no PrivateLink, no
   conflict), and DynamoDB (auth challenges, phone-velocity, guest attribution, runtime config) over
   the public endpoint. Holds the scoped `cognito-idp` permissions; holds **no** Aurora access.

2. **`app-core` — the in-VPC "core."** Serves the endpoints that touch **Aurora**: `/auth/register`,
   `/me`, `/me/*`, and (later) wallet. Stays **in-VPC** with IAM DB auth (ADR-0003) and reserved
   concurrency. It calls **no** Cognito control-plane API, so it needs no Cognito egress — the
   `cognito-idp` interface VPC endpoint is **removed**. DynamoDB (e.g. `/me/attribution/claim`) is
   reached over the existing free gateway endpoint. Profile edits that must propagate to a Cognito
   attribute (e.g. email change) are delegated to `app-auth`, keeping `app-core` Cognito-free.

3. **The two are bridged statelessly by the HMAC registration ticket.** `/auth/verify` (`app-auth`)
   issues the existing self-contained HMAC ticket `{sub, phone, tokens, exp}`; `/auth/register`
   (`app-core`) **validates it independently** and inserts `customer`. **No inter-Lambda invoke, no
   shared session store** — the HTTP API routes each path to the correct function and the signed
   ticket is the only handoff. Both functions `grantRead` the `AUTH_TICKET_SECRET`.

4. **Managed Login is retained on the customer pool.** Discoverable passkey login stays browser →
   hosted UI → Cognito (public), exactly as ADR-0020 described. The split is precisely what lets
   API-driven OTP and Managed-Login passkeys coexist on the **same** pool.

This **supersedes ADR-0020 decision 2**: the Lambdalith no longer calls Cognito from in-VPC, and the
`cognito-idp` interface endpoint is deleted.

## Alternatives considered

- **Drop Managed Login from the customer pool (Direction 1)** — restores PrivateLink and keeps one
  in-VPC Lambdalith, but loses discoverable/userless passkey login, a product requirement. Rejected.
- **A non-VPC `cognito-proxy` invoked by the in-VPC Lambdalith (Direction 3)** — keeps the Lambdalith
  whole but adds a **Lambda** interface VPC endpoint (for the in-VPC→Lambda invoke), a per-call invoke
  hop of latency, and the *reverse* of the established non-VPC→in-VPC pattern. More moving parts for
  the same outcome. Rejected.
- **NAT Gateway** — simplest code (the in-VPC Lambdalith calls Cognito publicly), but abandons the
  NAT-free principle (ADR-0004) and adds standing cost. Rejected.

The split (B) **reuses** ADR-0004's non-VPC-edge + in-VPC-writer pattern, needs **no** new endpoint
(and removes one), and adds **no** latency (routes go direct to the right function) — so it is
preferred over 3 and NAT.

## Consequences

- `app-api` is now **two functions** — `app-auth` (non-VPC) and `app-core` (in-VPC) — behind one HTTP
  API; the JWT authorizer and CORS config span both route groups (`app-auth` open on `/auth/*`;
  `app-core` behind the authorizer on `/me/*`, plus the public `/auth/register`).
- **Net one fewer paid interface endpoint**: `cognito-idp` is removed; `secretsmanager` stays for
  `app-core` (Aurora master/CA). Reverses ADR-0020's "one new paid endpoint."
- **Tighter least privilege**: `app-auth` holds Cognito + DynamoDB + the ticket secret and **no**
  Aurora; `app-core` holds Aurora IAM auth + DynamoDB and **no** Cognito — a cleaner split than the
  combined Lambdalith's superset role.
- **Discoverable passkeys + WhatsApp/SMS OTP now coexist** on one customer pool.
- The **registration ticket is the sole cross-function contract**; rotating its HMAC secret must
  update both functions (both already `grantRead` it).
- Container-cached clients split by function (Cognito/DocClient in `app-auth`; Kysely in `app-core`),
  shrinking each cold-start's dependency surface. A user's onboarding crosses the two functions once,
  via the stateless ticket — no session affinity needed.
- `app-auth` reaches Cognito/DynamoDB/Secrets over public AWS endpoints — still **IAM-authenticated
  and TLS**; it is not internet-*ingress* (only the HTTP API is), so no new inbound surface.
