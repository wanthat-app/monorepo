import { z } from "zod";

/** Opaque UUID (customer_id, product id, …). Not PII (ADR-0008). */
export const Uuid = z.string().uuid();
export type Uuid = z.infer<typeof Uuid>;

/**
 * Public id of a recommendation — its sole id (a uuid), used directly on
 * `/p/{recommendationId}` and as the `ref` attribution value (ADR-0007, ADR-0008).
 */
export const RecommendationId = z.string().uuid();
export type RecommendationId = z.infer<typeof RecommendationId>;

/** Phone number in E.164 form (identity, ADR-0006). */
export const PhoneE164 = z.string().regex(/^\+[1-9]\d{1,14}$/, "E.164 phone");
export type PhoneE164 = z.infer<typeof PhoneE164>;
