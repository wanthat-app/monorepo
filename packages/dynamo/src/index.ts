/**
 * `@wanthat/dynamo` — the DynamoDB data-access layer (ADR-0003). A shared document client plus one
 * repository per table; every read/write is validated through the `@wanthat/contracts` Zod schemas,
 * so DynamoDB stays the operational, non-PII store behind a typed boundary.
 *
 * Repositories are added per feature slice. Present: runtime `config`, the `fx_rate` cache, and the
 * auth working tables (`auth_challenge`, `phone_velocity`, `guest_attribution`).
 */
export {
  AuthChallengeRepo,
  type ChallengeRecord,
  type TicketRecord,
} from "./auth-challenge";
export { getDocClient } from "./client";
export { type DevOtpSinkItem, DevOtpSinkRepo } from "./dev-otp-sink";
export { FxRateRepo, fxPairKey } from "./fx-rate";
export { type GuestAttribution, GuestAttributionRepo } from "./guest-attribution";
export {
  type NotificationOutboxItem,
  NotificationOutboxRepo,
  type NotificationStatus,
} from "./notification-outbox";
export { type PasskeyCredentialItem, PasskeyCredentialRepo } from "./passkey-credential";
export { PhoneVelocityRepo } from "./phone-velocity";
export { type RuntimeConfigReader, RuntimeConfigRepo } from "./runtime-config";
