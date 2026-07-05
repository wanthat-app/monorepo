import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import type { AuthSession } from "@wanthat/contracts";
import { authApi } from "./api";

/** Whether this browser can create platform passkeys (FaceID/TouchID/Windows Hello). */
export function passkeysSupported(): boolean {
  return typeof window !== "undefined" && !!window.PublicKeyCredential;
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
 * Userless discoverable passkey login (ADR-0024): no phone/username anywhere. The server's login
 * challenge carries an empty allowCredentials, so the OS shows a modal picker with the member's
 * passkeys registered for this origin; the member taps one and authenticates biometrically. Same
 * origin as enrolment, so the passkey's RP-ID matches — no hosted-UI redirect. Throws on
 * cancel/failure; the caller falls back to OTP.
 */
export async function loginWithPasskey(): Promise<AuthSession> {
  const { challengeId, options } = await authApi.passkeyLoginChallenge();
  // Modal discoverable get(): the server sent an empty allowCredentials, so the OS shows the
  // member's passkeys for this origin. (Autofill/conditional UI is Slice 2.)
  // biome-ignore lint/suspicious/noExplicitAny: server-generated WebAuthn document
  const credential = await startAuthentication({ optionsJSON: options as any });
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
