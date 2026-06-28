import { z } from "zod";
import { Money } from "../common";

/** Confirmed vs still-pending earnings for one role. */
export const WalletEarnings = z.object({
  confirmed: Money,
  pending: Money,
});
export type WalletEarnings = z.infer<typeof WalletEarnings>;

/**
 * A member's wallet balance in a single currency (ADR-0003 ledger is currency-agnostic, so the
 * wallet returns one of these per currency held). Earnings are split by role — as a
 * **recommender** (others' purchases) and as a **buyer** (own cashback). `available` is the
 * confirmed total net of withdrawals, i.e. what can be withdrawn now. All figures share the
 * currency carried on each `Money`.
 */
export const WalletBalance = z.object({
  asRecommender: WalletEarnings,
  asBuyer: WalletEarnings,
  available: Money,
});
export type WalletBalance = z.infer<typeof WalletBalance>;
