/**
 * `@wanthat/auth` — shared HMAC handoff tokens (ADR-0020, ADR-0021, ADR-0024).
 *
 * Two independent signer/verifier pairs, same `<payload>.<hmac>` base64url wire form and Secrets
 * Manager-keyed HMAC crypto, each shared by exactly one pair of functions:
 *
 *  - {@link TicketSigner} — the registration ticket: non-VPC `app-auth` (signs at `/auth/verify`)
 *    <-> in-VPC `app-core` (verifies at `/auth/register`).
 *  - {@link PasskeyProofSigner} — the passkey-login proof: `app-auth` (signs after verifying a
 *    WebAuthn assertion itself) <-> the Cognito CUSTOM_AUTH triggers (verify to mint tokens).
 */
export { type PasskeyProofPayload, PasskeyProofSigner } from "./passkey-proof";
export { type RegistrationTicket, TicketSigner } from "./tickets";
