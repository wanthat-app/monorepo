import { z } from "zod";
import { CustomerProfile } from "./customer";

// GET /me — the authenticated member's own profile.
export const GetMeResponse = z.object({ profile: CustomerProfile });
export type GetMeResponse = z.infer<typeof GetMeResponse>;

// PATCH /me — update name, language, and/or email (UC6). At least one field must be present.
// Phone is NOT editable here — it is the identity anchor (ADR-0006); changing it is a separate
// re-verification flow. `email` is format-validated; `null` clears it. Ownership is not verified
// in MVP (email is notifications-only; phone remains the auth anchor) — see note below.
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
export type UpdateProfileBody = z.infer<typeof UpdateProfileBody>;

export const UpdateProfileResponse = z.object({ profile: CustomerProfile });
export type UpdateProfileResponse = z.infer<typeof UpdateProfileResponse>;
