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
 * The landing-path funnel events. The funnel's third stage — the conversion — has its own
 * contract in `../conversion/event.ts` (ADR-0009; it needs wallet/money types this module must
 * not import: `conversion` already imports `ConsumerKind` from here, so a re-export would cycle).
 * All three ship through the same CloudWatch Logs → Firehose → S3 pipe, discriminated by `type`.
 */
export const FunnelEvent = z.discriminatedUnion("type", [ImpressionEvent, ClickEvent]);
export type FunnelEvent = z.infer<typeof FunnelEvent>;
