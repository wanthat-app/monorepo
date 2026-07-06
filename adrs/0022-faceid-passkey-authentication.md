# ADR 0022 — FaceID authentication: passkeys — enrolment, automatic biometric login, Cognito bridge

- **Status:** Accepted *(consolidated 2026-07-07: former ADR-0024 — custom discoverable WebAuthn +
  automatic login + the admin token exchange — is merged into this record; the Cognito-native login
  flows it replaced are preserved under Alternatives)*
- **Date:** 2026-07-01 (login redesigned 2026-07-05; auto-prompt + focus-arming shipped 2026-07-06;
  consolidated 2026-07-07)
- **Refines:** [ADR-0006](0006-identity-sms-otp-and-passkeys.md) (passkeys as a first-auth factor),
  [ADR-0020](0020-auth-foundation.md) (passkey endpoints on the non-VPC `app-auth`),
  [ADR-0003](0003-datastore-aurora-and-dynamodb.md) (non-PII DynamoDB table)
- **Related:** [ADR-0007](0007-landing-path-and-latency.md) (cookieless; the `/p/` landing is a
  login surface), [ADR-0016](0016-frontend-stack.md)

## Context

"FaceID" is not a new auth channel — it is the **platform-authenticator** variant of WebAuthn: the
OS biometric (Face ID / Touch ID / Windows Hello / Android fingerprint) unlocks a **passkey** bound
to the site origin. The product vision: *visit → biometric → in; an "enable" prompt when not
enrolled; the label matches the device.*

Getting there surfaced three hard platform facts:

1. **Cognito cannot start a userless ceremony.** Its raw `USER_AUTH`/`WEB_AUTHN` challenge requires
   a username first, but WebAuthn **conditional UI** (the passkey offering itself) and any userless
   modal `get()` need a challenge **before** the username is known — and Cognito never exposes the
   stored public key, so it cannot verify an assertion it didn't challenge. Cognito-native
   verification and automatic login are mutually exclusive.
2. **Our pool tier rejects `CUSTOM_AUTH`.** The customer pool is ESSENTIALS with choice-based
   sign-in (required for the passwordless OTP + WebAuthn factors); Cognito's own validation:
   *"CUSTOM_AUTH is not a valid auth factor. Valid: [PASSWORD, EMAIL_OTP, SMS_OTP, WEB_AUTHN]."*
3. **Browsers do allow a gesture-free modal `get()` on load** — one per page load on iOS 16 (its
   "freebie"), unrestricted on iOS 17.4+ — **but only once the document has focus** (an unfocused
   ceremony throws `NotAllowedError: The document is not focused`, observed on-device on external
   navigations like a shared link). An early "zero-tap is impossible on the web" conclusion was
   wrong; the real constraints are the focus rule and the one-freebie budget.

## Decision

1. **"FaceID" = platform WebAuthn passkey, user-verification required.** Options request
   `authenticatorAttachment: "platform"`, `userVerification: "required"`, `residentKey: "required"`
   (discoverable), attestation `none`. The mechanism is always "passkey"; only the **label** is
   device-matched — Face ID / Touch ID / Windows Hello / fingerprint, neutral fallback, detected
   client-side, per-locale (he/en).

2. **Own the passkey ceremony; Cognito owns only the session.** Enrolment and login run on an
   app-managed WebAuthn flow on `app-auth` (not Cognito's native
   `Start/CompleteWebAuthnRegistration` / `WEB_AUTHN`): passkeys are enrolled as discoverable
   platform credentials with `userHandle = customer.cognito_sub`; the public key (+ credential id,
   sign counter, transports) lives in the **non-PII DynamoDB table `passkey_credential`**
   (PK `credentialId`, `byCustomerSub` GSI). Assertions are verified by us — `@wanthat/webauthn`
   (wrapping `@simplewebauthn/server`) — against an app-issued random, short-TTL, single-use
   challenge with an **empty** `allowCredentials`. The friendly display name is the phone; the
   stored username/userHandle stays the immutable sub (phone is a mutable alias).

3. **Automatic login, per device state (the shipped UX):**
   - **Returning passkey device** (a localStorage flag set on any successful passkey use) → an
     **automatic modal prompt**: the ceremony **arms on load and fires the moment the document
     gains focus** (no timeout racing the OS — worst case it pops on the first touch). Face ID
     appears with zero taps.
   - **First-time device** → the gentle **conditional-UI autofill** (the passkey offers itself in
     the phone field, `autocomplete="tel webauthn"`); using it sets the returning-device flag.
     The two never run together (the #64 lesson: a pending conditional `get()` collides with a
     modal `get()` on iOS).
   - **Explicit "Sign in with <biometric>" button** only where autofill is unsupported or after a
     cancelled auto-prompt (the gesture fallback).
   - **OTP is the universal fallback and account recovery** — no session, no passkey, unsupported
     browser, or a lost device all fall back to phone + OTP; passkeys never lock anyone out.

