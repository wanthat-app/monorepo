/**
 * `@wanthat/auth` — the registration-ticket handoff (ADR-0006, ADR-0006), Ed25519-signed.
 *
 * {@link TicketSigner} (non-VPC `app-auth`, private key from Secrets Manager over the free public
 * endpoint) signs at `/auth/verify`; {@link TicketVerifier} (in-VPC `app-core`, PUBLIC key from a
 * plain env var — no Secrets Manager, no interface endpoint) verifies at `/auth/session` +
 * `/auth/register`. Wire form: `<base64url payload>.<base64url Ed25519 signature>`.
 */
export {
  type RegistrationTicket,
  type TicketKeyMaterial,
  TicketSigner,
  TicketVerifier,
} from "./tickets";
