import { z } from "zod";
import { GuestId } from "../common";

// POST /me/attribution/claim — best-effort guest→member retro-attribution (ADR-0008).
// The SPA submits the guestIds it accrued in localStorage; mapping is non-blocking.
// ADR-0006: app-core becomes wallet-only; guest attribution moves to SignUp.ClientMetadata +
// the Post-Confirmation trigger (T6).
/** @deprecated removed by ADR-0006, deleted in T8 */
export const AttributionClaimBody = z.object({
  guestIds: z.array(GuestId).min(1).max(50),
});
/** @deprecated removed by ADR-0006, deleted in T8 */
export type AttributionClaimBody = z.infer<typeof AttributionClaimBody>;

/** @deprecated removed by ADR-0006, deleted in T8 */
export const AttributionClaimResponse = z.object({
  claimed: z.number().int().nonnegative(),
});
/** @deprecated removed by ADR-0006, deleted in T8 */
export type AttributionClaimResponse = z.infer<typeof AttributionClaimResponse>;
