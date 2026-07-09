import { startAuthentication, startRegistration } from "@simplewebauthn/browser";

/**
 * Browser WebAuthn helpers for the Cognito-native passkey flows (ADR-0006 decision 2).
 * Cognito runs the protocol (challenge mint + verification); this file only drives the
 * browser ceremony and the UX gates that survived the native migration: focus-arming and
 * device-matched biometric labels. The userless/conditional-UI machinery of the replaced
 * app-owned design (autofill, immediate mode) is gone — the gate is "a remembered phone
 * exists AND a passkey ceremony succeeded on this device" (store.rememberedPhone +
 * passkey-device.ts).
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

/**
 * Run the creation ceremony over Cognito's `CredentialCreationOptions` document and return
 * the JSON-serialisable attestation for `CompleteWebAuthnRegistration`.
 */
export function createCredential(optionsJSON: unknown) {
  // biome-ignore lint/suspicious/noExplicitAny: Cognito-generated WebAuthn document
  return startRegistration({ optionsJSON: optionsJSON as any });
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
