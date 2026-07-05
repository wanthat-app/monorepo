# ADR 0024 — Automatic biometric login: custom discoverable WebAuthn + conditional UI, bridged to Cognito via an admin token exchange

- **Status:** Accepted
- **Date:** 2026-07-05
- **Supersedes (in part):** [ADR-0022](0022-faceid-passkey-authentication.md) — replaces Flow B
  (username-hinted on-page login) and Flow C (Managed Login userless redirect) with a single on-page
  **conditional-UI** login, and revises the "auto-on-load is impossible; the one-tap button is the
  guaranteed path" consequence.
- **Refines:** [ADR-0006](0006-identity-sms-otp-and-passkeys.md) (passkeys as a first-auth factor),
  [ADR-0020](0020-auth-foundation.md) (passkey enrolment API-driven), [ADR-0021](0021-auth-split-vpc-edge-and-core.md)
  (passkey endpoints on the non-VPC `app-auth`), [ADR-0003](0003-datastore-aurora-and-dynamodb.md)
  (new non-PII DynamoDB table)
- **Related:** [ADR-0007](0007-landing-path-and-latency.md) (cookieless Bearer)

## Context

ADR-0022 wanted "visit → biometric → in" but concluded, from Cognito's constraints, that the best
on-page UX was a **one-tap** "Sign in with Face ID" button: Cognito's raw `WEB_AUTHN` challenge
requires a username, so it cannot start the **userless, discoverable** ceremony that WebAuthn
**conditional UI** (passkey autofill) needs, and truly userless login was only available via the
Managed Login hosted UI (a redirect, and blocked anyway by an RP-ID/origin mismatch on the default
Cognito domain).

Two things are now known that change the calculus:

1. **Conditional UI works on our origin (spike-verified 2026-07-05, iOS Safari + others).** A userless
   `navigator.credentials.get({ mediation: "conditional" })` with an **empty** `allowCredentials`, on
   `dev.wanthat.app`, surfaces a discoverable passkey in the field's autofill; one tap completes the
   biometric and returns an assertion carrying its `userHandle`. This is the industry-standard
   "automatic" passkey UX (the passkey offers itself; there is no zero-tap modal — browsers forbid an
   auto-modal `get()` without a user gesture, so this is the true ceiling).
2. **Cognito cannot be in the verification path for a userless assertion.** Conditional UI must start
   the ceremony (and therefore hold a challenge) **before** any username is known, but Cognito only
   issues a `WEB_AUTHN` challenge **after** `InitiateAuth` with a username. So the challenge must be
   ours, and — because Cognito never exposes the stored public key — the assertion must be **verified
   by us**, not by Cognito.

The earlier attempt to bolt conditional UI onto the username-hinted Cognito flow failed exactly here:
a username-hinted challenge returns a populated `allowCredentials`, so no autofill chip appears and the
pending conditional `get()` collides with the button's modal `get()` on iOS. Conditional UI and
Cognito-native passkey verification are mutually exclusive.

## Decision

1. **Own the passkey ceremony; Cognito owns only the session.** For the **customer** pool, passkey
   enrolment and login move off Cognito's native `Start/CompleteWebAuthnRegistration` /
   `USER_AUTH WEB_AUTHN` onto an app-managed WebAuthn flow on `app-auth`. Passkeys are enrolled as
   **discoverable/resident** platform credentials with `userHandle = customer.cognito_sub`; the
   public key (+ credential id, sign counter, transports) is stored in a **new non-PII DynamoDB
   table `passkey_credential`** (PK `credentialId`; `byCustomerSub` GSI). Verification uses a WebAuthn
   server library in a new pure package `@wanthat/webauthn` (wrapping `@simplewebauthn/server`).

2. **Conditional UI is the primary login path; the explicit button is a fallback only when autofill
   is unavailable.** On a login surface the SPA, when `browserSupportsWebAuthnAutofill()` is true,
   arms a userless conditional `get()` against an **app-auth-issued challenge** (`GET
   /auth/passkey/login/challenge`, random, short-TTL, single-use) with an **empty** `allowCredentials`.
   The passkey surfaces itself → biometric → assertion → `POST /auth/passkey/login/verify`. **The
   "Sign in with <biometric>" button is shown only when autofill is NOT supported** (then a modal
   discoverable `get()` on tap). OTP stays the universal fallback and account recovery; passkeys never
   lock anyone out (ADR-0022 decision 5, retained).

