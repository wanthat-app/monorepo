import { z } from "zod";
import { IsoDateTime, RecommendationId } from "../common";
import { UntrackedReason } from "./event";

/**
 * The unattributed-order recovery surface (agreed 2026-07-10, Phase 2). The poller projects
 * every same-env untracked order into the `unattributed_order` DynamoDB table; the admin panel
 * lists them and may CLAIM one for a recommendation (→ the retailer-proxy heartbeat settles the
 * claim through the writer — ADR-0002: money still flows through one door) or DISMISS it as
 * reviewed house revenue. Amounts travel as decimal strings (storage form) — this wire has no
 * bigint leg.
 */

export const UnattributedOrderState = z.enum(["open", "claimed", "settled", "dismissed"]);
export type UnattributedOrderState = z.infer<typeof UnattributedOrderState>;

/** A commission amount in storage/wire form: integer minor units as a decimal string. */
const AmountWire = z.object({
  amountMinor: z.string().regex(/^\d+$/),
  currency: z.string().regex(/^[A-Z]{3}$/),
});

export const UnattributedOrderView = z.object({
  orderId: z.string().min(1),
  reason: UntrackedReason,
  /** The platform's raw order status string (latest sighting). */
  orderStatus: z.string(),
  /** Gross commission; null when the platform omitted it (such an order cannot be claimed). */
  amount: AmountWire.nullable(),
  /** The order's own timestamp; null when the platform's value was unparseable. */
  occurredAt: IsoDateTime.nullable(),
  firstSeenAt: IsoDateTime,
  lastSeenAt: IsoDateTime,
  state: UnattributedOrderState,
  claim: z
    .object({
      recommendationId: RecommendationId,
      claimedBy: z.string(),
      claimedAt: IsoDateTime,
    })
    .nullable(),
  settledAt: IsoDateTime.nullable(),
});
export type UnattributedOrderView = z.infer<typeof UnattributedOrderView>;

export const ListUnattributedOrdersQuery = z.object({
  state: UnattributedOrderState.default("open"),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ListUnattributedOrdersQuery = z.infer<typeof ListUnattributedOrdersQuery>;

export const ListUnattributedOrdersResponse = z.object({
  items: z.array(UnattributedOrderView),
  nextCursor: z.string().nullable(),
});
export type ListUnattributedOrdersResponse = z.infer<typeof ListUnattributedOrdersResponse>;

/** Claim = "this order's commission belongs to this recommendation" (its owner is credited). */
export const ClaimUnattributedOrderBody = z.object({
  recommendationId: RecommendationId,
});
export type ClaimUnattributedOrderBody = z.infer<typeof ClaimUnattributedOrderBody>;

export const UnattributedOrderActionResponse = z.object({
  item: UnattributedOrderView,
});
export type UnattributedOrderActionResponse = z.infer<typeof UnattributedOrderActionResponse>;
