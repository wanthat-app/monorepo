import { z } from "zod";
import { IsoDateTime, Money, RecommendationId } from "../common";
import { ConsumerKind } from "../redirect";
import { WalletEntryStatus } from "../wallet";

/**
 * Conversion event (ADR-0009) — emitted by the in-VPC writer as a structured `console.log` line
 * that a CloudWatch Logs subscription ships to Firehose → S3, the same off-band path as the
 * redirect impression/click events (ADR-0007). It completes the funnel (impression → click →
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
