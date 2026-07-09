/**
 * `@wanthat/dynamo` — the DynamoDB data-access layer (ADR-0003). A shared document client plus one
 * repository per table; every read/write is validated through the `@wanthat/contracts` Zod schemas,
 * so DynamoDB stays the operational, non-PII store behind a typed boundary.
 *
 * Repositories are added per feature slice. Present: runtime `config`, the `fx_rate` cache,
 * `guest_attribution`, products/recommendations, the notification outbox, and the dev OTP sink.
 */
export { getDocClient } from "./client";
export { type DevOtpSinkItem, DevOtpSinkRepo } from "./dev-otp-sink";
export { FxRateRepo, fxPairKey } from "./fx-rate";
export { type GuestAttribution, GuestAttributionRepo } from "./guest-attribution";
export {
  type NotificationOutboxItem,
  NotificationOutboxRepo,
  type NotificationStatus,
} from "./notification-outbox";
export { PRODUCT_COUNTER_SK, ProductItem, ProductRepo, type ProductUpsert } from "./product";
export {
  RECOMMENDATION_COUNTER_PK,
  RecommendationItem,
  type RecommendationPage,
  RecommendationRepo,
} from "./recommendation";
export { type RuntimeConfigReader, RuntimeConfigRepo } from "./runtime-config";
