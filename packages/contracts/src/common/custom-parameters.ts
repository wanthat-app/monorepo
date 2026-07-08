import { z } from "zod";
import { GuestId, RecommendationId, Uuid } from "./ids";

/**
 * Attribution values echoed back via the retailer's `custom_parameters` (ADR-0008).
 * `ref` (the `recommendationId`) is always present and resolves to referrer + product at
 * conversion; the consumer is `c` (the member's canonical id — the Cognito `sub`, ADR-0025)
 * when authenticated at resolve time, else `g` (opaque guestId) — never both. Opaque ids only,
 * so nothing internal leaks.
 */
export const CustomParameters = z
  .object({
    ref: RecommendationId,
    c: Uuid.optional(),
    g: GuestId.optional(),
  })
  .refine((v) => !(v.c && v.g), "c and g are mutually exclusive");
export type CustomParameters = z.infer<typeof CustomParameters>;
