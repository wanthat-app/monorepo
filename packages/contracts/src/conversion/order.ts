import { z } from "zod";
import { IsoDateTime, Money, RecommendationId, Uuid } from "../common";
import { WalletEntryStatus } from "../wallet";

/**
 * One credited party on a conversion (ADR-0008/0009): the resolved member and the reward owed.
 * The referrer is always resolvable (`ref` → recommendation → owner); a consumer party exists
 * only when the buyer is an attributable member (guest-no-reward and untracked yield none).
 */
export const ConversionParty = z.object({
  customerId: Uuid,
  reward: Money,
});
export type ConversionParty = z.infer<typeof ConversionParty>;

/**
 * A conversion after the Retailer Proxy has resolved attribution from the echoed
 * `custom_parameters` (ADR-0008) — the input it hands to the in-VPC writer (ADR-0002/0009).
 * Design-controlled seam (the raw `order.listbyindex` row stays in the adapter, integration-
 * pending). The writer appends one append-only `wallet_entry` per party — `referrer_cashback`
 * for `referrer`, `consumer_reward` for `consumer` when present — both at `status`, idempotent on
 * `(orderId, kind)`.
 */
export const ResolvedConversion = z.object({
  orderId: z.string().min(1),
  recommendationId: RecommendationId,
  referrer: ConversionParty,
  consumer: ConversionParty.nullable(),
  status: WalletEntryStatus,
  occurredAt: IsoDateTime,
});
export type ResolvedConversion = z.infer<typeof ResolvedConversion>;
