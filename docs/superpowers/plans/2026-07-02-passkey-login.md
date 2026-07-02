# Passkey (Face ID) login — ADR-0022 Flow B implementation plan

> Execute with one implementer + one reviewer. Steps use `- [ ]`.

**Goal:** Implement passkey login on the SPA page — "visit → biometric → in" — with the phone (Cognito username) **remembered on the device**, so an authenticated device never re-prompts for the phone. Fresh devices fall back to OTP.

**Architecture:** ADR-0022 **Flow B** (already Accepted; this is the missing implementation). `/auth/passkey/login/{options,verify}` on `app-auth` drive Cognito `USER_AUTH` + `WEB_AUTHN` (`InitiateAuth` → `navigator.credentials.get()` → `RespondToAuthChallenge`), then hand off the **same signed ticket** as `/auth/verify` → `/auth/session` resolves the member. Same origin as enrolment (`dev.wanthat.app`), so the RP-ID we just fixed matches — **no Managed Login redirect**. The phone is cached in `localStorage` on every successful sign-in and replayed silently for passkey login.

**Tech stack:** Zod contracts, Hono, `@aws-sdk/client-cognito-identity-provider` (AdminInitiateAuth/AdminRespondToAuthChallenge — already imported + IAM-granted), `@simplewebauthn/browser` `startAuthentication`, React + i18next, AWS CDK.

