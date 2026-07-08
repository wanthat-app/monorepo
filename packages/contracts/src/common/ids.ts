import { z } from "zod";

/** Opaque UUID (customer_id, product id, …). Not PII (ADR-0008). */
export const Uuid = z.string().uuid();
export type Uuid = z.infer<typeof Uuid>;

/**
 * Public id of a recommendation — its sole id, used directly on `/p/{recommendationId}` and as
 * the `ref` attribution value (ADR-0007, ADR-0008). A short URL-safe token (11 base62 chars,
 * derived deterministically from owner+product — see the links module) so the share URL stays
 * compact; the schema also tolerates the 36-char uuid form of pre-2026-07-09 dev links.
 */
export const RecommendationId = z.string().regex(/^[A-Za-z0-9-]{8,36}$/, "recommendation id");
export type RecommendationId = z.infer<typeof RecommendationId>;

/** Phone number in E.164 form (identity, ADR-0006). */
export const PhoneE164 = z.string().regex(/^\+[1-9]\d{1,14}$/, "E.164 phone");
export type PhoneE164 = z.infer<typeof PhoneE164>;

/**
 * Opaque, random guest identifier the SPA mints and keeps in `localStorage` (ADR-0008).
 * Non-PII; carried as the `g` consumer key at click and mapped to a member on registration.
 */
export const GuestId = z.string().min(1).max(128);
export type GuestId = z.infer<typeof GuestId>;
