# ADR 0020 — Auth foundation: provisioning, kill switch, unified flow, and the auth-edge/core split

- **Status:** Accepted *(consolidated 2026-07-07: former ADR-0021 — the `app-api` split into a
  non-VPC auth edge + in-VPC core — is merged into this record; the original in-VPC `cognito-idp`
  endpoint decision it replaced is preserved under Alternatives)*
- **Date:** 2026-06-29 (split decided 2026-07-01; ticket signature asymmetric since 2026-07-07;
  consolidated 2026-07-07)
- **Refines (in part):** [ADR-0002](0002-app-compute-topology.md) (app-api becomes two functions),
  [ADR-0004](0004-network-topology-nat-free-egress.md) (non-VPC-edge pattern reused; no interface
  endpoints remain), [ADR-0006](0006-identity-sms-otp-and-passkeys.md) (kill-switch substrate +
  unknown-number handling)
- **Related:** [ADR-0003](0003-datastore-aurora-and-dynamodb.md),
  [ADR-0007](0007-landing-path-and-latency.md) (cookieless Bearer),
  [ADR-0022](0022-faceid-passkey-authentication.md) (passkeys)

## Context

Building UC1 (Onboard) and UC2 (Sign-in) turned the `/auth/*` stubs into the real flow against
Cognito + Aurora and stood up the deferred Aurora/VPC. Two forces shaped the final design:

1. Implementation surfaced decisions that refine assumptions baked into the locked architecture
   ADRs (provisioning timing, kill-switch substrate, unknown-number handling, identity join key,
   admin separation).
2. The first real `POST /auth/start` on dev failed at the Cognito lookup:
   > `InvalidParameterException: PrivateLink access is disabled for the user pool that has
   > ManagedLogin configured.`
   Three separately-accepted choices were **mutually exclusive on AWS**: an in-VPC NAT-free
   `app-api` reaching Cognito over PrivateLink; the customer pool using the new Managed Login
   (then believed required for discoverable passkeys); and AWS disabling PrivateLink on any
   Managed-Login pool. The auth flow already separated cleanly along a Cognito/Aurora seam, which
   the fix exploits.

## Decision

1. **No Cognito Post-Confirmation trigger; provision `customer` in `/auth/register`.**
   `customer.first_name`/`last_name` are `NOT NULL` and are only collected at `POST /auth/register`
   (after OTP verify), so a confirmation-time trigger fires too early to write a valid row. The
   `customer` row is inserted inside the `/auth/register` handler (single Aurora txn). The
   "authenticated vs registration_required" branch is decided by **"does a `customer` row exist for
   this Cognito `sub`?"**, removing the trigger→Aurora coupling entirely.

2. **`app-api` is split into two functions behind the one HTTP API, along its Cognito-vs-Aurora
   seam** (formerly ADR-0021):
   - **`app-auth` — a non-VPC "auth edge."** Serves everything that touches **only Cognito +
     DynamoDB**: `/auth/start|resend|verify|refresh|signout` and the passkey endpoints. Outside the
     VPC it reaches the Cognito control plane over the **public AWS endpoint** (no PrivateLink
     conflict) and DynamoDB (auth challenges, phone velocity, guest attribution, runtime config,
     passkey credentials) likewise. Holds scoped `cognito-idp` permissions; **no** Aurora access.
   - **`app-core` — the in-VPC "core."** Serves everything that touches **Aurora**:
     `/auth/session`, `/auth/register`, `/me`, `/me/*`, (later) wallet. IAM DB auth (ADR-0003). It
     calls **no** Cognito control-plane API and reads **no** secrets, so the VPC needs no interface
     endpoints at all; DynamoDB rides the free gateway endpoint. Profile edits that must propagate
     to a Cognito attribute are delegated to `app-auth`.

3. **The two are bridged statelessly by a signed registration ticket — Ed25519, asymmetric.**
   `/auth/verify` (`app-auth`) issues a self-contained ticket `{sub, phone, tokens, exp}` on OTP
   success — it does not decide login-vs-register, because that check needs an Aurora read the edge
   cannot do. The client exchanges it at **`/auth/session`** (`app-core`) for `authenticated` or
   `registration_required` (→ `/auth/register`). **No inter-Lambda invoke, no shared session
   store.** The signature is **asymmetric by design**: `app-auth` signs with the private key (a
   Secrets Manager secret it reads over the free public endpoint; the keypair is generated at
   deploy by an idempotent custom resource), while `app-core` verifies with the **public** key from
   a plain env var — verification needs no secret, which is what lets the VPC run with **zero paid
   interface endpoints**.

4. **SMS kill switch lives in the DynamoDB `config` store, not SSM/AppConfig.** A runtime-config
   key **`auth.smsEnabled`** (`@wanthat/contracts` `CONFIG_SCHEMAS`/`CONFIG_DEFAULTS`) is read via
   `RuntimeConfigRepo` before any Cognito SMS send — over infrastructure the app already uses. The
   detect-alarm and manual ops flip this key; the SNS `MonthlySpendLimit` hard cap (ADR-0006
   layer 4) is unchanged.

