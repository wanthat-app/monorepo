import { z } from "zod";
import { IsoDateTime, Money, RecommendationId, Uuid } from "../common";

/**
 * A member earns as a **recommender** (`referrer_cashback`, when someone buys through their
 * recommendation) and as a **buyer** (`consumer_reward`, their own cashback); `adjustment`
 * covers manual corrections. Mirrors the append-only `wallet_entry` ledger in Aurora (ADR-0002).
 */
export const WalletEntryKind = z.enum(["referrer_cashback", "consumer_reward", "adjustment"]);
export type WalletEntryKind = z.infer<typeof WalletEntryKind>;

/**
 * Lifecycle (ADR-0009): a reward lands `pending`, `confirmed` once the store finalises the order,
 * or `clawback` if it is cancelled/returned within the store's window.
 */
export const WalletEntryStatus = z.enum(["pending", "confirmed", "clawback"]);
export type WalletEntryStatus = z.infer<typeof WalletEntryStatus>;

/** One ledger entry as shown in the member's wallet history. */
export const WalletEntry = z.object({
  id: Uuid,
  kind: WalletEntryKind,
  amount: Money,
  status: WalletEntryStatus,
  // The recommendation this entry was attributed to (soft ref into DynamoDB; null for adjustments).
  recommendationId: RecommendationId.nullable(),
  createdAt: IsoDateTime,
});
export type WalletEntry = z.infer<typeof WalletEntry>;
