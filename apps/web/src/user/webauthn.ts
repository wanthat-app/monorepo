import { startAuthentication, startRegistration } from "@simplewebauthn/browser";

/**
 * Browser WebAuthn helpers for the Cognito-native passkey flows (ADR-0006 decision 2).
 * Cognito runs the protocol (challenge mint + verification); this file only drives the
 * browser ceremonies: focus-arming, device-matched biometric labels, and the conditional-UI
 * (autofill) DISCOVERY ceremony for devices with no remembered phone. Whether a passkey can
 * actually sign someone in is Cognito's answer (`AvailableChallenges` — see
 * actions.passkeyLoginAvailable), not a client-side flag.
 */

/** Whether this browser can use platform passkeys (Face ID / Touch ID / Windows Hello). */
export function passkeysSupported(): boolean {
  return typeof window !== "undefined" && !!window.PublicKeyCredential;
}

/** Whether the browser supports conditional-UI (autofill) passkey mediation. */
export async function conditionalMediationSupported(): Promise<boolean> {
  return (
    passkeysSupported() &&
    typeof PublicKeyCredential.isConditionalMediationAvailable === "function" &&
    (await PublicKeyCredential.isConditionalMediationAvailable().catch(() => false))
  );
}

/**
 * Conditional (autofill) discovery ceremony: a pending non-modal `get()` that makes the
 * browser surface this site's passkey in the phone field's autofill IFF one exists on the
 * device — the only web-platform way to show a passkey affordance exactly when a credential
 * exists (silent presence queries are deliberately impossible). The challenge is a throwaway:
 * the assertion is never sent anywhere — its sole output is the `userHandle` naming the
 * Cognito account (the pool's UUID username), which the caller feeds into the REAL,
 * server-verified WEB_AUTHN flow. Resolves null on abort/dismissal/no-support.
 */
export async function discoverPasskeyUser(signal: AbortSignal): Promise<string | null> {
  try {
    const credential = (await navigator.credentials.get({
      mediation: "conditional",
      signal,
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        userVerification: "preferred",
        allowCredentials: [],
      },
    })) as PublicKeyCredential | null;
    const response = credential?.response as AuthenticatorAssertionResponse | undefined;
    if (!response?.userHandle) return null;
    return new TextDecoder().decode(new Uint8Array(response.userHandle));
  } catch {
    return null; // aborted / dismissed / unsupported — the visible flows stay in charge
  }
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
