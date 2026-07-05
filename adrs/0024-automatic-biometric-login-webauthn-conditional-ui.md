# ADR 0024 — Automatic biometric login: custom discoverable WebAuthn + conditional UI, bridged to Cognito via CUSTOM_AUTH

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

3. **Bridge the verified assertion to Cognito tokens via a thin CUSTOM_AUTH flow.** `app-auth` verifies
   the assertion itself (our challenge matches, signature validates against the stored public key,
   RP-ID + origin bound to the site domain, sign-count monotonic), resolves `sub → username`, and mints
   real Cognito tokens through Cognito's **custom authentication challenge** (`DefineAuthChallenge` /
   `CreateAuthChallenge` / `VerifyAuthChallenge` Lambdas). Those triggers are **thin**: they do NOT
   re-do WebAuthn; they validate a **short-lived HMAC proof** that `app-auth` issues only after a
   successful assertion (the same signed-ticket pattern as the registration ticket, ADR-0020/0021).
   The rest of the system is unchanged — the API-Gateway JWT authorizer, `/me`, and refresh keep
   consuming ordinary Cognito tokens. This keeps `app-core` Cognito-free (ADR-0021).

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
- **Put WebAuthn verification inside the CUSTOM_AUTH Lambdas** (no separate app-auth verify). The
  conditional challenge must exist before `InitiateAuth`, so it can't come from `CreateAuthChallenge`;
  verification also needs the passkey table and library. Concentrating it in `app-auth` (one place,
  already the auth edge) and making the Cognito triggers a thin HMAC-proof check is simpler and keeps
  the trust boundary auditable. Chosen.
- **Mint our own (non-Cognito) session JWTs after verifying.** Would bypass the API-Gateway Cognito
  JWT authorizer, forcing a second authorizer/validation path across the whole API. Rejected — bridge
  to Cognito instead so downstream is unchanged.

## Consequences

- **New:** DynamoDB `passkey_credential` table (+ GSI); `@wanthat/webauthn` package
  (`@simplewebauthn/server` wrapper: enrol-verify, assertion-verify, options builders); `app-auth`
  endpoints `POST /auth/passkey/register/{options,verify}` (rewritten to store our own key) and
  `GET /auth/passkey/login/challenge` + `POST /auth/passkey/login/verify` (public); a Cognito
  custom-auth Lambda trio + an HMAC proof secret; customer-pool/client config to allow `CUSTOM_AUTH`.
- **SPA:** a reusable passkey-autofill module (arm conditional UI on load, verify, sign in), the
  button shown only when autofill is unsupported, and a re-enrol prompt.
- **Security surface we now own:** assertion verification (signature, challenge single-use, origin +
  RP-ID, sign-count regression = clone detection). Must be reviewed as security-critical; the HMAC
  proof to the CUSTOM_AUTH trigger must be short-TTL, single-use, and never carry the raw assertion.
- **Trust ceiling honoured:** "automatic" means the passkey autofills itself + one tap; a zero-tap
  auto-modal biometric on load remains impossible on the web (browser user-activation rule). Native
  apps later can reuse the same passkeys via `.well-known` association on the apex RP-ID.
- **Retires** Cognito-native customer passkeys (one-time re-enrol); OTP fallback unchanged.
