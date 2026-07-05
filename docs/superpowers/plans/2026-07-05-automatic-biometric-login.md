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

## Slice 1 — Passkey store + `@wanthat/webauthn` + enrolment (our own key)

**Outcome:** a signed-in member can enrol a discoverable passkey whose public key we store; nothing
about login yet. Deployable, no user-visible change until Slice 3 wires the SPA.

**Files:**
- Create `packages/webauthn/` (`@wanthat/webauthn`): `src/register.ts` (build registration options;
  verify attestation → `{credentialId, publicKey, signCount, transports}`), `src/authenticate.ts`
  (build request options; verify assertion given a stored credential → `{newSignCount}`),
  `src/index.ts`. Wraps `@simplewebauthn/server@13`. Pure (RP-ID/origin passed in). Vitest per file.
- Create `packages/dynamo/src/passkey-credential.ts`: `PasskeyCredentialRepo`
  (`put`, `getByCredentialId`, `listByCustomer`, `updateSignCount`); item `{credentialId, customerSub,
  publicKey (b64url), signCount, transports, createdAt}`. Export from the barrel.
- Create `infra/lib/data-stack.ts` table `PasskeyCredential` (PK `credentialId`, GSI `byCustomerSub`
  on `customerSub`, PITR, on-demand). Grant app-auth read-write.
- Modify `packages/contracts/src/identity/passkey.ts` / `auth.ts`: register options/verify request +
  response contracts (reuse the existing `RegistrationResponseJSON`; add server-options response).
- Rewrite `services/app-auth`'s `POST /auth/passkey/register/{options,verify}` to use
  `@wanthat/webauthn` + the new table instead of Cognito `Start/CompleteWebAuthnRegistration`. Options
  sets `residentKey:"required"`, `authenticatorAttachment:"platform"`, `userVerification:"required"`,
  `user.id = ctx sub`, and stashes the challenge (reuse `auth_challenge` table, `recordType:"pk-reg"`).
  Verify checks the challenge, verifies attestation, stores the credential. Enrolment is behind the
  JWT authorizer (the member is signed in) — the pool's own passkey config is no longer used for the
  customer flow.
- `infra`: env + secret wiring (no new secret this slice); app-auth gets the table grant.

**Review focus:** attestation verification correctness; challenge single-use; the credential item has
no PII (sub + public key only, non-PII per ADR-0003); table/GSI shape.

---

## Slice 2 — Userless login: challenge + verify + Cognito CUSTOM_AUTH bridge

**Outcome:** `POST` an assertion for an enrolled passkey → real Cognito tokens. Testable by API
(the SPA comes in Slice 3).

**Files:**
- `services/app-auth` new public routes: `GET /auth/passkey/login/challenge` → `{challengeId,
  challenge}` (random 32B, stored `recordType:"pk-login"`, TTL ≤5 min, no username); `POST
  /auth/passkey/login/verify` `{challengeId, credential}` → verify (challenge single-use + delete;
  `@wanthat/webauthn` assertion verify; `credentialId` → stored key; origin/rpId; signCount monotonic
  → `updateSignCount`); resolve `sub` from the credential; bridge to Cognito; return the registration
  ticket (same shape as `/auth/verify`).
- New pure package addition or app-auth module `proof.ts`: issue/verify the HMAC proof
  (`{sub, exp≤now+60, nonce}`), nonce single-use (store in `auth_challenge`, `recordType:"pk-proof"`,
  TTL). Reuse the `TicketSigner` HMAC pattern with the **new** `passkey/proof-hmac` secret.
- New `services/passkey-auth-triggers` (or three handlers in one service): `defineAuthChallenge`,
  `createAuthChallenge` (no-op), `verifyAuthChallenge` (validate the proof from `ClientMetadata`;
  reject if absent/expired/replayed/sub-mismatch). Non-VPC.
- `infra/lib/identity-stack.ts`: attach the three custom-auth triggers to the customer pool; add
  `ALLOW_CUSTOM_AUTH` to the SPA client's explicit auth flows; create the `passkey/proof-hmac` secret,
  grant sign→app-auth, verify→verifyAuthChallenge Lambda; grant app-auth
  `AdminInitiateAuth`/`AdminRespondToAuthChallenge` (already held). Observability: add the 3 triggers.
- app-auth `cognito.ts`: `passkeyCustomAuth(username, proof)` → `AdminInitiateAuth(CUSTOM_AUTH)` +
  `AdminRespondToAuthChallenge(CUSTOM_CHALLENGE, ANSWER, ClientMetadata:{proof})` → tokens.

**Review focus (heaviest):** the whole trust chain — proof is single-use + short-TTL + sub-bound +
never the raw assertion; the CUSTOM_AUTH triggers can't be driven without a valid proof (a direct
`InitiateAuth(CUSTOM_AUTH)` by an attacker without the proof must fail closed at
`VerifyAuthChallenge`); signCount clone-detection; challenge replay; origin pinning. Dispatch
adversarial verification.

---

## Slice 3 — SPA: conditional UI primary, button only when unsupported, re-enrol

**Outcome:** the passkey autofills itself on `/auth`; one tap signs in. Button hidden when autofill
is supported.

**Files:** `apps/web/src/lib/passkey-login.ts` (reusable: `armConditionalLogin()` fetches the
challenge, runs `startAuthentication({useBrowserAutofill:true})`, verifies, returns `AuthSession`;
plus a modal variant for the button), `AuthPage.tsx` (arm conditional UI on mount with the
unmount/cancel guard from the reverted PR; render the "Sign in with <biometric>" button **only when
`!browserSupportsWebAuthnAutofill()`**; keep OTP always), the enrol step rewired to the Slice-1
endpoints, i18n. The phone/username input carries `autocomplete="... webauthn"`.

**Review focus:** the concurrency lessons from the reverted attempt — fire-once, swallow all
non-success, cleanup on unmount, button and conditional never run modal+conditional simultaneously in
a way that breaks iOS; graceful fallback to OTP.

---

## Slice 4 — Shared-link landing (`/p/{id}`) passkey login

**Outcome:** a signed-out member opening a shared link can Face-ID in (attributing the click).
**Depends on** the landing service being real (it is a 501 skeleton today), so this slice is gated on
that; it reuses the Slice-2 public endpoints from the landing's bootstrap JS (vanilla, not React).
Flag if the landing isn't built yet — then this slice waits and only the auth screen ships the UX.

---

## Sequencing / process
Slice 1 → review → merge → deploy; then 2 → review (adversarial) → merge → deploy; then 3 → review →
merge → deploy → **on-device validation** (autofill can't be exercised in CI); then 4 when the landing
exists. Re-enrol note to the (2 dev) users before Slice 3 flips the login path. Delete the
`/spike/passkey` throwaway route as part of Slice 3 (or a small cleanup PR).