4. **Bridge the verified assertion to Cognito tokens via a server-side admin token exchange.**
   `app-auth` verifies the assertion (challenge single-use, signature against the stored key,
   RP-ID + origin bound to the site, sign-count monotonic), resolves the credential to its
   immutable Cognito username, then mints real tokens server-side: `AdminSetUserPassword` (fresh
   random 40+ chars, permanent) immediately consumed via `ADMIN_USER_PASSWORD_AUTH` — rotated every
   login, never returned or logged; the member stays passwordless. Downstream is unchanged: the
   JWT authorizer, `/me`, refresh all see ordinary Cognito tokens, and `app-core` stays
   Cognito-free (ADR-0020).

5. **Login surfaces: `/auth` and the `/p/{id}` referral landing** — the same reusable client module
   on both. On `/p/`, the verify response's tokens are used **directly** (persist refresh →
   redirect to store) so the landing stays Aurora-free (ADR-0007): a passkey credential is an
   existing member by construction, so no login-vs-register resolve is needed there.

6. **Accepted platform constraints:** RP-ID = the site domain (`dev.wanthat.app` / `wanthat.app`,
   set via `SetUserPoolMfaConfig` — the L2 prop does not apply to an existing pool); per-RP-ID
   binding means no passkeys on `localhost` and no dev↔prod migration. Native apps later reuse the
   same passkeys via `.well-known` association on the apex RP-ID.

## Alternatives considered

- **Cognito-native username-hinted login ("Flow B")** — shipped first: the SPA sent the remembered
  phone to `InitiateAuth(USER_AUTH, WEB_AUTHN)` and completed the challenge. Worked, but could
  never be automatic (username before challenge → no conditional UI, no userless modal), and
  bolting conditional UI onto it failed outright (populated `allowCredentials` → no autofill chip +
  colliding ceremonies). Replaced by the custom ceremony (decision 2).
- **Managed Login hosted UI for userless login ("Flow C")** — the only Cognito-supported
  discoverable path, but it never functioned: the hosted UI's origin is the Cognito domain, not a
  registrable suffix of the site, so a site-RP passkey cannot be exercised there without a custom
  auth domain — plus a full-page redirect UX. Rejected.
- **`CUSTOM_AUTH` trigger trio + short-lived HMAC proof** — the bridge this design originally
  specified: `app-auth` proves its verification to Define/Create/VerifyAuthChallenge triggers via a
  single-use HMAC proof. Fully built and security-reviewed, then found dead-on-arrival on-device:
  ESSENTIALS choice-based pools reject `AuthFlow=CUSTOM_AUTH` (fact 2). Replaced by the admin token
  exchange (decision 4); the trigger trio + proof secret were removed.
- **Mint our own (non-Cognito) session JWTs after verifying** — bypasses the API-Gateway Cognito
  authorizer and forces a second validation path across the whole API. Rejected — bridge to Cognito
  so downstream is untouched.
- **OTP-only, no biometric** — forfeits the core product vision. Rejected.
- **Conditional-UI-only "automatic" (no auto-modal)** — the interim position after the early
  "zero-tap impossible" conclusion. On-device testing disproved that conclusion (fact 3); the
  auto-modal on focus is strictly better for returning devices, with conditional UI kept for
  first-timers.
- **Passkey management (list/rename/delete) in MVP** — deferred to the profile page; enrolment +
  login + OTP recovery cover MVP. When built it lives on `app-auth` (Cognito calls).

## Consequences

- **Owned security surface** (review as security-critical): assertion verification — challenge
  single-use, origin + RP-ID binding, signature, sign-count regression (clone detection). The token
  exchange trusts that verification; the ephemeral password exists only server-side.
- **API surface on `app-auth`:** `POST /auth/passkey/register/{options,verify}` (authorized),
  `GET /auth/passkey/login/challenge` + `POST /auth/passkey/login/verify` (public — the assertion
  is the credential; enumeration-safe: no-user and no-passkey collapse to one 401). The verify
  response carries both the registration ticket (for `/auth`'s session resolve) and the tokens
  (for the Aurora-free landing).
- **SPA:** a reusable passkey module — arm-on-focus auto-modal, conditional-UI autofill, the
  returning-device flag, device-matched labels (he/en), enable-when-unenrolled step after signup,
  OTP fallback on any failure/cancel.
- Existing Cognito-native passkeys did not carry over (their keys live in Cognito, unreadable);
  members re-enrolled once. Cognito-native passkey flows for the customer pool are retired.
- iOS 16's single gesture-free `get()` per page load is a real budget: exactly one automatic
  ceremony is armed per load, and nothing may consume it first.
