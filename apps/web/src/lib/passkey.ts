import {
  browserSupportsWebAuthnAutofill,
  startAuthentication,
  startRegistration,
} from "@simplewebauthn/browser";
import type { AuthSession } from "@wanthat/contracts";
import { authApi } from "./api";

/** Whether this browser can create platform passkeys (FaceID/TouchID/Windows Hello). */
export function passkeysSupported(): boolean {
  return typeof window !== "undefined" && !!window.PublicKeyCredential;
}

const PASSKEY_DEVICE_KEY = "wanthat.passkeyDevice";

/**
 * Mark that this device has successfully used a passkey here (login or enrolment). On the next visit
 * the auth screen fires an AUTOMATIC modal passkey prompt on load (Face ID pops with no tap). We gate
 * the auto-prompt on this flag so a brand-new visitor / signup is NOT hit with a Face ID sheet they
 * can't satisfy — they get the gentle autofill offer first, which sets this flag once they use it.
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
 * a field's autofill (ADR-0024 Slice 2). When true we arm {@link loginWithPasskeyAutofill} instead of
 * showing an explicit button; when false the explicit modal button ({@link loginWithPasskey}) is the
 * path. Never throws.
 */
export async function passkeyAutofillSupported(): Promise<boolean> {
  try {
    return await browserSupportsWebAuthnAutofill();
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
 * with `NotAllowedError: The document is not focused.` — observed on-device. Wait briefly for focus
 * before starting; on timeout proceed anyway (the ceremony then fails exactly as it does today and
 * the caller's fallback runs).
 */
async function waitForDocumentFocus(timeoutMs = 3000): Promise<void> {
  if (typeof document === "undefined" || document.hasFocus()) return;
  await new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      window.removeEventListener("focus", done);
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    window.addEventListener("focus", done, { once: true });
  });
}

/**
 * Userless discoverable passkey login (ADR-0024): no phone/username anywhere. The server's login
 * challenge carries an empty allowCredentials, so the OS shows a modal picker with the member's
 * passkeys registered for this origin; the member taps one and authenticates biometrically. Same
 * origin as enrolment, so the passkey's RP-ID matches — no hosted-UI redirect. Throws on
 * cancel/failure; the caller falls back to OTP.
 */
export async function loginWithPasskey(): Promise<AuthSession> {
  await waitForDocumentFocus();
  const { challengeId, options } = await authApi.passkeyLoginChallenge();
  // Modal discoverable get(): the server sent an empty allowCredentials, so the OS shows the
  // member's passkeys for this origin. Used only where conditional UI is unsupported.
  // biome-ignore lint/suspicious/noExplicitAny: server-generated WebAuthn document
  const credential = await startAuthentication({ optionsJSON: options as any });
  return finishPasskeyLogin(challengeId, credential);
}

/**
 * Arm WebAuthn *conditional UI* (autofill) for userless discoverable login (ADR-0024 Slice 2). The
 * passkey offers itself in the autofill of a field marked `autocomplete="… webauthn"`; this promise
 * stays pending until the member picks it and authenticates biometrically, then resolves a session.
 * Same empty-allowCredentials challenge as the modal path — only `useBrowserAutofill` differs. Only
 * ONE conditional get() may be pending, and it must not run alongside the modal button (the caller
 * shows the button ONLY when autofill is unsupported, so the two never collide). Rejects on
 * abort/cancel/failure; the caller falls back to OTP silently.
 */
export async function loginWithPasskeyAutofill(): Promise<AuthSession> {
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
