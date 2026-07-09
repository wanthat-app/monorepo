import { z } from "zod";
import { IsoDateTime, RecommendationId } from "../common";

/**
 * Funnel events on the landing path (ADR-0007), emitted as structured `console.log` lines that a
 * CloudWatch Logs subscription ships to Firehose → S3 (analytics; never the hot transactional
 * path, and never an awaited PutRecord — Lambda freezes after the response and would drop it).
 */

/** Who the click was attributed to at resolve time. */
export const ConsumerKind = z.enum(["member", "guest", "none"]);
export type ConsumerKind = z.infer<typeof ConsumerKind>;

/** Emitted by `GET /p/{recommendationId}` when the landing renders. */
export const ImpressionEvent = z.object({
  type: z.literal("impression"),
  recommendationId: RecommendationId,
  at: IsoDateTime,
});
export type ImpressionEvent = z.infer<typeof ImpressionEvent>;

/** Emitted by resolve once the outgoing URL is assembled (or auth is required). */
export const ClickEvent = z.object({
  type: z.literal("click"),
  recommendationId: RecommendationId,
  consumer: ConsumerKind,
  at: IsoDateTime,
});
export type ClickEvent = z.infer<typeof ClickEvent>;

/**
 * Money as it appears in LOG events: the JSON-wire form (decimal-string minor units), because
 * funnel events are `JSON.stringify`-ed console.log lines and bigint would throw.
 */
export const EventMoney = z.object({
  amountMinor: z.string().regex(/^-?\d+$/),
  currency: z.string().regex(/^[A-Z]{3}$/),
});
export type EventMoney = z.infer<typeof EventMoney>;

/**
 * Emitted by the conversion poller (ADR-0009) when an order lands. Defined NOW so the Athena
 * schema (funnel-analytics pipeline) is stable before the poller slice starts emitting it.
 * `consumer` is the attribution outcome resolved from `c`/`g`/`ref` (ADR-0008); `none` = untracked.
 */
export const ConversionEvent = z.object({
  type: z.literal("conversion"),
  recommendationId: RecommendationId,
  consumer: ConsumerKind,
  orderId: z.string().min(1),
  commission: EventMoney.nullable(),
  at: IsoDateTime,
});
export type ConversionEvent = z.infer<typeof ConversionEvent>;

export const FunnelEvent = z.discriminatedUnion("type", [
  ImpressionEvent,
  ClickEvent,
  ConversionEvent,
]);
export type FunnelEvent = z.infer<typeof FunnelEvent>;
