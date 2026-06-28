import { z } from "zod";

// POST /me/attribution/claim — best-effort guest→member retro-attribution (ADR-0008).
// The SPA submits the guestIds it accrued in localStorage; mapping is non-blocking.
export const AttributionClaimBody = z.object({
  guestIds: z.array(z.string().min(1)).min(1).max(50),
});
export type AttributionClaimBody = z.infer<typeof AttributionClaimBody>;

export const AttributionClaimResponse = z.object({
  claimed: z.number().int().nonnegative(),
});
export type AttributionClaimResponse = z.infer<typeof AttributionClaimResponse>;
