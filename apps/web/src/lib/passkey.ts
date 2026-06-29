import { startRegistration } from "@simplewebauthn/browser";
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
  const { options } = await authApi.passkeyRegisterOptions(accessToken);
  // Cognito returns standard WebAuthn creation-options JSON, which startRegistration consumes.
  const credential = await startRegistration({
    // biome-ignore lint/suspicious/noExplicitAny: options is the server-generated WebAuthn document
    optionsJSON: options as any,
  });
  const { passkey } = await authApi.passkeyRegisterVerify(credential, accessToken);
  return passkey.credentialId;
}
