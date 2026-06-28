import { z } from "zod";

/**
 * A sharer's optional review/recommendation note attached to a recommendation and shown
 * on the landing page (ADR-0007). If provided, `text` is required; `rating` is optional.
 */
export const Review = z.object({
  rating: z.number().int().min(1).max(5).optional(),
  text: z.string().min(1).max(2000),
});
export type Review = z.infer<typeof Review>;