## Global Constraints
- Branch `passkey-login` off main.
- Login endpoints are **public** (no JWT authorizer — the user isn't signed in). They must be **explicit static routes**, which take precedence over the existing authorizer-protected `/auth/passkey/{proxy+}`.
- Never log the credential or the phone. Login logs carry `sub`/`challengeId` only.
- Reuse the existing ticket + `/auth/session` handoff (ADR-0021: app-auth is Cognito-only, app-core reads Aurora). Do not add Aurora to app-auth.
- Enumeration safety: "no such user" and "no passkey enrolled" return the **same** `passkey_unavailable` error; the SPA silently falls back to OTP.
- Device phone persists across sign-out (that's what enables the next Face ID login). Cleared only by an explicit "use a different number".
- Verification: `pnpm build && pnpm typecheck && pnpm test && pnpm lint && pnpm synth` all green.

---

### Task 1: Contracts — passkey-login request/response

**Files:** `packages/contracts/src/identity/auth.ts`; test `packages/contracts/src/identity/passkey-login.test.ts` (create).

**Produces:** `PasskeyLoginOptionsBody {phone}`, `PasskeyLoginOptionsResponse {challengeId, options}`, `PasskeyLoginVerifyBody {challengeId, credential}`, `PasskeyLoginVerifyResponse` (= `AuthVerifyResponse`).

- [ ] **Step 1 — failing test** `packages/contracts/src/identity/passkey-login.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { PasskeyLoginOptionsBody, PasskeyLoginVerifyBody } from "./auth";

describe("passkey login contracts (ADR-0022 Flow B)", () => {
  it("options body requires a valid phone (the device-remembered username)", () => {
    expect(PasskeyLoginOptionsBody.safeParse({ phone: "+972541234567" }).success).toBe(true);
    expect(PasskeyLoginOptionsBody.safeParse({ phone: "nope" }).success).toBe(false);
    expect(PasskeyLoginOptionsBody.safeParse({}).success).toBe(false);
  });
  it("verify body requires a challengeId and a well-formed assertion", () => {
    expect(PasskeyLoginVerifyBody.safeParse({ challengeId: "c1" }).success).toBe(false);
    const cred = { id: "x", rawId: "x", type: "public-key", response: { clientDataJSON: "a", authenticatorData: "b", signature: "c" } };
    expect(PasskeyLoginVerifyBody.safeParse({ challengeId: "c1", credential: cred }).success).toBe(true);
  });
});
```

- [ ] **Step 2 — run, expect FAIL** (`pnpm --filter @wanthat/contracts test`).

- [ ] **Step 3 — implement.** In `packages/contracts/src/identity/auth.ts`, extend the existing `./passkey` import to also bring in `AuthenticationResponseJSON` and `PublicKeyCredentialRequestOptionsJSON`, then add after the `PasskeyRegisterVerify*` block:

```ts
// POST /auth/passkey/login/options — begin username-hinted passkey login (ADR-0022 Flow B). The
// phone is the Cognito username; on a returning device it is remembered client-side, not prompted.
export const PasskeyLoginOptionsBody = z.object({ phone: PhoneE164 });
export type PasskeyLoginOptionsBody = z.infer<typeof PasskeyLoginOptionsBody>;

export const PasskeyLoginOptionsResponse = z.object({
  challengeId: z.string(),
  options: PublicKeyCredentialRequestOptionsJSON,
});
export type PasskeyLoginOptionsResponse = z.infer<typeof PasskeyLoginOptionsResponse>;

// POST /auth/passkey/login/verify — finish the assertion; hands off the SAME signed ticket as
// /auth/verify, so /auth/session resolves the member exactly like the OTP path (ADR-0021).
export const PasskeyLoginVerifyBody = z.object({
  challengeId: z.string(),
  credential: AuthenticationResponseJSON,
});
export type PasskeyLoginVerifyBody = z.infer<typeof PasskeyLoginVerifyBody>;

export const PasskeyLoginVerifyResponse = AuthVerifyResponse;
export type PasskeyLoginVerifyResponse = AuthVerifyResponse;
```

- [ ] **Step 4 — run, expect PASS**; then `git add packages/contracts && git commit -m "feat(contracts): passkey-login request/response (ADR-0022 Flow B)"`.

---

### Task 2: Cognito wrapper — WEB_AUTHN start/respond

**Files:** `services/app-auth/src/auth/cognito.ts`; test `services/app-auth/src/auth/cognito.passkey.test.ts` (create).

**Produces:** `Cognito.startPasskeyAuth(username) → {session, options}` and `Cognito.respondPasskeyAuth(username, session, credential) → AuthenticationResultType`.

- [ ] **Step 1 — failing test.** Mock `@aws-sdk/client-cognito-identity-provider`'s client `send`. `cognito.passkey.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const send = vi.fn();
vi.mock("@aws-sdk/client-cognito-identity-provider", async (orig) => ({
  ...(await orig<typeof import("@aws-sdk/client-cognito-identity-provider")>()),
  CognitoIdentityProviderClient: vi.fn(() => ({ send })),
}));

import { Cognito } from "./cognito";

const c = new Cognito("pool", "client", "il-central-1");
beforeEach(() => vi.clearAllMocks());

describe("startPasskeyAuth", () => {
  it("initiates USER_AUTH/WEB_AUTHN and returns the parsed request options + session", async () => {
    send.mockResolvedValue({ Session: "sess", ChallengeName: "WEB_AUTHN", ChallengeParameters: { CREDENTIAL_REQUEST_OPTIONS: '{"challenge":"abc"}' } });
    const r = await c.startPasskeyAuth("u1");
    expect(r).toEqual({ session: "sess", options: { challenge: "abc" } });
    const input = send.mock.calls[0][0].input;
    expect(input.AuthFlow).toBe("USER_AUTH");
    expect(input.AuthParameters).toMatchObject({ USERNAME: "u1", PREFERRED_CHALLENGE: "WEB_AUTHN" });
  });
  it("throws when no WEB_AUTHN challenge comes back (no passkey enrolled)", async () => {
    send.mockResolvedValue({ Session: "s", ChallengeName: "SELECT_CHALLENGE", ChallengeParameters: {} });
    await expect(c.startPasskeyAuth("u1")).rejects.toThrow(/WEB_AUTHN/);
  });
});

describe("respondPasskeyAuth", () => {
  it("answers WEB_AUTHN with the stringified credential and returns tokens", async () => {
    send.mockResolvedValue({ AuthenticationResult: { AccessToken: "a", IdToken: "i", RefreshToken: "r", ExpiresIn: 3600 } });
    const cred = { id: "x", type: "public-key" };
    const res = await c.respondPasskeyAuth("u1", "sess", cred);
    expect(res.AccessToken).toBe("a");
    const input = send.mock.calls[0][0].input;
    expect(input.ChallengeName).toBe("WEB_AUTHN");
    expect(input.ChallengeResponses).toMatchObject({ USERNAME: "u1", CREDENTIAL: JSON.stringify(cred) });
  });
});
```

- [ ] **Step 2 — run, expect FAIL.**

- [ ] **Step 3 — implement** in `services/app-auth/src/auth/cognito.ts` (methods on the `Cognito` class, after `respondSmsOtp`; `AdminInitiateAuthCommand`/`AdminRespondToAuthChallengeCommand`/`AuthenticationResultType` are already imported):

```ts
  /**
   * Begin a username-hinted passkey (WebAuthn) login (ADR-0022 Flow B): USER_AUTH with a preferred
   * WEB_AUTHN challenge. Returns the Cognito Session to carry forward and the credential-request
   * options JSON the browser feeds to navigator.credentials.get(). Throws if the pool did not issue a
   * WEB_AUTHN challenge (e.g. the user has no passkey) — the router maps that to passkey_unavailable.
   */
  async startPasskeyAuth(username: string): Promise<{ session: string; options: unknown }> {
    const res = await this.client.send(
      new AdminInitiateAuthCommand({
        UserPoolId: this.userPoolId,
        ClientId: this.clientId,
        AuthFlow: "USER_AUTH",
        AuthParameters: { USERNAME: username, PREFERRED_CHALLENGE: "WEB_AUTHN" },
      }),
    );
    const raw = res.ChallengeParameters?.CREDENTIAL_REQUEST_OPTIONS;
    if (res.ChallengeName !== "WEB_AUTHN" || !res.Session || !raw)
      throw new Error("startPasskeyAuth: pool did not issue a WEB_AUTHN challenge");
    return { session: res.Session, options: JSON.parse(raw) };
  }

  /** Answer the WEB_AUTHN challenge with the browser assertion; tokens on success. */
  async respondPasskeyAuth(
    username: string,
    session: string,
    credential: unknown,
  ): Promise<AuthenticationResultType> {
    const res = await this.client.send(
      new AdminRespondToAuthChallengeCommand({
        UserPoolId: this.userPoolId,
        ClientId: this.clientId,
        ChallengeName: "WEB_AUTHN",
        Session: session,
        ChallengeResponses: { USERNAME: username, CREDENTIAL: JSON.stringify(credential) },
      }),
    );
    if (!res.AuthenticationResult) throw new Error("respondPasskeyAuth: no AuthenticationResult");
    return res.AuthenticationResult;
  }
```

- [ ] **Step 4 — run, expect PASS**; `git add services/app-auth && git commit -m "feat(app-auth): Cognito WEB_AUTHN start/respond for passkey login (ADR-0022)"`.

---

### Task 3: app-auth router — the two public login routes

**Files:** `services/app-auth/src/auth/router.ts`; extend `services/app-auth/src/auth/router.test.ts`.

**Consumes:** Task 1 contracts, Task 2 Cognito methods. **Produces:** `POST /auth/passkey/login/options` (409 `passkey_unavailable` when no user/passkey) and `/auth/passkey/login/verify` (401 `invalid_passkey` on a rejected assertion; else a `registrationTicket`).

- [ ] **Step 1 — failing tests** appended to `router.test.ts` (add `startPasskeyAuth: vi.fn()`, `respondPasskeyAuth: vi.fn()` to the `fake.cognito` mock object):

```ts
describe("POST /auth/passkey/login/options (ADR-0022 Flow B)", () => {
  it("starts a WEB_AUTHN challenge and stores it, returns options", async () => {
    fake.cognito.getUserByPhone.mockResolvedValue({ username: "u", sub: SUB });
    fake.cognito.startPasskeyAuth.mockResolvedValue({ session: "sess", options: { challenge: "abc" } });
    const res = await post("/auth/passkey/login/options", { phone: PHONE });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ options: { challenge: "abc" } });
    expect(fake.challenges.putChallenge).toHaveBeenCalledWith(
      expect.objectContaining({ username: "u", sub: SUB, phone: PHONE, cognitoSession: "sess" }),
    );
  });
  it("409 passkey_unavailable when the phone has no user (no existence oracle)", async () => {
    fake.cognito.getUserByPhone.mockResolvedValue(null);
    const res = await post("/auth/passkey/login/options", { phone: PHONE });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "passkey_unavailable" });
    expect(fake.cognito.startPasskeyAuth).not.toHaveBeenCalled();
  });
  it("409 passkey_unavailable when no WEB_AUTHN challenge is issued (no passkey enrolled)", async () => {
    fake.cognito.getUserByPhone.mockResolvedValue({ username: "u", sub: SUB });
    fake.cognito.startPasskeyAuth.mockRejectedValue(new Error("no WEB_AUTHN"));
    const res = await post("/auth/passkey/login/options", { phone: PHONE });
    expect(res.status).toBe(409);
  });
});

