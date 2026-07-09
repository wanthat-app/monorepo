import { describe, expect, it } from "vitest";
import { ConversionEvent, FunnelEvent } from "./events";

describe("ConversionEvent", () => {
  const base = {
    type: "conversion",
    recommendationId: "abc123DEF45",
    consumer: "guest",
    orderId: "8123456789",
    commission: { amountMinor: "1240", currency: "USD" },
    at: "2026-07-09T10:00:00.000Z",
  };

  it("parses and is JSON-safe (string minor units, no bigint)", () => {
    const parsed = ConversionEvent.parse(base);
    expect(() => JSON.stringify(parsed)).not.toThrow();
    expect(parsed.commission?.amountMinor).toBe("1240");
  });

  it("allows a null commission and discriminates in FunnelEvent", () => {
    const parsed = FunnelEvent.parse({ ...base, commission: null });
    expect(parsed.type).toBe("conversion");
  });

  it("rejects a non-integer amount", () => {
    expect(() =>
      ConversionEvent.parse({ ...base, commission: { amountMinor: "12.40", currency: "USD" } }),
    ).toThrow();
  });
});