3. **Bridge the verified assertion to Cognito tokens via a server-side admin token exchange.**
   `app-auth` verifies the assertion itself (our challenge matches, signature validates against the
   stored public key, RP-ID + origin bound to the site domain, sign-count monotonic), resolves the
   credential to its (immutable) Cognito username, and mints real Cognito tokens **server-side**: it
   sets a fresh random permanent password (`AdminSetUserPassword`) and immediately consumes it via
   `ADMIN_USER_PASSWORD_AUTH`. The password is 40+ chars, **never returned to the client or logged, and
   rotated on every login**; the member stays passwordless (they only ever use OTP or a passkey).
   `ADMIN_USER_PASSWORD_AUTH` is an admin-only flow, unreachable from the browser. The rest of the
   system is unchanged — the API-Gateway JWT authorizer, `/me`, and refresh keep consuming ordinary
   Cognito tokens. This keeps `app-core` Cognito-free (ADR-0021).

   *Why not the CUSTOM_AUTH + HMAC-proof design this ADR first specified:* our customer pool is
   **ESSENTIALS-tier with choice-based sign-in** (required for the passwordless OTP + WebAuthn factors
   we already use), and on that tier Cognito **rejects `AuthFlow=CUSTOM_AUTH` outright** — its own
   validation: *"CUSTOM_AUTH is not a valid auth factor. Valid: [PASSWORD, EMAIL_OTP, SMS_OTP,
   WEB_AUTHN]."* The custom-auth trigger trio + short-lived HMAC proof were built and security-reviewed,
   then found dead-on-arrival when Slice 1 was smoke-tested on-device (WebAuthn verification always
   worked; only this final token-mint step failed). The admin token exchange is the working
   replacement and needs no triggers and no proof secret. (The now-dead trigger trio + proof secret are
   scheduled for removal.)

4. **RP-ID = the site domain (already enforced).** The relying-party id stays the deployed site
   (`dev.wanthat.app` / `wanthat.app`, set via `SetUserPoolMfaConfig` — see the ADR-0022 follow-up),
   so enrolment and login share one origin and passkeys are discoverable there. Per-RP-ID binding, no
   localhost, no dev↔prod migration (ADR-0022 decision 6, retained).

5. **Login surfaces: the auth screen and the shared-link landing.** The capability is a **reusable**
   client module + backend contract, wired first into the SPA auth screen (`/auth`) and then into the
   public shared-link landing (`/p/{id}`, `services/landing`) — the two places a signed-out member
   authenticates. The landing is server-rendered (not the React SPA) and is currently a skeleton, so
   its integration is a distinct, later slice that reuses the same endpoints.

6. **Existing Cognito-native passkeys do not carry over** (their public keys live in Cognito, which we
   cannot read). Members re-enrol once under the new store; trivial at current scale and a one-time
   cost. Cognito-native passkey enrolment/login for the customer pool is retired.

## Alternatives considered

- **Keep Cognito-native passkeys + one-tap button (ADR-0022 status quo).** No autofill ("automatic")
  UX; rejected now that conditional UI is proven and the product wants the passkey to offer itself.
- **Managed Login hosted UI for userless login (ADR-0022 Flow C).** A full-page redirect, needs a
  custom auth domain under the site domain to fix the RP origin, and Managed Login must be configured
  to surface passkey — more infra for a worse (redirect) UX than on-page conditional UI. Rejected.
- **Thin CUSTOM_AUTH trigger trio + short-lived HMAC proof** (this ADR's original bridge). `app-auth`
  verifies the assertion, then proves it to `DefineAuthChallenge`/`CreateAuthChallenge`/
  `VerifyAuthChallenge` Lambdas via a single-use HMAC proof; the triggers never re-do WebAuthn.
  Elegant and fully built/reviewed — but **not available on our pool**: ESSENTIALS-tier choice-based
  pools reject `AuthFlow=CUSTOM_AUTH`. Rejected on that hard platform constraint; replaced by the admin
  token exchange (decision 3).
- **Mint our own (non-Cognito) session JWTs after verifying.** Would bypass the API-Gateway Cognito
  JWT authorizer, forcing a second authorizer/validation path across the whole API. Rejected — bridge
  to Cognito instead so downstream is unchanged.

## Consequences

- **New:** DynamoDB `passkey_credential` table (+ GSI); `@wanthat/webauthn` package
  (`@simplewebauthn/server` wrapper: enrol-verify, assertion-verify, options builders); `app-auth`
  endpoints `POST /auth/passkey/register/{options,verify}` (rewritten to store our own key) and
  `GET /auth/passkey/login/challenge` + `POST /auth/passkey/login/verify` (public); the SPA client's
  `adminUserPassword` auth flow (for the token exchange) + `cognito-idp:AdminSetUserPassword` on
  `app-auth`. (The originally-planned custom-auth Lambda trio + HMAC proof secret + `CUSTOM_AUTH`
  client flow were built but are dead — see decision 3 — and are scheduled for removal.)
- **SPA:** a reusable passkey-autofill module (arm conditional UI on load, verify, sign in), the
  button shown only when autofill is unsupported, and a re-enrol prompt.
- **Security surface we now own:** assertion verification (signature, challenge single-use, origin +
  RP-ID, sign-count regression = clone detection). Must be reviewed as security-critical. The token
  exchange trusts `app-auth`'s verification: the ephemeral password is set and consumed entirely
  server-side, never exposed to the client and never logged, so the only path to it is a successfully
  verified assertion.
- **Trust ceiling honoured:** "automatic" means the passkey autofills itself + one tap; a zero-tap
  auto-modal biometric on load remains impossible on the web (browser user-activation rule). Native
  apps later can reuse the same passkeys via `.well-known` association on the apex RP-ID.
- **Retires** Cognito-native customer passkeys (one-time re-enrol); OTP fallback unchanged.
