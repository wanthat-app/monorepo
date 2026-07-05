# Automatic biometric login (ADR-0024) — implementation plan

Implements [ADR-0024](../../../adrs/0024-automatic-biometric-login-webauthn-conditional-ui.md).
Security-critical (we now own WebAuthn verification + a Cognito token bridge). Built as **4 reviewed
slices**, each an end-to-end deployable step; each task is TDD (failing test → implement → green →
commit). Every slice gets the security-lens review before merge.

**Goal:** the passkey **offers itself** in the login field's autofill (WebAuthn conditional UI); one
tap → biometric → signed in, no phone, no button. The explicit button appears only where autofill
isn't supported. OTP remains the universal fallback.

## Architecture recap (the non-obvious parts)

- **Two challenges, two roles.** Login uses an **app-auth-issued** random challenge (username-less, so
  conditional UI can start on load). Cognito is NOT in the WebAuthn path — it only mints the session.
- **We verify the assertion** (`@wanthat/webauthn` over `@simplewebauthn/server`): challenge is
  single-use + unexpired, `origin` ∈ our site origins, `rpId` = site domain, signature validates
  against the **stored** public key (looked up by `credentialId`), and `signCount` is monotonic
  (regression ⇒ possible clone ⇒ reject).
- **Bridge to Cognito via a thin CUSTOM_AUTH flow.** After verify, app-auth issues a **short-TTL,
  single-use HMAC proof** (`{sub, exp, nonce}`, signed with a new secret) and drives Cognito
  `AdminInitiateAuth(CUSTOM_AUTH, username)` → `AdminRespondToAuthChallenge` passing the proof in
  `ClientMetadata`. The `VerifyAuthChallengeResponse` Lambda validates the proof (same secret) and
  approves; `DefineAuthChallenge` issues exactly one `CUSTOM_CHALLENGE` then succeeds;
  `CreateAuthChallenge` is a no-op. Tokens come back to app-auth → signed into the same registration
  ticket → `/auth/session` resolves the member (unchanged downstream, ADR-0021).
- **userHandle = cognito_sub.** Enrolment sets the resident credential's userHandle to the customer's
  `sub`; the login assertion returns it, so app-auth resolves `sub → username` without a prompt.

## Global constraints
- ADRs locked; this implements ADR-0024. ASCII-only CDK descriptions. Fix warnings at source; never
  suppress. Config table single-writer (admin-api). `pnpm build/typecheck/test/lint/synth` green per slice.
- Secrets: a new `passkey/proof-hmac` secret (per env), granted to app-auth (sign) + the
  VerifyAuthChallenge Lambda (verify) only.
- The HMAC proof NEVER carries the raw assertion; it is single-use (nonce stored with short TTL) and
  short-TTL (≤60s). The login challenge is single-use (deleted on verify) and short-TTL (≤5 min).
- Passkeys bound to the site RP-ID (already set via SetUserPoolMfaConfig); no localhost; no dev↔prod.

---

## Slicing principle

Each slice is a **deployable, end-to-end working use case** — a member can *do something whole* after
it ships — not a horizontal layer. A passkey you can enrol but not log in with is not a deliverable, so
"enrol" and "login" are never separate slices; the smallest shippable unit is the full loop. Slices are
broken into TDD **tasks** internally, but the deliverable/PR is the working feature. Later slices add
*more* complete use cases on top of a working one.

---

## Slice 1 — "Sign in with your passkey" (complete vertical: enrol → biometric → in)

**Deliverable (what a user can do after deploy):** enrol a passkey on their device, sign out, and sign
back in with the biometric (a one-tap "Sign in with Face ID" **modal** — every browser/authenticator
supports the modal, so this ships with no on-device autofill dependency and de-risks the whole backend +
Cognito bridge before Slice 2 layers autofill on top). OTP remains the fallback, and a member with no
new-store passkey (everyone, at first) is prompted to re-enrol after an OTP sign-in — so the migration
off Cognito-native passkeys happens inside this slice, end to end.

This is the minimal complete loop, so it necessarily spans the store + library + endpoints + Cognito
bridge + SPA. It is large **because the feature is** — split it into the tasks below, ship as one
working use case.

