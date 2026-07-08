import {
  browserSupportsWebAuthnAutofill,
  startAuthentication,
  startRegistration,
  WebAuthnAbortService,
} from "@simplewebauthn/browser";
import type { AuthSession, AuthTokens } from "@wanthat/contracts";
import { authApi } from "./api";

/** Whether this browser can create platform passkeys (FaceID/TouchID/Windows Hello). */
export function passkeysSupported(): boolean {
  return typeof window !== "undefined" && !!window.PublicKeyCredential;
}

const PASSKEY_DEVICE_KEY = "wanthat.passkeyDevice";

/**
 * Mark that this device has successfully used a passkey here (login or enrolment). FALLBACK hint for
 * browsers without immediate-mode get() (see {@link passkeyImmediateSupported} — Safari, Firefox):
 * there the next visit fires an AUTOMATIC modal passkey prompt on load, gated on this flag so a
 * brand-new visitor / signup is NOT hit with a Face ID sheet they can't satisfy. Where immediate
 * mode exists the browser itself knows whether a local passkey exists, and this flag is not read.
 */
export function markPasskeyDevice(): void {
  try {
    localStorage.setItem(PASSKEY_DEVICE_KEY, "1");
  } catch {
    // storage disabled (private mode) — degrade to the non-auto path, no crash.
  }
}

