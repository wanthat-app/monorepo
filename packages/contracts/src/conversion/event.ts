import { z } from "zod";
import { IsoDateTime, Money, RecommendationId } from "../common";
import { ConsumerKind } from "../landing";
import { WalletEntryStatus } from "../wallet";

/**
 * Conversion event (ADR-0009) — emitted by the in-VPC writer as a structured `console.log` line
 * that a CloudWatch Logs subscription ships to Firehose → S3, the same off-band path as the
 * landing impression/click events (ADR-0007). It completes the funnel (impression → click →
 * **conversion**) in S3/Athena; it is **analytics-only** and never the source of truth for money —
 * the authoritative ledger stays in Aurora. `amount` is the gross commission; `status` tracks the
 * pending → confirmed → clawback lifecycle.
 */
export const ConversionEvent = z.object({
  type: z.literal("conversion"),
  orderId: z.string().min(1),
  recommendationId: RecommendationId,
  consumer: ConsumerKind,
  amount: Money,
  status: WalletEntryStatus,
  at: IsoDateTime,
});
export type ConversionEvent = z.infer<typeof ConversionEvent>;

/**
 * Why an order fell out of attribution (the poller's untracked outcomes, minus foreign_env —
 * another env's orders are that env's conversions, not this env's analytics).
 */
export const UntrackedReason = z.enum(["no_ref", "unknown_ref", "no_commission", "unknown_status"]);
export type UntrackedReason = z.infer<typeof UntrackedReason>;

/**
 * Untracked-order event — emitted by the retailer-proxy poll for every fetched order that fell
 * out of attribution (same off-band Logs → Firehose → S3 path as ConversionEvent). This is the
 * UNATTRIBUTED revenue stream: commission the account earned with no member to credit — house
 * margin by default, and the `no_ref` rate doubles as the attribution-health metric (params
 * lost in transit). `amount` is the gross commission (null when the platform omitted it).
 * Overlap re-reads re-emit: analytics dedupe on `(orderId, status)`.
 */
export const UntrackedOrderEvent = z.object({
  type: z.literal("order_untracked"),
  orderId: z.string().min(1),
  reason: UntrackedReason,
  /** The platform's raw order status string — NOT our ledger enum. */
  orderStatus: z.string(),
  amount: Money.nullable(),
  at: IsoDateTime,
});
export type UntrackedOrderEvent = z.infer<typeof UntrackedOrderEvent>;
