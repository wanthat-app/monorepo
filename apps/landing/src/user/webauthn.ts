import { startAuthentication } from "@simplewebauthn/browser";

/**
 * Browser WebAuthn helpers for the Cognito-native passkey login (ADR-0006 decision 2).
 * Landing subset of the member app's webauthn.ts: only the ASSERTION ceremony the returning-
 * member auto-login runs — no enrolment, no conditional-UI discovery (a device with no
 * remembered phone gets the sign-up/login CTAs into the member app instead).
 */

/** Whether this browser can use platform passkeys (Face ID / Touch ID / Windows Hello). */
export function passkeysSupported(): boolean {
  return typeof window !== "undefined" && !!window.PublicKeyCredential;
}

/**
 * A load-time (auto-prompt) `get()` races the page actually gaining focus: arriving from the
 * URL bar or an external link (how every shared /p/ link opens), iOS Safari rejects the
 * ceremony immediately with `NotAllowedError: The document is not focused.` — observed
 * on-device. So the ceremony ARMS on focus: it waits (indefinitely — no timeout racing the
 * OS into a guaranteed failure) and fires the moment the document gains focus — often right
 * after load, at worst on the member's first tap anywhere. Callers must not block rendering
 * on this promise. `pointerdown` is the belt-and-braces companion signal for engines whose
 * `focus` delivery is unreliable on load.
 */
export async function waitForDocumentFocus(): Promise<void> {
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
 * Run the assertion ceremony over Cognito's `CREDENTIAL_REQUEST_OPTIONS` document and return
 * the JSON-serialisable credential for `RespondToAuthChallenge(CREDENTIAL = …)`.
 */
export function getAssertion(optionsJSON: unknown) {
  // biome-ignore lint/suspicious/noExplicitAny: Cognito-generated WebAuthn document
  return startAuthentication({ optionsJSON: optionsJSON as any });
}

/** The i18n key suffix for the biometric label matching this device (ADR-0006). */
export function biometricLabelKey(): "faceId" | "touchId" | "windowsHello" | "generic" {
  if (typeof navigator === "undefined") return "generic";
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua)) return "faceId";
  if (/Macintosh/.test(ua)) return "touchId";
  if (/Windows/.test(ua)) return "windowsHello";
  return "generic";
}
