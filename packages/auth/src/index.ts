/**
 * `@wanthat/auth` — the shared registration-ticket module (ADR-0020, ADR-0021).
 *
 * The HMAC ticket is the sole cross-function handoff between the non-VPC `app-auth` (which signs it
 * at `/auth/verify`) and the in-VPC `app-core` (which verifies it at `/auth/register`). Extracted here
 * so both functions share one implementation and both `grantRead` the same signing secret.
 */
export { type RegistrationTicket, TicketSigner } from "./tickets";