/** Whether this device has used a passkey here before (gates the auto-prompt on load). */
export function deviceHasPasskey(): boolean {
  try {
    return localStorage.getItem(PASSKEY_DEVICE_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Whether this browser supports WebAuthn *conditional UI* (autofill) — the passkey offering itself in
 * a field's autofill (ADR-0022 Slice 2). When true we arm {@link loginWithPasskeyAutofill} alongside
 * the always-visible modal button ({@link loginWithPasskey}). Never throws.
 */
export async function passkeyAutofillSupported(): Promise<boolean> {
  try {
    return await browserSupportsWebAuthnAutofill();
  } catch {
    return false;
  }
}

/**
 * Whether this browser supports *immediate-mode* get() (`uiMode: "immediate"`, Chrome 149+): the
 * sheet fires ONLY when a locally-available passkey exists (including iCloud-synced ones) and
 * rejects silently otherwise — the zero-storage replacement for the {@link deviceHasPasskey} flag.
 * Detection MUST come first: unknown dictionary members are ignored by WebIDL, so a blind
 * `uiMode` call on a non-supporting browser degrades to a full modal picker at every new visitor.
 */
export async function passkeyImmediateSupported(): Promise<boolean> {
  try {
    const pkc = globalThis.PublicKeyCredential as
      | { getClientCapabilities?: () => Promise<Record<string, boolean | undefined>> }
      | undefined;
    const caps = await pkc?.getClientCapabilities?.();
    return caps?.immediateGet === true;
  } catch {
    return false;
  }
}

/**
 * Enrol a passkey for the signed-in member (ADR-0006): fetch Cognito's creation options, run the
 * WebAuthn ceremony in the browser, and register the attestation. Returns the new credential id.
 */
export async function enrollPasskey(accessToken: string): Promise<string> {
  const { challengeId, options } = await authApi.passkeyRegisterOptions(accessToken);
  // Cognito returns standard WebAuthn creation-options JSON, which startRegistration consumes.
  const credential = await startRegistration({
    // biome-ignore lint/suspicious/noExplicitAny: options is the server-generated WebAuthn document
    optionsJSON: options as any,
  });
  const { passkey } = await authApi.passkeyRegisterVerify(challengeId, credential, accessToken);
  return passkey.credentialId;
}

/**
 * A load-time (auto-prompt) `get()` races the page actually gaining focus: arriving from the URL bar
 * or an external link (how every shared /p/ link opens), iOS Safari rejects the ceremony immediately
 * with `NotAllowedError: The document is not focused.` — observed on-device. So the ceremony ARMS on
 * focus: it waits (indefinitely — no timeout racing the OS into a guaranteed failure; observed
 * on-device that 3s can pass without focus) and fires the moment the document gains focus — often
 * right after load, at worst on the member's first tap anywhere. Callers must not block rendering on
 * this promise. `pointerdown` is the belt-and-braces companion signal for engines whose `focus`
 * delivery is unreliable on load.
 */
async function waitForDocumentFocus(): Promise<void> {
  if (typeof document === "undefined" || document.hasFocus()) return;
  await new Promise<void>((resolve) => {
    const done = () => {
      window.removeEventListener("focus", done);
      window.removeEventListener("pointerdown", done);
      resolve();
    };
    window.addEventListener("focus", done, { once: true });
    window.addEventListener("pointerdown", done, { once: true });
  });
}

/**
 * Immediate-mode get() needs *transient user activation* — browsers reject a gesture-free call so a
 * page can't silently probe on load whether a passkey exists (a tracking vector). So the ceremony
 * arms on the member's FIRST interaction of any kind (tap/click/key) and resolves at once when
 * activation is already live. Same contract as {@link waitForDocumentFocus}: callers must not block
 * rendering on this promise.
 */
async function waitForUserActivation(): Promise<void> {
  const ua = (navigator as { userActivation?: { isActive: boolean } }).userActivation;
  if (ua?.isActive) return;
  await new Promise<void>((resolve) => {
    const done = () => {
      window.removeEventListener("pointerdown", done);
      window.removeEventListener("keydown", done);
      resolve();
    };
    window.addEventListener("pointerdown", done, { once: true });
    window.addEventListener("keydown", done, { once: true });
  });
}

/** Login ceremony flavours: the classic modal picker, or immediate mode (see
 * {@link passkeyImmediateSupported}) which pops biometrics iff a local passkey exists. */
type LoginMode = "modal" | "immediate";

/**
 * Run the assertion ceremony natively with `uiMode: "immediate"` — @simplewebauthn/browser (13.x)
 * has no uiMode passthrough. Only reached behind {@link passkeyImmediateSupported}, where
 * `parseRequestOptionsFromJSON` and `toJSON` are guaranteed to exist.
 */
async function getImmediateAssertion(
  optionsJSON: unknown,
): Promise<Awaited<ReturnType<typeof startAuthentication>>> {
  const pkc = globalThis.PublicKeyCredential as unknown as {
    parseRequestOptionsFromJSON(json: unknown): PublicKeyCredentialRequestOptions;
  };
  const cred = (await navigator.credentials.get({
    publicKey: pkc.parseRequestOptionsFromJSON(optionsJSON),
    uiMode: "immediate",
    // Broker through the shared abort service: this both cancels a pending conditional-UI get()
    // (which would block this request) and lets any LATER simplewebauthn ceremony (the manual
    // button's modal get(), enrolment's create()) cancel this one instead of colliding with it.
    signal: WebAuthnAbortService.createNewAbortSignal(),
  } as CredentialRequestOptions)) as unknown as {
    toJSON(): Awaited<ReturnType<typeof startAuthentication>>;
  };
  return cred.toJSON();
}

/** Shared front half of both login flows: gate the ceremony (activation for immediate mode, focus
 * otherwise), fetch a fresh challenge only once armed, and run the matching assertion ceremony. */
async function runLoginCeremony(mode: LoginMode) {
  await (mode === "immediate" ? waitForUserActivation() : waitForDocumentFocus());
  const { challengeId, options } = await authApi.passkeyLoginChallenge();
  const credential =
    mode === "immediate"
      ? await getImmediateAssertion(options)
      : // Modal discoverable get(): the server sent an empty allowCredentials, so the OS shows the
        // member's passkeys for this origin.
        // biome-ignore lint/suspicious/noExplicitAny: server-generated WebAuthn document
        await startAuthentication({ optionsJSON: options as any });
  return { challengeId, credential };
}

/**
 * Userless discoverable passkey login (ADR-0022): no phone/username anywhere. The server's login
 * challenge carries an empty allowCredentials, so the OS shows a modal picker with the member's
 * passkeys registered for this origin; the member taps one and authenticates biometrically. Same
 * origin as enrolment, so the passkey's RP-ID matches — no hosted-UI redirect. Throws on
 * cancel/failure; the caller falls back to OTP.
 */
export async function loginWithPasskey(opts?: {
  /** Fires right after the biometric succeeds, BEFORE the server round-trips (verify + session
   * resolve — which can ride a cold-Aurora resume). Lets the caller show "signing you in…". */
  onCredential?: () => void;
  /** "immediate" (behind {@link passkeyImmediateSupported}) waits for the first user interaction,
   * then pops the sheet only when a local passkey exists — silent rejection otherwise. */
  mode?: LoginMode;
}): Promise<AuthSession> {
  const { challengeId, credential } = await runLoginCeremony(opts?.mode ?? "modal");
  opts?.onCredential?.();
  return finishPasskeyLogin(challengeId, credential);
}

/**
 * Aurora-free passkey login for the referral landing (ADR-0007): verify the assertion and take the
 * minted Cognito tokens straight off the verify response — NO `/auth/session` (which reads Aurora).
 * A passkey credential maps to an existing member by construction, and the landing only needs a
 * session to persist before redirecting to the store; the profile loads later (e.g. on /home).
 */
export async function loginWithPasskeyTokens(opts?: {
  /** See {@link loginWithPasskey}. */
  onCredential?: () => void;
  /** See {@link loginWithPasskey}. */
  mode?: LoginMode;
}): Promise<AuthTokens> {
  const { challengeId, credential } = await runLoginCeremony(opts?.mode ?? "modal");
  opts?.onCredential?.();
  const { tokens } = await authApi.passkeyLoginVerify(challengeId, credential);
  return tokens;
}

/**
 * Arm WebAuthn *conditional UI* (autofill) for userless discoverable login (ADR-0022 Slice 2). The
 * passkey offers itself in the autofill of a field marked `autocomplete="… webauthn"`; this promise
 * stays pending until the member picks it and authenticates biometrically, then resolves a session.
 * Same empty-allowCredentials challenge as the modal path — only `useBrowserAutofill` differs. Only
 * ONE conditional get() may be pending, and it must not run alongside the modal button (the caller
 * shows the button ONLY when autofill is unsupported, so the two never collide). Rejects on
 * abort/cancel/failure; the caller falls back to OTP silently.
 */
export async function loginWithPasskeyAutofill(): Promise<AuthSession> {
  await waitForDocumentFocus();
  const { challengeId, options } = await authApi.passkeyLoginChallenge();
  const credential = await startAuthentication({
    // biome-ignore lint/suspicious/noExplicitAny: server-generated WebAuthn document
    optionsJSON: options as any,
    useBrowserAutofill: true,
  });
  return finishPasskeyLogin(challengeId, credential);
}

/** Shared tail of both passkey-login paths: verify the assertion server-side, resolve the session. */
async function finishPasskeyLogin(
  challengeId: string,
  credential: Awaited<ReturnType<typeof startAuthentication>>,
): Promise<AuthSession> {
  const { registrationTicket } = await authApi.passkeyLoginVerify(challengeId, credential);
  const res = await authApi.session(registrationTicket);
  if (res.status !== "authenticated") throw new Error("passkey login did not resolve a session");
  return { tokens: res.tokens, customer: res.customer };
}

/** The i18n key suffix for the biometric label matching this device (ADR-0022 decision 1). */
export function biometricLabelKey(): "faceId" | "touchId" | "windowsHello" | "generic" {
  if (typeof navigator === "undefined") return "generic";
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua)) return "faceId";
  if (/Macintosh/.test(ua)) return "touchId";
  if (/Windows/.test(ua)) return "windowsHello";
  return "generic";
}
