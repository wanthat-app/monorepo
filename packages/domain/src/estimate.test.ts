import { describe, expect, it } from "vitest";
import { buildEstimate } from "./index";

describe("buildEstimate", () => {
  it("splits price x commission into per-side estimates in the origin currency", () => {
    const e = buildEstimate({ amountMinor: "10000", currency: "USD" }, 800, {
      referrerBps: 5000,
      consumerBps: 2500,
    });
    // gross = 10000 * 800 / 10000 = 800 minor; referrer 50% -> 400, consumer 25% -> 200
    expect(e.referrer.estimated).toEqual({ amountMinor: 400n, currency: "USD" });
    expect(e.consumer.estimated).toEqual({ amountMinor: 200n, currency: "USD" });
    expect(e.referrer.rateBps).toBe(5000);
  });

  it("returns null estimates for an unpriced product", () => {
    const e = buildEstimate(null, 800, { referrerBps: 5000, consumerBps: 2500 });
    expect(e.referrer.estimated).toBeNull();
    expect(e.consumer.estimated).toBeNull();
    expect(e.consumer.rateBps).toBe(2500);
  });
});
