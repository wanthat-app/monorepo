import { z } from "zod";
import { Money } from "../common";

/** Confirmed vs still-pending **reward** earnings for one role. */
export const WalletEarnings = z.object({
  confirmed: Money,
  pending: Money,
});
export type WalletEarnings = z.infer<typeof WalletEarnings>;

/**
 * A member's wallet balance in a single currency (ADR-0003 ledger is currency-agnostic, so the
 * wallet returns one of these per currency held). `asRecommender` / `asBuyer` are an informational
 * **earnings breakdown** — rewards only (`referrer_cashback` / `consumer_reward`), split confirmed
 * vs pending. `available` is the true withdrawable figure, derived over the WHOLE ledger:
 * Σ confirmed rewards + adjustments − withdrawals — so non-reward movements (`adjustment`,
 * `withdrawal`) are reflected there even though they belong to neither role bucket. All figures
 * share the currency carried on each `Money`.
 */
export const WalletBalance = z.object({
  asRecommender: WalletEarnings,
  asBuyer: WalletEarnings,
  available: Money,
});
export type WalletBalance = z.infer<typeof WalletBalance>;
