import { describe, expect, it } from "vitest";
import { PollOrdersResponse } from "../retailer/proxy";
import { WriteConversionsRequest } from "./order";

const WIRE_CONVERSION = {
  resolved: {
    orderId: "8123456789",
    recommendationId: "abc123DEF45",
    referrer: {
      sub: "11111111-1111-1111-1111-111111111111",
      reward: { amountMinor: "62", currency: "USD" },
    },
    consumer: null,
    status: "pending",
    occurredAt: "2026-07-10T10:00:00.000Z",
  },
  gross: { amountMinor: "124", currency: "USD" },
  consumer: "none",
};

describe("WriteConversionsRequest", () => {
  it("round-trips the wire form (string minor units -> bigint)", () => {
    const parsed = WriteConversionsRequest.parse({ conversions: [WIRE_CONVERSION] });
    expect(parsed.conversions[0]?.resolved.referrer.reward.amountMinor).toBe(62n);
    expect(parsed.conversions[0]?.gross.amountMinor).toBe(124n);
    expect(parsed.conversions[0]?.consumer).toBe("none");
  });

  it("rejects an empty batch", () => {
    expect(() => WriteConversionsRequest.parse({ conversions: [] })).toThrow();
  });
});

describe("PollOrdersResponse", () => {
  it("discriminates ok and error", () => {
    const ok = PollOrdersResponse.parse({
      status: "ok",
      ran: true,
      window: { startTime: "2026-07-07 08:00:00", endTime: "2026-07-10 08:00:00" },
      fetched: 3,
      resolved: 2,
      untracked: 1,
      written: null,
    });
    expect(ok.status).toBe("ok");
    const err = PollOrdersResponse.parse({ status: "error", code: "upstream_error" });
    expect(err.status).toBe("error");
  });
});