**Tasks (each TDD; one PR):**
1. `@wanthat/webauthn` package — `@simplewebauthn/server@13` wrapper: registration-options builder +
   attestation verify → `{credentialId, publicKey, signCount, transports}`; request-options builder +
   assertion verify (given a stored credential) → `{newSignCount}`. Pure (RP-ID/origins passed in).
2. `packages/dynamo` `PasskeyCredentialRepo` + `infra` `PasskeyCredential` table (PK `credentialId`,
   GSI `byCustomerSub`, PITR, on-demand); grant app-auth RW.
3. Contracts for register + login (options/verify) request/response; login-verify returns the same
   `registrationTicket` as `/auth/verify`.
4. app-auth: rewrite `POST /auth/passkey/register/{options,verify}` to our store (residentKey/platform/
   UV-required, `user.id = sub`, challenge in `auth_challenge` `recordType:"pk-reg"`); add
   `GET /auth/passkey/login/challenge` (username-less, single-use, TTL≤5m) + `POST /auth/passkey/login/
   verify` (single-use challenge; assertion verify; credentialId→key; origin/rpId pin; signCount
   monotonic; resolve `sub`); the HMAC **proof** (`{sub,exp≤+60,nonce}`, single-use nonce) issued after
   verify; `cognito.passkeyCustomAuth(username, proof)` bridges to tokens; ticket back.
5. Cognito CUSTOM_AUTH trigger trio (`define`/`create` no-op/`verify` validates the proof, fails closed
   without it) + infra: attach to the customer pool, `ALLOW_CUSTOM_AUTH` on the SPA client, new
   `passkey/proof-hmac` secret (sign→app-auth, verify→trigger), observability on the 3 triggers.
6. Public routes on the HTTP API for `login/challenge` + `login/verify` (no authorizer); enrol routes
   stay behind the JWT authorizer.
7. SPA: rewire the enrol step to the new endpoints; the login button does a **modal** discoverable
   `get()` → verify → session; OTP fallback + "enable Face ID" re-enrol prompt after OTP sign-in.

**Review focus (heaviest — security-critical, adversarial verify):** attestation/assertion verification;
single-use challenge + single-use short-TTL proof, sub-bound, never the raw assertion; a direct
`InitiateAuth(CUSTOM_AUTH)` without a valid proof must fail closed at `VerifyAuthChallenge`; signCount
clone-detection; origin/rpId pinning; credential item is non-PII (sub + public key only).

**On-device validation:** enrol + modal login on the phone (modal works everywhere — no autofill needed).

---

## Slice 2 — "The passkey offers itself" (conditional-UI autofill, on top of Slice 1)

**Deliverable:** on the auth screen the passkey **surfaces itself** in the field autofill (conditional
UI); one tap → biometric → in, no button. The explicit button from Slice 1 is shown **only when
`browserSupportsWebAuthnAutofill()` is false**. Pure UX upgrade on the already-working login — complete
and demonstrable on its own.

**Tasks:** `apps/web` reusable `passkey-login` module gains `armConditionalLogin()`
(`startAuthentication({useBrowserAutofill:true})` against the Slice-1 challenge → verify → session),
with the fire-once + swallow-all-non-success + unmount/cancel guards learned from the reverted PR;
`AuthPage` arms it on mount and hides the button when autofill is supported; the input gets
`autocomplete="… webauthn"`. Delete the throwaway `/spike/passkey` route here.

**On-device validation:** the autofill chip appears and completes Face ID (can't be exercised in CI).

---

## Slice 3 — "Face ID from a shared link" (landing `/p/{id}`)

**Deliverable:** a signed-out member opening a shared link signs in with Face ID there (attributing the
click), reusing Slice-1's public endpoints from the landing's bootstrap JS (vanilla, not React).
**Gated:** `services/landing` is a 501 skeleton today, so this slice waits until that page is real; it
does not block Slices 1–2 shipping the auth-screen experience. Flag at the time whether the landing
exists; if not, this stays queued.

---

## Sequencing
Slice 1 (one working feature) → adversarial security review → merge → deploy → on-device modal login
works; then Slice 2 (autofill upgrade) → review → merge → deploy → on-device autofill works; Slice 3
when the landing service exists. Re-enrol is handled inside Slice 1 (OTP fallback → enable-Face-ID
prompt), so no user is stranded when Cognito-native passkeys stop being the login path.
