import { z } from "zod";
import { GuestId, RecommendationId } from "../common";

/**
 * Client-driven resolve (ADR-0007/0008). The bootstrap JS calls this on our origin after the
 * landing renders, to obtain the outgoing affiliate URL with `custom_parameters` appended.
 * `ref` (the recommendationId) is always appended; the consumer key depends on identity:
 *   - member  → sends its Cognito Bearer token (Authorization header, validated offline against
 *     cached JWKS — no Cognito call); the endpoint injects `c = customer_id`. No body identity.
 *   - guest   → sends the `guestId` from localStorage; the endpoint injects `g = guestId`.
 *   - neither → no token and no guestId → `authRequired`; the client renders
 *     login / signup / continue-as-guest, then re-resolves.
 * Always emits the **click** funnel event (ADR-0007).
 */
export const ResolveParams = z.object({ recommendationId: RecommendationId });
export type ResolveParams = z.infer<typeof ResolveParams>;

export const ResolveBody = z.object({ guestId: GuestId.optional() });
export type ResolveBody = z.infer<typeof ResolveBody>;

/** Identity resolved (member via token, or guest via guestId) → go to the store. */
export const ResolveRedirect = z.object({
  outcome: z.literal("redirect"),
  url: z.string().url(),
});
export type ResolveRedirect = z.infer<typeof ResolveRedirect>;

/** No identity → the client offers login / signup / continue-as-guest, then re-resolves. */
export const ResolveAuthRequired = z.object({
  outcome: z.literal("authRequired"),
});
export type ResolveAuthRequired = z.infer<typeof ResolveAuthRequired>;

export const ResolveResponse = z.discriminatedUnion("outcome", [
  ResolveRedirect,
  ResolveAuthRequired,
]);
export type ResolveResponse = z.infer<typeof ResolveResponse>;
