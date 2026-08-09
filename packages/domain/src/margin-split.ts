/**
 * Operational-margin / buyer↔recommender-split reparameterization (spec 2026-08-09).
 *
 * The canonical stored policy is still the two independent cashback rates
 * (`cashback.referrerBps` + `cashback.consumerBps`), each an absolute fraction of the gross
 * commission — nothing downstream (`splitCommission`, the per-recommendation snapshot, the ledger,
 * money stats) changes. The admin panel just *presents* that policy the operator's way:
 *
 *   operational margin = the house's cut, taken off the top
 *   remainder (100% − margin) = split between recommender and buyer
 *
 * These two pure helpers convert between the two views. They are the single source of truth for the
 * math; the admin-console endpoint derives with them so the browser never does money arithmetic.
 * All values are basis points (integer 0–10000).
 */

/** The stored policy: the two absolute cashback rates carved from the gross commission. */
export interface RewardSplitBps {
  referrerBps: number;
  consumerBps: number;
}

/** The operator's view: a margin off the top, then the recommender's share of what's left. */
export interface MarginSplit {
  marginBps: number;
  /** The recommender's share of the post-margin remainder (0 = all to buyer, 10000 = all to recommender). */
  recommenderSplitBps: number;
}

/**
 * Sliders → stored bps. Consumer is the remainder minus referrer (subtracted, never rounded
 * independently) so the two always sum to exactly the remainder — the margin stays exact.
 */
export function deriveBpsFromMarginSplit(
  marginBps: number,
  recommenderSplitBps: number,
): RewardSplitBps {
  const remainder = 10_000 - marginBps;
  const referrerBps = Math.round((remainder * recommenderSplitBps) / 10_000);
  const consumerBps = remainder - referrerBps;
  return { referrerBps, consumerBps };
}

/**
 * Stored bps → sliders. Margin is the residual (floored at 0 — a legacy split can exceed 100%,
 * which the settlement path normalizes anyway); the split is the recommender's share of the
 * combined reward. An empty remainder (both rates 0 → margin 100%) has no meaningful split, so it
 * canonicalises to 100% recommender.
 */
export function deriveMarginSplitFromBps(referrerBps: number, consumerBps: number): MarginSplit {
  const rewardSum = referrerBps + consumerBps;
  const marginBps = Math.max(0, 10_000 - rewardSum);
  const recommenderSplitBps =
    rewardSum === 0 ? 10_000 : Math.round((referrerBps * 10_000) / rewardSum);
  return { marginBps, recommenderSplitBps };
}
