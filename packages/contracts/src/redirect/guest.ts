import { z } from "zod";
import { GuestId, IsoDateTime, Uuid } from "../common";

/**
 * guest→member attribution record (ADR-0008). Written best-effort at registration when a
 * visitor who had clicked as a guest signs up, and read at conversion to upgrade a guest reward
 * to a member one. Lives in DynamoDB (non-PII, best-effort, outside the Aurora registration txn),
 * keyed by `guestId`; many guestIds map to one customer (a person accrues several across devices).
 */
export const GuestAttribution = z.object({
  guestId: GuestId,
  customerId: Uuid,
  linkedAt: IsoDateTime,
});
export type GuestAttribution = z.infer<typeof GuestAttribution>;
