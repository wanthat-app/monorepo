import { z } from "zod";
import { IsoDateTime, PhoneE164, Uuid } from "../common";

export const CustomerStatus = z.enum(["active", "suspended"]);
export type CustomerStatus = z.infer<typeof CustomerStatus>;

/** The authenticated member's own profile (returned by `/me` and the auth flows). */
export const CustomerProfile = z.object({
  id: Uuid,
  phone: PhoneE164,
  email: z.string().email().nullable(),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  locale: z.string(), // BCP-47, e.g. "he-IL"
  status: CustomerStatus,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type CustomerProfile = z.infer<typeof CustomerProfile>;
