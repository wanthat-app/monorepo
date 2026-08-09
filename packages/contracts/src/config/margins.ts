import { z } from "zod";
import { Bps, IsoDateTime } from "../common";

/**
 * The admin margins view (spec 2026-08-09) — a reparameterization of the two stored cashback rates
 * (`cashback.referrerBps` + `cashback.consumerBps`) as the operator sees them: an operational
 * margin taken off the top and a split of the remainder between recommender and buyer. Derived on
 * the fly server-side (`@wanthat/domain`); NOT a stored shape, so there is no config key, schema, or
 * migration for it. `referrerBps`/`consumerBps` ride along so the SPA can render the preview without
 * repeating the money math.
 */
export const MarginSplitView = z.object({
  /** Operational margin — the house's cut, taken off the top. */
  marginBps: Bps,
  /** The recommender's share of the post-margin remainder (10000 = all to recommender). */
  recommenderSplitBps: Bps,
  /** Derived stored rate — the recommender's absolute cut of the gross. */
  referrerBps: Bps,
  /** Derived stored rate — the buyer's absolute cut of the gross. */
  consumerBps: Bps,
  /** The later of the two underlying keys' last-write times (EPOCH0 when both are unset). */
  updatedAt: IsoDateTime,
});
export type MarginSplitView = z.infer<typeof MarginSplitView>;

/** PUT body: the operator sets the margin + split; the server derives + persists the two rates. */
export const PutMarginSplitBody = z.object({
  marginBps: Bps,
  recommenderSplitBps: Bps,
});
export type PutMarginSplitBody = z.infer<typeof PutMarginSplitBody>;

export const MarginSplitResponse = z.object({ item: MarginSplitView });
export type MarginSplitResponse = z.infer<typeof MarginSplitResponse>;
