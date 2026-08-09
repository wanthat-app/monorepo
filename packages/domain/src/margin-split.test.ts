import { describe, expect, it } from "vitest";
import { deriveBpsFromMarginSplit, deriveMarginSplitFromBps } from "./margin-split";

describe("deriveBpsFromMarginSplit", () => {
  it("carves the margin off the top, then splits the remainder", () => {
    // 20% margin, 60/40 recommender/buyer of the remaining 80%.
    expect(deriveBpsFromMarginSplit(2000, 6000)).toEqual({
      referrerBps: 4800,
      consumerBps: 3200,
    });
  });

  it("keeps referrer + consumer summing to exactly the remainder (no rounding drift)", () => {
    // 20% margin, split ⅓ recommender — remainder 8000 must split exactly.
    const { referrerBps, consumerBps } = deriveBpsFromMarginSplit(2000, 3333);
    expect(referrerBps + consumerBps).toBe(8000);
  });

  it("preserves today's default (margin 50%, all to recommender) as referrer 5000 / consumer 0", () => {
    expect(deriveBpsFromMarginSplit(5000, 10000)).toEqual({ referrerBps: 5000, consumerBps: 0 });
  });

  it("yields an empty reward pool when the margin is 100%", () => {
    expect(deriveBpsFromMarginSplit(10000, 6000)).toEqual({ referrerBps: 0, consumerBps: 0 });
  });
});

describe("deriveMarginSplitFromBps", () => {
  it("recovers the margin as the residual and the split as the recommender's share of it", () => {
    expect(deriveMarginSplitFromBps(4800, 3200)).toEqual({
      marginBps: 2000,
      recommenderSplitBps: 6000,
    });
  });

  it("reads the shipped default (5000 / 0) as margin 50%, all to recommender", () => {
    expect(deriveMarginSplitFromBps(5000, 0)).toEqual({
      marginBps: 5000,
      recommenderSplitBps: 10000,
    });
  });

  it("reports an empty remainder (margin 100%) as split 100% recommender by convention", () => {
    expect(deriveMarginSplitFromBps(0, 0)).toEqual({
      marginBps: 10000,
      recommenderSplitBps: 10000,
    });
  });

  it("floors the margin at 0 and preserves the ratio when a legacy split exceeds 100%", () => {
    // referrer 8000 + consumer 4000 = 120% (schema allows each independently); margin can't go
    // negative, and the 2:1 recommender:buyer ratio is preserved (6667 ≈ ⅔).
    expect(deriveMarginSplitFromBps(8000, 4000)).toEqual({
      marginBps: 0,
      recommenderSplitBps: 6667,
    });
  });
});

describe("storage stability", () => {
  // The invariant that matters: the stored pair (referrer, consumer) survives a round-trip
  // through the slider view unchanged. Exact sliders→bps→sliders identity does NOT hold — the two
  // roundings can shift the reconstructed split by a bps at extreme margins — but re-deriving from
  // the recovered (margin, split) always reproduces the same stored pair, so a load+save is a
  // no-op. Margin also always recovers exactly.
  it("bps → sliders → bps is identity for every valid stored pair on the 50-bps grid", () => {
    for (let referrerBps = 0; referrerBps <= 10000; referrerBps += 50) {
      for (let consumerBps = 0; referrerBps + consumerBps <= 10000; consumerBps += 50) {
        const { marginBps, recommenderSplitBps } = deriveMarginSplitFromBps(
          referrerBps,
          consumerBps,
        );
        expect(marginBps).toBe(10000 - referrerBps - consumerBps);
        expect(deriveBpsFromMarginSplit(marginBps, recommenderSplitBps)).toEqual({
          referrerBps,
          consumerBps,
        });
      }
    }
  });
});