describe("POST /auth/passkey/login/verify", () => {
  const challenge = { challengeId: "c1", username: "u", sub: SUB, phone: PHONE, cognitoSession: "sess", isNewUser: false, resendAfterEpoch: 0, attempts: 0, ttl: 0 };
  it("verifies the assertion and hands off a signed ticket", async () => {
    fake.challenges.getChallenge.mockResolvedValue(challenge);
    fake.cognito.respondPasskeyAuth.mockResolvedValue(cognitoResult);
    fake.tickets.sign.mockResolvedValue("signed-ticket");
    const cred = { id: "x", rawId: "x", type: "public-key", response: { clientDataJSON: "a", authenticatorData: "b", signature: "c" } };
    const res = await post("/auth/passkey/login/verify", { challengeId: "c1", credential: cred });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ registrationTicket: "signed-ticket" });
    expect(fake.challenges.deleteChallenge).toHaveBeenCalledWith("c1");
    expect(fake.tickets.sign).toHaveBeenCalledWith(expect.objectContaining({ sub: SUB, phone: PHONE }));
  });
  it("401 invalid_passkey on a rejected assertion", async () => {
    fake.challenges.getChallenge.mockResolvedValue(challenge);
    fake.cognito.respondPasskeyAuth.mockRejectedValue(Object.assign(new Error("bad"), { name: "NotAuthorizedException" }));
    const cred = { id: "x", rawId: "x", type: "public-key", response: { clientDataJSON: "a", authenticatorData: "b", signature: "c" } };
    const res = await post("/auth/passkey/login/verify", { challengeId: "c1", credential: cred });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid_passkey" });
  });
});
```

- [ ] **Step 2 — run, expect FAIL.**

- [ ] **Step 3 — implement.** Add `PasskeyLoginOptionsBody`, `PasskeyLoginOptionsResponse`, `PasskeyLoginVerifyBody` to the `@wanthat/contracts` import in `router.ts`. Insert both routes just after the existing `/passkey/register/verify` route (before `return auth;`):

```ts
  // POST /auth/passkey/login/options — begin username-hinted passkey login (ADR-0022 Flow B).
  // Public (the assertion is the credential). The phone is the device-remembered Cognito username,
  // never prompted on a known device. "no user" and "no passkey" collapse to one error (no oracle).
  auth.post("/passkey/login/options", async (c) => {
    const body = await parseBody(c, PasskeyLoginOptionsBody);
    if (!body) return c.json({ error: "invalid_request" }, 400);
    const ctx = getContext();
    const phone = normalizePhone(body.phone);
    if (!phone) return c.json({ error: "invalid_request" }, 400);

    const user = await ctx.cognito.getUserByPhone(phone);
    if (!user) return c.json({ error: "passkey_unavailable" }, 409);

    let session: string;
    let options: unknown;
    try {
      ({ session, options } = await ctx.cognito.startPasskeyAuth(user.username));
    } catch {
      return c.json({ error: "passkey_unavailable" }, 409);
    }

    const challengeId = randomUUID();
    const now = nowEpoch();
    await ctx.challenges.putChallenge({
      challengeId,
      username: user.username,
      sub: user.sub,
      phone,
      cognitoSession: session,
      isNewUser: false,
      resendAfterEpoch: now + RESEND_COOLDOWN_SEC,
      attempts: 0,
      ttl: now + CHALLENGE_TTL_SEC,
    });
    logger.info("passkey_login_start", { challengeId, sub: user.sub });
    return c.json(PasskeyLoginOptionsResponse.parse({ challengeId, options }));
  });

  // POST /auth/passkey/login/verify — finish; hand off the SAME signed ticket as /auth/verify so
  // /auth/session (app-core) resolves the member. The passkey holder is always already registered.
  auth.post("/passkey/login/verify", async (c) => {
    const body = await parseBody(c, PasskeyLoginVerifyBody);
    if (!body) return c.json({ error: "invalid_request" }, 400);
    const ctx = getContext();

    const challenge = await ctx.challenges.getChallenge(body.challengeId);
    if (!challenge) return c.json({ error: "challenge_not_found" }, 404);

    let result: Awaited<ReturnType<typeof ctx.cognito.respondPasskeyAuth>>;
    try {
      result = await ctx.cognito.respondPasskeyAuth(
        challenge.username,
        challenge.cognitoSession,
        body.credential,
      );
    } catch (err) {
      if (err instanceof Error && OTP_REJECTION_ERRORS.has(err.name)) {
        await ctx.challenges.deleteChallenge(challenge.challengeId);
        return c.json({ error: "invalid_passkey" }, 401);
      }
      throw err;
    }

    await ctx.challenges.deleteChallenge(challenge.challengeId);
    const tokens = toAuthTokens(result);
    const registrationTicket = await ctx.tickets.sign({
      sub: challenge.sub,
      phone: challenge.phone,
      accessToken: tokens.accessToken,
      idToken: tokens.idToken,
      refreshToken: tokens.refreshToken,
      expiresIn: tokens.expiresIn,
      exp: nowEpoch() + TICKET_TTL_SEC,
    });
    logger.info("passkey_login_ok", { sub: challenge.sub });
    return c.json(AuthVerifyResponse.parse({ registrationTicket }));
  });
