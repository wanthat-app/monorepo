# ADR 0022 — FaceID authentication: complete the WebAuthn passkey story (enroll + login)

- **Status:** Accepted
- **Date:** 2026-07-01
- **Refines:** [ADR-0006](0006-identity-sms-otp-and-passkeys.md) (passkeys as a first-auth factor),
  [ADR-0020](0020-auth-foundation.md) (passkey enrolment API-driven; discoverable login via Managed
  Login), [ADR-0021](0021-auth-split-vpc-edge-and-core.md) (passkey endpoints live on `app-auth`)
- **Related:** [ADR-0007](0007-landing-path-and-latency.md) (cookieless Bearer), [ADR-0016](0016-frontend-stack.md)

## Context

"FaceID" is not a new auth channel — it is the **platform-authenticator** variant of WebAuthn: the OS
biometric (Face ID / Touch ID / Windows Hello / Android fingerprint) unlocks a **passkey** bound to the
site origin. The pool is already configured for it (passkey as a first-auth factor,
`passkeyUserVerification: REQUIRED` — the biometric gesture — and `passkeyRelyingPartyId` = the site
domain). ADR-0020 landed API-driven **enrolment** and browser-based **discoverable** login (Managed
Login); ADR-0021 put the passkey endpoints on the non-VPC `app-auth`. This ADR **completes** the story
for MVP against a product vision: *visit → biometric → in; an "enable" prompt when not enrolled; the
label matches the device.*

A hard platform constraint shapes the design: Cognito's **raw** `USER_AUTH` / `WEB_AUTHN` challenge
**requires a username**, so a truly username-less assertion cannot be completed against the API — the
only userless/discoverable path is **Managed Login** (hosted UI). And WebAuthn binds each passkey to a
single RP-ID (origin), so passkeys do not work on `localhost` and do not migrate between environments.

## Decision (MVP scope)

1. **"FaceID" = platform WebAuthn passkey, user-verification required.** Options request
   `authenticatorAttachment: "platform"`, `userVerification: "required"`, `residentKey: "required"`
   (discoverable), attestation `none`. The mechanism is always "passkey"; only the **label** is
   device-matched: **Face ID / Touch ID / Windows Hello / fingerprint**, neutral fallback
   **"passkey" / "biometric sign-in"**, detected client-side, per-locale (he/en).

2. **Flow A — enrol (API-driven, `app-auth`).** After sign-in, a **logged-in member with no passkey**
   sees an "Enable <biometric>" button → `Start/CompleteWebAuthnRegistration`. Already substantially
   present; kept.

3. **Flow B — username-hinted login (NEW, `app-auth`) — the primary on-page path.** With the username
   (phone) known — the user typed it, **or it is remembered from last login** (localStorage) — the SPA
   calls `/auth/passkey/login/options { phone }` → Cognito `InitiateAuth(USER_AUTH,
   PREFERRED_CHALLENGE: WEB_AUTHN)`, runs `navigator.credentials.get()` (biometric), then
   `/auth/passkey/login/verify` → `RespondToAuthChallenge` → tokens → `/auth/session` resolves the
   member. **No hosted-UI redirect.** The remembered-phone hint is what realizes "visit → biometric →
   in" on a returning device.

4. **Flow C — discoverable / userless login via Managed Login (hosted UI redirect) — the fallback.**
   The only Cognito-supported path when we have **no** username (fresh device / cleared storage). The
   SPA redirects to Managed Login, which runs the discoverable ceremony and returns via OAuth
   code + PKCE. Already wired (`managed-login.ts`); finalized here.

5. **OTP is the universal fallback and account recovery.** No session, no passkey, unsupported browser,
   `localhost`, or a lost device all fall back to phone + OTP; a recovered user re-enrols a passkey.
   Passkeys therefore **never lock anyone out**. The "sign in with a code" affordance is always visible.

6. **Accepted platform constraints** (inherent, documented, not bugs): no passkeys on `localhost`
   (RP-ID mismatch); passkeys do **not** migrate dev (`dev.wanthat.app`) ↔ prod (`wanthat.app`);
   userless login is redirect-based (Flow C), never on-page.

7. **Repurpose the existing (mislabeled) contracts.** `packages/contracts/src/identity/session.ts`
   already declares passkey-login shapes commented "discoverable/userless" — which they cannot be (raw
   API needs a username). They are re-scoped to **Flow B** (username-hinted) with corrected comments.

## Alternatives considered

- **OTP-only, no biometric** — simplest, but forfeits the core product vision (fast, passwordless
  returning-user sign-in). Rejected.
- **Userless conditional-UI login on our own SPA page (no redirect)** — not possible: Cognito's raw API
  needs a username to issue the WebAuthn challenge, so a username-less assertion has nowhere to go.
  Userless therefore requires Managed Login (Flow C). Rejected as infeasible.
- **Passkey management (list/rename/delete) in MVP** — deferred: it belongs on the (out-of-scope)
  profile page, and enrolment + login + OTP-recovery cover MVP without it.

## Consequences

- **New API surface on `app-auth`:** `/auth/passkey/login/{options,verify}` (Flow B). IAM is already
  sufficient (`InitiateAuth` / `RespondToAuthChallenge` are granted to `app-auth` from ADR-0021); the
  routes sit behind the same HTTP API (public — the passkey assertion is the credential).
- **SPA work:** the `navigator.credentials.get()` ceremony, a remembered-phone hint, device-matched
  labels (he/en), the enable-when-unenrolled button, and OTP fallback on any passkey failure/cancel.
- **A spike precedes the auto-on-load UX:** whether the biometric can be offered *near-automatically*
  on load (vs one explicit tap) depends on WebAuthn conditional mediation + browser user-activation
  rules + Cognito challenge interop. The guaranteed fallback is a one-tap "Sign in with <biometric>".
- **`/me/passkeys` management is deferred** to the profile-page slice; when built it must live on
  `app-auth` (Cognito calls), keeping `app-core` Cognito-free (ADR-0021).
- **Native apps later** reuse the same passkeys via `.well-known` association on the apex RP-ID
  (already correct in prod) — designed-for, not built.
