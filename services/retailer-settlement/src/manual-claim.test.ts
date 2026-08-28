import { describe, expect, it } from "vitest";
import { manualClaimWrite } from "./manual-claim";

describe("manualClaimWrite", () => {
  it("builds a referrer-only ConversionWrite from a claim (consumer none)", () => {
    const w = manualClaimWrite({
      orderId: "O1",
      recommendationId: "R1",
      referrerSub: "sub-1",
      cashback: { referrerBps: 5000, consumerBps: 0 },
      gross: 100n,
      currency: "USD",
      status: "confirmed",
      occurredAt: "2026-08-01T00:00:00.000Z",
    });
    expect(w.consumer).toBe("none");
    expect(w.resolved.consumer).toBeNull();
    expect(w.resolved.status).toBe("confirmed");
    expect(w.resolved.orderId).toBe("O1");
    expect(w.resolved.recommendationId).toBe("R1");
    expect(w.resolved.referrer.sub).toBe("sub-1");
    // 50% of a 100-minor gross commission.
    expect(w.resolved.referrer.reward.amountMinor).toBe(50n);
    expect(w.resolved.referrer.reward.currency).toBe("USD");
    expect(w.gross.amountMinor).toBe(100n);
    expect(w.resolved.occurredAt).toBe("2026-08-01T00:00:00.000Z");
  });
});
