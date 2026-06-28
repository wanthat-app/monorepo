import { z } from "zod";
import { Money } from "../common";

/** One side of the two-sided cashback for a product. */
export const CashbackShare = z.object({
  rateBps: z.number().int().nonnegative(), // basis points of the commissionable amount
  estimated: Money.nullable(), // estimate from the current product price, if known
});
export type CashbackShare = z.infer<typeof CashbackShare>;

/** What sharing this product earns: the referrer (sharer) and the consumer (buyer). */
export const CashbackDetails = z.object({
  referrer: CashbackShare,
  consumer: CashbackShare,
});
export type CashbackDetails = z.infer<typeof CashbackDetails>;
