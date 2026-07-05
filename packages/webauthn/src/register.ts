import type { RegistrationResponseJSON } from "@simplewebauthn/server";
import { generateRegistrationOptions, verifyRegistrationResponse } from "@simplewebauthn/server";

/** A verified, storable passkey credential (public key base64url-encoded for DynamoDB). */
export interface StoredCredential {
  credentialId: string;
  publicKey: string; // base64url of the COSE public key bytes
  counter: number;
  transports?: string[];
}

/**
 * Build registration options for a DISCOVERABLE platform passkey (ADR-0024): resident key required,
 * user verification required, platform authenticator, attestation none. userHandle = the customer's
 * Cognito sub, so a later userless login assertion resolves the user. The returned object's
 * `challenge` MUST be persisted server-side (single-use) to check at verify.
 */
export async function buildRegistrationOptions(args: {
  rpID: string;
  rpName: string;
  sub: string;
  userName: string;
  displayName: string;
  excludeCredentialIds?: string[];
}) {
  return generateRegistrationOptions({
    rpName: args.rpName,
    rpID: args.rpID,
    userName: args.userName,
    userID: new TextEncoder().encode(args.sub),
    userDisplayName: args.displayName,
    attestationType: "none",
    authenticatorSelection: {
      residentKey: "required",
      requireResidentKey: true,
      userVerification: "required",
      authenticatorAttachment: "platform",
    },
    excludeCredentials: (args.excludeCredentialIds ?? []).map((id) => ({ id })),
  });
}

/**
 * Verify an attestation and return the storable credential, or throw. Enforces UV. `expectedChallenge`
 * is the base64url challenge we issued; `expectedOrigin`/`expectedRPID` pin to our site.
 */
export async function verifyRegistration(args: {
  response: RegistrationResponseJSON;
  expectedChallenge: string;
  expectedOrigin: string | string[];
  expectedRPID: string;
}): Promise<StoredCredential> {
  const v = await verifyRegistrationResponse({
    response: args.response,
    expectedChallenge: args.expectedChallenge,
    expectedOrigin: args.expectedOrigin,
    expectedRPID: args.expectedRPID,
    requireUserVerification: true,
  });
  if (!v.verified || !v.registrationInfo) {
    throw new Error("webauthn: registration not verified");
  }
  const c = v.registrationInfo.credential; // v13: { id, publicKey: Uint8Array, counter, transports? }
  return {
    credentialId: c.id,
    publicKey: Buffer.from(c.publicKey).toString("base64url"),
    counter: c.counter,
    transports: c.transports,
  };
}
