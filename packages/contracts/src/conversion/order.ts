import { z } from "zod";
import { IsoDateTime, Money, RecommendationId, Uuid } from "../common";
import { WalletEntryKind, WalletEntryStatus } from "../wallet";
import { ConsumerKind } from "../landing";

/**
 * One credited party on a conversion (ADR-0008/0009): the resolved member and the reward owed.
 * The referrer is always resolvable (`ref` → recommendation → owner); a consumer party exists
 * only when the buyer is an attributable member (guest-no-reward and untracked yield none).
 * Members carry the canonical id — the Cognito `sub` (ADR-0020): the ledger is keyed by
 * `cognito_sub` directly (ADR-0006 decision 4) — `ConversionParty.sub` maps straight onto
 * `wallet_entry.cognito_sub`; there is no customer table.
 */
export const ConversionParty = z.object({
  sub: Uuid,
  reward: Money,
});
export type ConversionParty = z.infer<typeof ConversionParty>;

/**
 * A conversion after the Retailer Proxy has resolved attribution from the echoed
 * `custom_parameters` (ADR-0008) — the input it hands to the in-VPC writer (ADR-0002/0009).
 * Design-controlled seam (the raw `order.listbyindex` row stays in the adapter, integration-
 * pending). The writer appends one append-only `wallet_entry` per party — `referrer_cashback`
 * for `referrer`, `consumer_reward` for `consumer` when present — both at `status`, idempotent on
 * the ledger's unique `(order_id, kind, status)` index.
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

/**
 * The proxy → in-VPC writer invoke payload (ADR-0009). `gross` is the retailer-reported
 * commission (for the analytics ConversionEvent); `consumer` is the attribution KIND for that
 * event — `guest` may still carry a null consumer party (unmapped guestId: nothing to credit
 * yet, the click was still a guest's).
 */
export const ConversionWrite = z.object({
  resolved: ResolvedConversion,
  gross: Money,
  consumer: ConsumerKind,
});
export type ConversionWrite = z.infer<typeof ConversionWrite>;

export const WriteConversionsRequest = z.object({
  conversions: z.array(ConversionWrite).min(1),
});
export type WriteConversionsRequest = z.infer<typeof WriteConversionsRequest>;

/** Per-conversion isolation: one bad order lands in `failed`, never poisons the batch. */
export const WriteConversionsResponse = z.object({
  appended: z.array(
    z.object({ orderId: z.string(), kind: WalletEntryKind, status: WalletEntryStatus }),
  ),
  failed: z.array(z.object({ orderId: z.string(), error: z.string() })),
});
export type WriteConversionsResponse = z.infer<typeof WriteConversionsResponse>;