```

- [ ] **Step 4 — run, expect PASS** (`pnpm --filter @wanthat/app-auth test && ... typecheck`); commit `feat(app-auth): /auth/passkey/login/{options,verify} public routes (ADR-0022 Flow B)`.

---

### Task 4: Infra — public login routes on the HTTP API

**Files:** `infra/lib/api-stack.ts`.

- [ ] **Step 1 — implement.** After the existing public `/auth/*` POST route loop (the one adding `/auth/start` … `/auth/signout`), add:

```ts
    // Passkey LOGIN (ADR-0022 Flow B) -> app-auth, PUBLIC (the assertion is the credential; the user
    // is not signed in yet). Explicit static routes so they take precedence over the authorizer-
    // protected /auth/passkey/{proxy+} enrolment route below.
    for (const p of ["/auth/passkey/login/options", "/auth/passkey/login/verify"]) {
      this.httpApi.addRoutes({ path: p, methods: [HttpMethod.POST], integration: authIntegration });
    }
```

- [ ] **Step 2 — verify.** `pnpm build && pnpm synth`; confirm the dev api template contains routes `POST /auth/passkey/login/options` and `/auth/passkey/login/verify` with **no** `AuthorizerId`, and that `/auth/passkey/{proxy+}` still has its authorizer. Commit `feat(infra): public passkey-login routes (ADR-0022 Flow B)`.

---

### Task 5: SPA — remembered phone, passkey login, device-matched CTA, OTP fallback

**Files:** create `apps/web/src/lib/device.ts`; modify `apps/web/src/lib/session.tsx`, `apps/web/src/lib/api.ts`, `apps/web/src/lib/passkey.ts`, `apps/web/src/features/auth/AuthPage.tsx`, `apps/web/src/i18n.ts`. Update `apps/web/src/lib/api.test.ts` if it asserts the old signatures.

- [ ] **Step 1 — device memory.** Create `apps/web/src/lib/device.ts`:

```ts
/**
 * Device memory (ADR-0022 Flow B). The phone is the Cognito username; remembering it after a
 * successful sign-in lets a returning device offer "visit -> biometric -> in" with no phone prompt.
 * It is the user's own number on their own device (a "remember me"), kept across sign-out so the
 * next passkey login needs no typing; cleared only by an explicit "use a different number".
 */
