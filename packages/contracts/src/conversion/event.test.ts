import { describe, expect, it } from "vitest";
import { ConversionEvent } from "./event";

/**
 * Locks the wire shape the funnel-analytics pipeline (Firehose → S3 → Athena) reads: the poller
 * emits this as a JSON console.log line with Money in wire form (decimal-string minor units).
 */
describe("ConversionEvent", () => {
  const wire = {
    type: "conversion",
    orderId: "8123456789",
    recommendationId: "abc123DEF45",
    consumer: "guest",
    amount: { amountMinor: "1240", currency: "USD" },
    status: "pending",
    at: "2026-07-09T10:00:00.000Z",
  };

  it("parses the wire form (string minor units → bigint)", () => {
    const parsed = ConversionEvent.parse(wire);
    expect(parsed.amount.amountMinor).toBe(1240n);
    expect(parsed.consumer).toBe("guest");
  });

  it("rejects an unknown consumer kind and a non-integer amount", () => {
    expect(() => ConversionEvent.parse({ ...wire, consumer: "bot" })).toThrow();
    expect(() =>
      ConversionEvent.parse({ ...wire, amount: { amountMinor: "12.40", currency: "USD" } }),
    ).toThrow();
  });
});
