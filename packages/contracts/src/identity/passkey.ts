import { z } from "zod";
import { IsoDateTime } from "../common";

export const PasskeyAuthenticator = z.enum(["platform", "cross-platform"]);
export type PasskeyAuthenticator = z.infer<typeof PasskeyAuthenticator>;

/** A registered passkey credential (summary). */
export const Passkey = z.object({
  credentialId: z.string(),
  createdAt: IsoDateTime,
});
export type Passkey = z.infer<typeof Passkey>;

/**
 * WebAuthn payloads follow the standard SimpleWebAuthn JSON shapes. `options` is
 * server-generated (outbound) so it is typed loosely; the inbound `credential` is
 * validated structurally. For FaceID/TouchID the server biases the options to a
 * platform authenticator with `userVerification: "required"` (ADR-0006).
 */
export const PublicKeyCredentialCreationOptionsJSON = z
  .object({ challenge: z.string() })
  .passthrough();
export type PublicKeyCredentialCreationOptionsJSON = z.infer<
  typeof PublicKeyCredentialCreationOptionsJSON
>;

export const RegistrationResponseJSON = z
  .object({
    id: z.string(),
    rawId: z.string(),
    type: z.literal("public-key"),
    authenticatorAttachment: z.string().optional(),
    response: z
      .object({
        clientDataJSON: z.string(),
        attestationObject: z.string(),
        transports: z.array(z.string()).optional(),
      })
      .passthrough(),
  })
  .passthrough();
export type RegistrationResponseJSON = z.infer<typeof RegistrationResponseJSON>;

/** Assertion options for login — server-generated (outbound), userless/discoverable. */
export const PublicKeyCredentialRequestOptionsJSON = z
  .object({ challenge: z.string() })
  .passthrough();
export type PublicKeyCredentialRequestOptionsJSON = z.infer<
  typeof PublicKeyCredentialRequestOptionsJSON
>;

/** WebAuthn assertion (inbound). `userHandle` lets a discoverable login resolve the user. */
export const AuthenticationResponseJSON = z
  .object({
    id: z.string(),
    rawId: z.string(),
    type: z.literal("public-key"),
    authenticatorAttachment: z.string().optional(),
    response: z
      .object({
        clientDataJSON: z.string(),
        authenticatorData: z.string(),
        signature: z.string(),
        userHandle: z.string().optional(),
      })
      .passthrough(),
  })
  .passthrough();
export type AuthenticationResponseJSON = z.infer<typeof AuthenticationResponseJSON>;
