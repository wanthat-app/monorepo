import { z } from "zod";
import { CustomerProfile } from "./customer";

// GET /me — the authenticated member's own profile.
// ADR-0006: the profile is the ID-token claims, decoded locally — no backend read.
/** @deprecated removed by ADR-0006, deleted in T8 */
export const GetMeResponse = z.object({ profile: CustomerProfile });
/** @deprecated removed by ADR-0006, deleted in T8 */
export type GetMeResponse = z.infer<typeof GetMeResponse>;

// PATCH /me — update name, language, and/or email (UC6). At least one field must be present.
// Phone is NOT editable here — it is the identity anchor; changing it is a separate
// re-verification flow. `email` is format-validated; `null` clears it.
// ADR-0006: profile edits go through Cognito UpdateUserAttributes (+ VerifyUserAttribute).
/** @deprecated removed by ADR-0006, deleted in T8 */
export const UpdateProfileBody = z
  .object({
    firstName: z.string().min(1).optional(),
    lastName: z.string().min(1).optional(),
    locale: z.string().optional(), // BCP-47, e.g. "he-IL"
    email: z.string().email().nullable().optional(),
  })
  .refine(
    (v) =>
      v.firstName !== undefined ||
      v.lastName !== undefined ||
      v.locale !== undefined ||
      v.email !== undefined,
    "at least one field is required",
  );
/** @deprecated removed by ADR-0006, deleted in T8 */
export type UpdateProfileBody = z.infer<typeof UpdateProfileBody>;

/** @deprecated removed by ADR-0006, deleted in T8 */
export const UpdateProfileResponse = z.object({ profile: CustomerProfile });
/** @deprecated removed by ADR-0006, deleted in T8 */
export type UpdateProfileResponse = z.infer<typeof UpdateProfileResponse>;
