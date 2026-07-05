/**
 * `@wanthat/auth` — shared HMAC handoff tokens (ADR-0020, ADR-0021).
 *
 * {@link TicketSigner} signs/verifies the registration ticket: non-VPC `app-auth` (signs at
 * `/auth/verify`) <-> in-VPC `app-core` (verifies at `/auth/register`). Same `<payload>.<hmac>`
 * base64url wire form and Secrets Manager-keyed HMAC crypto as the rest of the handoff tokens.
 */
export { type RegistrationTicket, TicketSigner } from "./tickets";
