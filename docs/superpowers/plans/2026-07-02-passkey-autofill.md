# Passkey autofill (conditional UI) + login rate limit — plan

> One implementer + one reviewer. `- [ ]` steps.

**Goal:** Make Face ID login feel automatic on a returning device: on the auth page the browser surfaces the passkey **on its own** as an autofill suggestion (WebAuthn conditional mediation), so the user taps the passkey chip → Face ID → in, without first pressing a button. Keep the explicit button as the guaranteed fallback (browsers without autofill, or the user prefers it). Add a dedicated per-phone rate limit to the passkey-login endpoint (it fires on every auth-page load now, and can't reuse the SMS counter — that would lock out frequent Face ID users).

**Architecture:** SPA-side, on mount (`knownPhone` present, passkeys supported, `browserSupportsWebAuthnAutofill()` true): prime the Cognito WEB_AUTHN challenge for the remembered phone and start `startAuthentication({ optionsJSON, useBrowserAutofill: true })` — a **conditional** ceremony that resolves only when the user picks the passkey from autofill. The phone `<input>` carries `autocomplete="tel webauthn"` so the browser attaches passkeys to it. Backend unchanged except a new `withinPasskeyVelocity` gate on `/auth/passkey/login/options`. This is the ADR-0022 "auto-on-load UX" spike; the guaranteed fallback (one-tap button) already exists and stays.

**Tech:** `@simplewebauthn/browser@13` (`startAuthentication` with `useBrowserAutofill`, `browserSupportsWebAuthnAutofill`), React, Zod config keys, existing `PhoneVelocityRepo`.

## Global constraints
- Branch `passkey-autofill` off main.
- The conditional ceremony must fail **silently** — no error UI, never `forgetDevicePhone` — on: no autofill support, user picking another method, abort (a new ceremony or the explicit button starting one), or cancel. Only a genuine successful assertion signs the user in.
- Start the conditional ceremony at most **once per mount** (a ref guard), only while `step === "phone"`.
- The explicit "Sign in with <biometric>" button stays; tapping it runs a normal (non-conditional) ceremony (SimpleWebAuthn 13 aborts the pending conditional one automatically).
- Rate limit is **per-phone and generous** (default 30 / 60 min) — it must NOT lock out a normal user who reloads a few times; it caps hammering one phone's endpoint. It is a distinct counter from the SMS velocity (`"pk:"`-prefixed key).
- Verification: `pnpm build && pnpm typecheck && pnpm test && pnpm lint && pnpm synth` green.

---

### Task 1: Config keys + passkey velocity gate

**Files:** `packages/contracts/src/config/keys.ts`; `packages/contracts/src/identity/auth.test.ts` (extend); `services/app-auth/src/auth/velocity.ts`; `services/app-auth/src/auth/router.ts` (gate); extend `services/app-auth/src/auth/router.test.ts`.

**Produces:** config keys `auth.passkeyMaxPerWindow` (int, default 30) + `auth.passkeyWindowMinutes` (int, default 60); `withinPasskeyVelocity(config, repo, phone, now)`; a 429 gate on `/auth/passkey/login/options`.

- [ ] **Step 1 — failing config test.** Append to the config describe in `auth.test.ts`:

```ts
  it("ships the passkey-login velocity keys (generous, separate from SMS)", () => {
    expect(CONFIG_DEFAULTS["auth.passkeyMaxPerWindow"]).toBe(30);
    expect(CONFIG_DEFAULTS["auth.passkeyWindowMinutes"]).toBe(60);
    expect(parseConfigValue("auth.passkeyMaxPerWindow", 50)).toBe(50);
  });
```

- [ ] **Step 2 — run RED** (`pnpm --filter @wanthat/contracts test`).

- [ ] **Step 3 — implement config.** In `keys.ts` add after the WhatsApp keys:

```ts
/**
 * Per-phone cap on passkey-login challenge requests within `auth.passkeyWindowMinutes`. Passkey
 * login fires on every auth-page load (conditional UI, ADR-0022), so this is deliberately generous
 * and SEPARATE from the SMS velocity counter — reusing that would lock out a member who signs in
 * with Face ID often. Guards against hammering one phone's endpoint; enumeration is bounded by the
 * API-wide throttle.
 */
export const AuthPasskeyMaxPerWindow = z.number().int().min(1).max(200);
/** Window length for auth.passkeyMaxPerWindow, in minutes. */
export const AuthPasskeyWindowMinutes = z.number().int().min(1).max(1440);
```

Register both in `CONFIG_KEYS` (`"auth.passkeyMaxPerWindow"`, `"auth.passkeyWindowMinutes"`), `CONFIG_SCHEMAS`, and `CONFIG_DEFAULTS` (`30` and `60`).

- [ ] **Step 4 — velocity helper.** In `services/app-auth/src/auth/velocity.ts` add (reusing `hashPhone` with a `"pk:"` prefix for a disjoint counter):

```ts
/**
 * Passkey-login velocity (ADR-0022): a per-phone cap on /auth/passkey/login/options, on its OWN
 * counter (a "pk:" key prefix) and its own generous limits (auth.passkeyMaxPerWindow /
 * auth.passkeyWindowMinutes) so it never shares budget with SMS OTP. Same allow/retryAfter shape as
 * withinVelocity.
 */
export async function withinPasskeyVelocity(
  config: RuntimeConfigReader,
  repo: PhoneVelocityRepo,
  phone: string,
  nowEpoch: number,
): Promise<{ allowed: boolean; retryAfterSec: number }> {
  const limit = (await config.get("auth.passkeyMaxPerWindow")) as number;
  const windowSeconds = ((await config.get("auth.passkeyWindowMinutes")) as number) * 60;
  const { count, ttl } = await repo.hit(hashPhone(`pk:${phone}`), windowSeconds, nowEpoch);
  if (count <= limit) return { allowed: true, retryAfterSec: 0 };
  return { allowed: false, retryAfterSec: Math.max(0, ttl - nowEpoch) };
}
```

(Change the `RuntimeConfigRepo` import in that file to `RuntimeConfigReader` if not already — the existing `withinVelocity` should also take `RuntimeConfigReader`; if it currently takes `RuntimeConfigRepo`, widen both to `RuntimeConfigReader`.)

- [ ] **Step 5 — router gate.** In `services/app-auth/src/auth/router.ts`, import `withinPasskeyVelocity` alongside `withinVelocity`. In `/auth/passkey/login/options`, immediately after `normalizePhone` validation and **before** `getUserByPhone`:

```ts
    const gate = await withinPasskeyVelocity(ctx.config, ctx.velocity, phone, nowEpoch());
    if (!gate.allowed)
      return c.json({ error: "rate_limited", retryAfterSec: gate.retryAfterSec }, 429);
```

- [ ] **Step 6 — router test.** Add to the `/auth/passkey/login/options` describe in `router.test.ts` (the `beforeEach` config mock must return numbers for the two new keys — add `"auth.passkeyMaxPerWindow": 30`, `"auth.passkeyWindowMinutes": 60` to its switch, and ensure `fake.velocity.hit` resolves `{ count: 1, ttl: 0 }` by default as it does for the other tests):

```ts
  it("429s when over the passkey-login velocity cap", async () => {
    fake.velocity.hit.mockResolvedValue({ count: 99, ttl: 1000 });
    const res = await post("/auth/passkey/login/options", { phone: PHONE });
    expect(res.status).toBe(429);
    expect(fake.cognito.getUserByPhone).not.toHaveBeenCalled();
  });
```

(Confirm the existing passkey-options tests still pass — they rely on `fake.velocity.hit` default `{count:1}`; set that in the suite's `beforeEach` if not already present.)

- [ ] **Step 7 — run GREEN** (`pnpm --filter @wanthat/contracts test && pnpm --filter @wanthat/app-auth test && ...typecheck`); commit `feat(app-auth): per-phone passkey-login velocity gate (ADR-0022)`.

---

### Task 2: SPA — conditional-UI autofill on the auth page

**Files:** `apps/web/src/lib/passkey.ts`; `apps/web/src/features/auth/AuthPage.tsx`.

- [ ] **Step 1 — thread the autofill flag through `loginWithPasskey`.** In `apps/web/src/lib/passkey.ts`:
  - Add `browserSupportsWebAuthnAutofill` to the `@simplewebauthn/browser` import.
  - Re-export it: `export { browserSupportsWebAuthnAutofill } from "@simplewebauthn/browser";`
  - Change `loginWithPasskey` to accept an options arg and pass it through:

```ts
export async function loginWithPasskey(
  phone: string,
  opts: { useBrowserAutofill?: boolean } = {},
): Promise<AuthSession> {
  const { challengeId, options } = await authApi.passkeyLoginOptions(phone);
  const credential = await startAuthentication({
    // biome-ignore lint/suspicious/noExplicitAny: server-generated WebAuthn document
    optionsJSON: options as any,
    useBrowserAutofill: opts.useBrowserAutofill ?? false,
  });
  const { registrationTicket } = await authApi.passkeyLoginVerify(challengeId, credential);
  const res = await authApi.session(registrationTicket);
  if (res.status !== "authenticated") throw new Error("passkey login did not resolve a session");
  return { tokens: res.tokens, customer: res.customer };
}
```

- [ ] **Step 2 — AuthPage: start conditional UI on mount.**
  - Imports: add `useRef` (react); add `browserSupportsWebAuthnAutofill` to the `../../lib/passkey` import.
  - After the existing `knownPhone` state/effect, add the conditional-mediation effect (runs once, only on the phone step, swallows every non-success):

```ts
  // Conditional UI (ADR-0022 "auto-on-load"): if the device remembers the phone and the browser
  // supports passkey autofill, prime a WebAuthn assertion so the passkey surfaces on its own in the
  // phone field's autofill. Resolves only when the user picks it; every other outcome (no support,
  // abort when the explicit button starts a ceremony, cancel) is swallowed — the button + OTP remain.
  const autofillStarted = useRef(false);
  useEffect(() => {
    if (step !== "phone" || !knownPhone || !passkeysSupported() || autofillStarted.current) return;
    autofillStarted.current = true;
    (async () => {
      if (!(await browserSupportsWebAuthnAutofill())) return;
      try {
        const session = await loginWithPasskey(knownPhone, { useBrowserAutofill: true });
        signIn(session);
        navigate("/home", { replace: true });
      } catch {
        // no-op: user chose another method / cancelled / ceremony aborted.
      }
    })();
  }, [step, knownPhone, signIn, navigate]);
```

  - The phone `<input>` gets the webauthn autocomplete token so the browser attaches passkeys. Change its `autoComplete` (add the attribute if absent) to:

```tsx
              autoComplete="tel webauthn"
```

  - Keep the explicit `onPasskeyLogin` button and the `differentNumber` control exactly as they are (the button remains the guaranteed one-tap path; SimpleWebAuthn 13 auto-aborts the pending conditional ceremony when the button starts a new one).

- [ ] **Step 3 — verify + commit.** `pnpm --filter @wanthat/web typecheck && pnpm --filter @wanthat/web test && pnpm --filter @wanthat/web build && pnpm lint`. Commit `feat(web): passkey autofill (conditional UI) on the auth page (ADR-0022)`.

---

### Task 3: Finalize

- [ ] **Step 1.** `pnpm install && pnpm build && pnpm typecheck && pnpm test && pnpm lint && pnpm synth` all green.
- [ ] **Step 2.** Push; open PR (ready) titled `feat: passkey autofill (conditional UI) + login rate limit (ADR-0022)`. Body: what conditional UI does (passkey surfaces itself; one tap on the chip), the explicit button stays as the guaranteed fallback, iOS caveat (auto-modal without a gesture is impossible; conditional autofill is the sanctioned auto path), and the new per-phone rate limit (separate from SMS, generous). Note on-device validation is required (autofill can't be exercised in an automated browser); if iOS doesn't surface the chip for a username-hinted challenge, the button still works — no regression.

## Note
This is the ADR-0022 auto-on-load spike realized as conditional UI. It does NOT attempt an auto-modal biometric on load (browser/iOS forbid it without a user gesture). The remembered-phone hint (already shipped) plus conditional autofill is the closest-to-automatic path that works on iOS. No new ADR — within ADR-0022's stated design + consequences.