const KEY = "wanthat.devicePhone";
export const rememberDevicePhone = (phoneE164: string): void => localStorage.setItem(KEY, phoneE164);
export const rememberedDevicePhone = (): string | null => localStorage.getItem(KEY);
export const forgetDevicePhone = (): void => localStorage.removeItem(KEY);
```

- [ ] **Step 2 — persist on every sign-in.** In `session.tsx`, import `rememberDevicePhone` and call it inside `signIn`, right after the refresh-token write:

```ts
  const signIn = useCallback((session: AuthSession) => {
    setTokens(session.tokens);
    setCustomer(session.customer);
    localStorage.setItem(REFRESH_KEY, session.tokens.refreshToken);
    rememberDevicePhone(session.customer.phone); // ADR-0022 Flow B: enable next-visit Face ID login
  }, []);
```

- [ ] **Step 3 — api client.** In `apps/web/src/lib/api.ts` add to `authApi` (types `PasskeyLoginOptionsResponse`, `AuthVerifyResponse` are in `@wanthat/contracts`):

```ts
  passkeyLoginOptions: (phone: string) =>
    request<PasskeyLoginOptionsResponse>("/auth/passkey/login/options", { method: "POST", body: { phone } }),
  passkeyLoginVerify: (challengeId: string, credential: unknown) =>
    request<AuthVerifyResponse>("/auth/passkey/login/verify", { method: "POST", body: { challengeId, credential } }),
