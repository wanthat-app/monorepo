/**
 * `@wanthat/dynamo` — the DynamoDB data-access layer (ADR-0003). A shared document client plus one
 * repository per table; every read/write is validated through the `@wanthat/contracts` Zod schemas,
 * so DynamoDB stays the operational, non-PII store behind a typed boundary.
 *
 * Repositories are added per feature slice. Present: runtime `config`, the customer counter
 * (the `customerCounter` item in the dedicated `OpsCounters` table), the `fx_rate` cache,
 * `guest_attribution`, products/recommendations, and the dev OTP sink.
 */
export { getDocClient } from "./client";
export {
  CUSTOMER_COUNTER_KEY,
  CustomerCounterRepo,
  type CustomerCounts,
} from "./customer-counter";
export { FxRateRepo, fxPairKey } from "./fx-rate";
export { type GuestAttribution, GuestAttributionRepo } from "./guest-attribution";
export {
  type DailyMetric,
  jerusalemDate,
  lastNDates,
  OpsMetricsRepo,
  PRESENCE_PREFIX,
} from "./ops-metrics";
export { type OtpSinkItem, OtpSinkRepo } from "./otp-sink";
export { type PollerStateItem, PollerStateRepo } from "./poller-state";
export { PRODUCT_COUNTER_SK, ProductItem, ProductRepo, type ProductUpsert } from "./product";
export {
  RECOMMENDATION_COUNTER_PK,
  RecommendationItem,
  type RecommendationPage,
  RecommendationRepo,
} from "./recommendation";
export {
  CONFIG_GET_MANY_MAX,
  type RuntimeConfigBatchReader,
  type RuntimeConfigReader,
  RuntimeConfigRepo,
} from "./runtime-config";
export * from "./unattributed-order";