5. **The unified flow may SMS a previously-unseen number** (refines ADR-0006's "no OTP to unknown
   numbers"). A phone with no Cognito user is created on the fly (`AdminCreateUser(SUPPRESS)` +
   `AdminSetUserPassword(random, Permanent)`) and the OTP initiated, so `/auth/start` behaves
   identically for new and returning numbers. Enumeration-safety is preserved by **uniform response
   shape and timing** rather than by withholding the SMS; abuse stays contained by the per-phone
   velocity counter, the kill switch, WAF rate rules, and the SNS spend cap. A scheduled cleanup
   removes profile-less CONFIRMED users.

6. **`customer.cognito_sub` is the stable Cognito↔customer link.** Phone is mutable (it is the
   sign-in alias), so it is unsuitable as the join key. `cognito_sub text NOT NULL` + unique index;
   `/auth/register` inserts with `ON CONFLICT (cognito_sub) DO NOTHING` for idempotency. NOT NULL
   is deliberate fail-fast: a missing sub is a bug the DB rejects at INSERT rather than persisting
   an unlinkable PII row.

7. **Two Cognito pools, split by population — customers vs. employees.** Staff get a separate
   `employeePool`: no self-signup, email + mandatory TOTP MFA (off the SMS-abuse surface), its own
   hosted UI. The admin API authorizer points at this pool, so a customer token **structurally
   cannot** reach `/admin` (the in-handler `admin`-group check stays as defence-in-depth).
   First-admin bootstrap is one audited `admin-create-user` + `admin-add-user-to-group`.

## Alternatives considered

- **In-VPC Lambdalith calling Cognito over a `cognito-idp` interface endpoint** — the original
  design. Failed on a hard platform rule: PrivateLink is disabled for Managed-Login pools (the
  error above), and Managed Login was then required for discoverable passkeys. Even setting that
  aside it carried a standing per-AZ endpoint cost. Replaced by the split (decision 2).
- **Drop Managed Login from the customer pool** — would have restored PrivateLink and kept one
  in-VPC Lambdalith, but was believed to forfeit discoverable passkey login, a product requirement.
  (Later, ADR-0022's custom WebAuthn removed the Managed-Login dependency anyway — but the split
  stands on its own merits: least privilege, no interface endpoints, no NAT.)
- **A non-VPC `cognito-proxy` invoked by the in-VPC Lambdalith** — keeps the Lambdalith whole but
  adds a Lambda interface endpoint, a per-call invoke hop, and reverses the established
  non-VPC-edge pattern. Rejected.
- **NAT Gateway** — simplest code, but abandons the NAT-free principle (ADR-0004) and adds standing
  cost. Rejected.
- **Symmetric HMAC ticket (both functions read the shared key)** — the original bridge. Worked, but
  forced the in-VPC verifier onto a paid Secrets Manager interface endpoint just to read a key
  whose only job is verification. Replaced by Ed25519: the verifying key is public material and
  ships as env config; only the non-VPC signer holds a secret.
- **Post-Confirmation trigger writing a placeholder `customer`** — needs nullable/placeholder PII
  columns and complicates the registered/unregistered distinction; rejected.
- **SSM/AppConfig kill switch (as ADR-0006 sketched)** — would have cost another in-VPC interface
  endpoint for no functional gain over a DynamoDB key. Rejected.
- **Withholding OTP from unknown numbers** — leaks which numbers are registered via
  response/timing differences unless carefully equalised anyway; rejected in favour of uniform
  responses + abuse controls.
- **One pool, admins as an `admin` group** — couples privileged staff access to the customer pool's
  abuse surface and reduces the boundary to an in-handler claim check; rejected.

## Consequences

- `app-api` is **two functions** — `app-auth` (non-VPC) and `app-core` (in-VPC) — behind one HTTP
  API; the JWT authorizer and CORS span both route groups.
- **Zero paid VPC interface endpoints**: `cognito-idp` was never re-added after the split, and the
  `secretsmanager` endpoint was removed once ticket verification went asymmetric and the
  db-migrator moved to IAM DB auth (`wanthat_migrator`, migration `0003`). The VPC's only AWS
  dependencies are Aurora (in-VPC) and DynamoDB (free gateway endpoint).
- **Tighter least privilege**: `app-auth` = Cognito + DynamoDB + the private signing key, no
  Aurora; `app-core` = Aurora + DynamoDB, no Cognito, no secrets.
- The registration ticket is the sole cross-function contract; key rotation is a three-step deploy
  (add new public key to the verifier's array → flip the signer → drop the old key). Tickets are
  seconds-lived.
- `/auth/start` can create Cognito users → pool pollution from probing; mitigated by the scheduled
  cleanup + velocity counter. The kill switch is one cached DynamoDB read on `/auth/start`.
- `customer.cognito_sub` is the canonical identity join key for `/me` and member-scoped reads.
- Passkey enrolment/login evolved separately — see [ADR-0022](0022-faceid-passkey-authentication.md)
  (custom WebAuthn on `app-auth`; the Managed-Login dependency this ADR originally assumed is gone).
