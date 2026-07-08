import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import {
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import type { StoredCredential } from "./register";

/**
 * Build USERLESS authentication options for conditional UI (ADR-0006): EMPTY allowCredentials so a
 * discoverable passkey resolves itself; UV required. Persist the returned `challenge` (single-use).
 */
export async function buildAuthenticationOptions(args: { rpID: string }) {
  return generateAuthenticationOptions({
    rpID: args.rpID,
    allowCredentials: [],
    userVerification: "required",
  });
}

/**
 * Verify an assertion against the STORED credential (looked up by credentialId), or throw. Returns the
 * new signature counter (caller persists it; a regression means a possible clone). Enforces UV +
 * origin/RPID pinning + single-use challenge (the caller checks the challenge is one it issued).
 */
export async function verifyAuthentication(args: {
  response: AuthenticationResponseJSON;
  expectedChallenge: string;
  expectedOrigin: string | string[];
  expectedRPID: string;
  credential: StoredCredential;
}): Promise<{ newCounter: number }> {
  const v = await verifyAuthenticationResponse({
    response: args.response,
    expectedChallenge: args.expectedChallenge,
    expectedOrigin: args.expectedOrigin,
    expectedRPID: args.expectedRPID,
    requireUserVerification: true,
    credential: {
      id: args.credential.credentialId,
      publicKey: new Uint8Array(Buffer.from(args.credential.publicKey, "base64url")),
      counter: args.credential.counter,
      transports: args.credential.transports as never,
    },
  });
  if (!v.verified) throw new Error("webauthn: authentication not verified");
  return { newCounter: v.authenticationInfo.newCounter };
}
