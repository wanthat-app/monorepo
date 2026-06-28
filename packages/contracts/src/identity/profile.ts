import { z } from "zod";
import { CustomerProfile } from "./customer";

// GET /me — the authenticated member's own profile.
export const GetMeResponse = z.object({ profile: CustomerProfile });
export type GetMeResponse = z.infer<typeof GetMeResponse>;

// PATCH /me — update name and/or language (UC6). At least one field must be present. Phone and
// email are not editable here: phone is the identity anchor (ADR-0006).
export const UpdateProfileBody = z
  .object({
    firstName: z.string().min(1).optional(),
    lastName: z.string().min(1).optional(),
    locale: z.string().optional(), // BCP-47, e.g. "he-IL"
  })
  .refine(
    (v) => v.firstName !== undefined || v.lastName !== undefined || v.locale !== undefined,
    "at least one field is required",
  );
export type UpdateProfileBody = z.infer<typeof UpdateProfileBody>;

export const UpdateProfileResponse = z.object({ profile: CustomerProfile });
export type UpdateProfileResponse = z.infer<typeof UpdateProfileResponse>;
