import { afterEach, describe, expect, it } from "vitest";
import { readLandingSnapshot } from "./snapshot";

const OK = {
  status: "ok",
  landing: {
    recommendationId: "abc123DEF45",
    product: {
      storeId: "aliexpress",
      storeProductId: "1005006123456789",
      title: "Feeder",
      imageUrl: null,
      price: { amountMinor: "2500", currency: "USD" },
      commissionBps: 800,
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z",
    },
    review: null,
    estimate: {
      referrer: { rateBps: 5000, estimated: null },
      consumer: { rateBps: 2500, estimated: { amountMinor: "50", currency: "USD" } },
    },
    referrerFirstName: "Dana",
  },
  countdownSeconds: 3,
  displayFx: null,
};

const setRaw = (v: unknown) => {
  (globalThis as { __WANTHAT_LANDING__?: unknown }).__WANTHAT_LANDING__ = v;
};

afterEach(() => {
  delete (globalThis as { __WANTHAT_LANDING__?: unknown }).__WANTHAT_LANDING__;
});

describe("readLandingSnapshot", () => {
  it("parses a valid ok snapshot for the routed id, reviving wire Money to bigint", () => {
    setRaw(OK);
    const snap = readLandingSnapshot("abc123DEF45");
    expect(snap?.status).toBe("ok");
    if (snap?.status !== "ok") return;
    expect(snap.landing.product.price?.amountMinor).toBe(2500n);
    expect(snap.landing.referrerFirstName).toBe("Dana");
    expect(snap.countdownSeconds).toBe(3);
  });

  it("returns null when absent, invalid, or for another id", () => {
    expect(readLandingSnapshot("abc123DEF45")).toBeNull();
    setRaw({ status: "weird" });
    expect(readLandingSnapshot("abc123DEF45")).toBeNull();
    setRaw(OK);
    expect(readLandingSnapshot("otherId0001")).toBeNull();
  });

  it("passes notFound through regardless of id", () => {
    setRaw({ status: "notFound" });
    expect(readLandingSnapshot("abc123DEF45")?.status).toBe("notFound");
  });
});
