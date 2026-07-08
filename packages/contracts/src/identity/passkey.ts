import { z } from "zod";
import { IsoDateTime } from "../common";

/**
 * App-owned WebAuthn ceremony shapes. ADR-0006 makes passkeys Cognito-native
 * (StartWebAuthnRegistration / InitiateAuth WEB_AUTHN) — the app never sees these
 * payloads again.
 */

/** @deprecated removed by ADR-0006, deleted in T8 */
export const PasskeyAuthenticator = z.enum(["platform", "cross-platform"]);
/** @deprecated removed by ADR-0006, deleted in T8 */
export type PasskeyAuthenticator = z.infer<typeof PasskeyAuthenticator>;

/**
 * A registered passkey credential (summary).
 * @deprecated removed by ADR-0006, deleted in T8
 */
export const Passkey = z.object({
  credentialId: z.string(),
  createdAt: IsoDateTime,
});
/** @deprecated removed by ADR-0006, deleted in T8 */
export type Passkey = z.infer<typeof Passkey>;

/**
 * WebAuthn payloads follow the standard SimpleWebAuthn JSON shapes. `options` is
 * server-generated (outbound) so it is typed loosely; the inbound `credential` is
 * validated structurally. For FaceID/TouchID the server biases the options to a
 * platform authenticator with `userVerification: "required"`.
 * @deprecated removed by ADR-0006, deleted in T8
 */
export const PublicKeyCredentialCreationOptionsJSON = z
  .object({ challenge: z.string() })
  .passthrough();
/** @deprecated removed by ADR-0006, deleted in T8 */
export type PublicKeyCredentialCreationOptionsJSON = z.infer<
  typeof PublicKeyCredentialCreationOptionsJSON
>;

/** @deprecated removed by ADR-0006, deleted in T8 */
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
/** @deprecated removed by ADR-0006, deleted in T8 */
export type RegistrationResponseJSON = z.infer<typeof RegistrationResponseJSON>;

/**
 * Assertion options for login — server-generated (outbound), userless/discoverable.
 * @deprecated removed by ADR-0006, deleted in T8
 */
export const PublicKeyCredentialRequestOptionsJSON = z
  .object({ challenge: z.string() })
  .passthrough();
/** @deprecated removed by ADR-0006, deleted in T8 */
export type PublicKeyCredentialRequestOptionsJSON = z.infer<
  typeof PublicKeyCredentialRequestOptionsJSON
>;

/**
 * WebAuthn assertion (inbound). `userHandle` lets a discoverable login resolve the user.
 * @deprecated removed by ADR-0006, deleted in T8
 */
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
/** @deprecated removed by ADR-0006, deleted in T8 */
export type AuthenticationResponseJSON = z.infer<typeof AuthenticationResponseJSON>;