```

- [ ] **Step 4 — passkey login lib.** In `apps/web/src/lib/passkey.ts` add (import `startAuthentication` from `@simplewebauthn/browser`, `AuthSession` type from `@wanthat/contracts`):

```ts
/**
 * Username-hinted passkey login (ADR-0022 Flow B): fetch the WebAuthn assertion options for the
 * remembered phone, run the biometric ceremony, verify, then resolve the session. Same origin as
 * enrolment, so the passkey's RP-ID matches — no hosted-UI redirect. Throws on cancel/failure; the
 * caller falls back to OTP.
 */
export async function loginWithPasskey(phone: string): Promise<AuthSession> {
  const { challengeId, options } = await authApi.passkeyLoginOptions(phone);
  // biome-ignore lint/suspicious/noExplicitAny: options is the server-generated WebAuthn document
  const credential = await startAuthentication({ optionsJSON: options as any });
  const { registrationTicket } = await authApi.passkeyLoginVerify(challengeId, credential);
  const res = await authApi.session(registrationTicket);
  if (res.status !== "authenticated") throw new Error("passkey login did not resolve a session");
  return { tokens: res.tokens, customer: res.customer };
}
```

- [ ] **Step 5 — device-matched biometric label.** Add to `apps/web/src/lib/passkey.ts`:

```ts
/** The i18n key suffix for the biometric label matching this device (ADR-0022 decision 1). */
export function biometricLabelKey(): "faceId" | "touchId" | "windowsHello" | "generic" {
  if (typeof navigator === "undefined") return "generic";
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua)) return "faceId";
  if (/Macintosh/.test(ua)) return "touchId";
  if (/Windows/.test(ua)) return "windowsHello";
  return "generic";
}
```

- [ ] **Step 6 — AuthPage.** Wire Flow B as the primary path when a phone is remembered:
  - Imports: drop `beginPasskeyLogin`; import `loginWithPasskey, passkeysSupported, enrollPasskey, biometricLabelKey` from `../../lib/passkey`, and `rememberedDevicePhone, forgetDevicePhone` from `../../lib/device`.
  - State: `const [knownPhone, setKnownPhone] = useState<string | null>(null);` and in a `useEffect(() => setKnownPhone(rememberedDevicePhone()), [])`.
  - A biometric label: `const bioLabel = t(\`auth.biometric.${biometricLabelKey()}\`);`
  - New handler:

    ```ts
    const onPasskeyLogin = () =>
      run(async () => {
        if (!knownPhone) return;
        const session = await loginWithPasskey(knownPhone);
        signIn(session);
        navigate("/home", { replace: true });
      });
    ```
  - On the `phone` step, **above** the phone field, when `knownPhone && passkeysSupported()`, render a primary CTA and a divider, and demote the phone form to "use a code / different number":

    ```tsx
    {knownPhone && passkeysSupported() && (
      <div className="flex flex-col gap-2">
        <Button onClick={onPasskeyLogin} loading={busy}>
          {t("auth.passkeyCta", { label: bioLabel })}
        </Button>
        <Button
          variant="ghost"
          onClick={() => { forgetDevicePhone(); setKnownPhone(null); }}
        >
          {t("auth.differentNumber")}
        </Button>
      </div>
    )}
    ```

    Keep the existing phone input + `onStart` button rendered **below**, so OTP is always available as the fallback (ADR-0022 decision 5). Remove the old `beginPasskeyLogin` ghost button entirely.
  - If `onPasskeyLogin` fails (cancel / `passkey_unavailable` / `invalid_passkey`), the existing `run()` catch shows the error and the phone form is already visible — no extra work. (Do NOT `forgetDevicePhone` on failure; the phone is still valid, the user may just have cancelled the biometric.)

- [ ] **Step 7 — i18n.** Add to `en.auth` (and mirror in `he.auth`, since `he: typeof en`):

```ts
    passkeyCta: "Sign in with {{label}}",
    differentNumber: "Use a different number",
    biometric: { faceId: "Face ID", touchId: "Touch ID", windowsHello: "Windows Hello", generic: "a passkey" },
```

Hebrew:

```ts
    passkeyCta: "כניסה עם {{label}}",
    differentNumber: "מספר אחר",
    biometric: { faceId: "Face ID", touchId: "Touch ID", windowsHello: "Windows Hello", generic: "מפתח גישה" },
```

Add to `en.auth.errors` / `he.auth.errors`:

```ts
      passkey_unavailable: "No passkey found for this device. Sign in with a code.",  // he: "לא נמצא מפתח גישה במכשיר. היכנסו עם קוד."
      invalid_passkey: "Biometric sign-in failed. Try again or use a code.",           // he: "הכניסה הביומטרית נכשלה. נסו שוב או היכנסו עם קוד."
```

Remove the now-unused `auth.passkeyLogin` key (it was the old Managed Login button).

- [ ] **Step 8 — verify + commit.** `pnpm --filter @wanthat/web typecheck && pnpm --filter @wanthat/web test && pnpm --filter @wanthat/web build && pnpm lint`. Commit `feat(web): passkey login with remembered phone + device-matched CTA (ADR-0022 Flow B)`.

---

### Task 6: Finalize — full verification + PR

- [ ] **Step 1.** `pnpm install && pnpm build && pnpm typecheck && pnpm test && pnpm lint && pnpm synth` — all green.
- [ ] **Step 2.** Push, open PR (ready) titled `feat: passkey (Face ID) login — remembered phone, no re-prompt (ADR-0022 Flow B)`, body summarizing the flow, the RP-ID reuse (no redirect), the enumeration-safe error, and that the phone is stored per user request. Post-merge validation is on-device (automated browser has no platform authenticator).

## Note on Managed Login (Flow C)
This plan leaves `managed-login.ts` / `CallbackPage` in place but no longer links to them from the customer flow (the old "sign in with a passkey" ghost button is removed). Flow C (userless hosted-UI login) is currently non-functional anyway — its origin is the Cognito domain, which can't consume a passkey bound to the site RP-ID — and making it work needs a custom auth domain (separate future ADR/slice). Fresh devices without a remembered phone therefore use OTP (ADR-0022 decision 5), which always works. Call this out in the PR; do not delete the files in this slice.
