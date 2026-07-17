import { Logger } from "@aws-lambda-powertools/logger";
import type { UnattributedOrderItem } from "@wanthat/dynamo";
import { describe, expect, it, vi } from "vitest";
import { type SettleClaimsDeps, settleClaims } from "./settle-claims";

const NOW = new Date("2026-07-10T15:00:00.000Z");
const SUB_REFERRER = "22222222-2222-2222-2222-222222222222";
const REC = {
  recommendationId: "abc123DEF45",
  ownerId: SUB_REFERRER,
  cashback: { referrerBps: 5000, consumerBps: 2500 },
};

const CLAIMED: UnattributedOrderItem = {
  orderId: "1121635427126421",
  reason: "no_ref",
  orderStatus: "Payment Completed",
  commissionMinor: "124",
  currency: "USD",
  occurredAt: "2026-07-09T05:17:21.000Z",
  productId: null,
  productTitle: null,
  productImageUrl: null,
  productDetailUrl: null,
  productCount: null,
  paidAmountMinor: null,
  commissionRate: null,
  subOrderId: null,
  firstSeenAt: "2026-07-10T10:00:00.000Z",
  lastSeenAt: "2026-07-10T10:00:00.000Z",
  state: "claimed",
  claim: {
    recommendationId: "abc123DEF45",
    claimedBy: "dennis@wanthat.app",
    claimedAt: "2026-07-10T12:00:00.000Z",
  },
  settledAt: null,
};

function makeDeps(over: Partial<SettleClaimsDeps> = {}) {
  const invokeWriter = vi.fn(async (_req: { conversions: unknown[] }) => ({
    appended: [{ orderId: CLAIMED.orderId, kind: "referrer_cashback", status: "pending" }],
    failed: [],
  }));
  const unattributed = {
    listByState: vi.fn(async () => ({ items: [CLAIMED], lastKey: undefined })),
    settle: vi.fn(async () => ({ ...CLAIMED, state: "settled" as const })),
  };
  const deps: SettleClaimsDeps = {
    unattributed: unattributed as never,
    recommendations: { get: vi.fn(async () => REC as never) },
    invokeWriter: invokeWriter as never,
    now: () => NOW,
    logger: new Logger({ serviceName: "test" }),
    ...over,
  };
  return { deps, invokeWriter, unattributed };
}

describe("settleClaims", () => {
  it("writes the claim through the writer with the rec's snapshot split, then settles", async () => {
    const { deps, invokeWriter, unattributed } = makeDeps();
    const summary = await settleClaims(deps);
    expect(summary).toEqual({ processed: 1, settled: 1, failed: 0 });

    expect(unattributed.listByState).toHaveBeenCalledWith("claimed", 25);
    const req = invokeWriter.mock.calls[0]?.[0] as {
      conversions: Array<Record<string, unknown>>;
    };
    expect(req.conversions).toHaveLength(1);
    expect(req.conversions[0]).toMatchObject({
      consumer: "none",
      gross: { amountMinor: 124n, currency: "USD" },
      resolved: {
        orderId: CLAIMED.orderId,
        recommendationId: "abc123DEF45",
        referrer: { sub: SUB_REFERRER, reward: { amountMinor: 62n, currency: "USD" } },
        consumer: null,
        status: "pending", // "Payment Completed" maps to pending
        occurredAt: CLAIMED.occurredAt,
      },
    });
    expect(unattributed.settle).toHaveBeenCalledWith(CLAIMED.orderId, NOW.toISOString());
  });

  it("settles an idempotent retry (nothing appended, nothing failed)", async () => {
    const { deps, unattributed } = makeDeps({
      invokeWriter: vi.fn(async () => ({ appended: [], failed: [] })) as never,
    });
    const summary = await settleClaims(deps);
    expect(summary).toEqual({ processed: 1, settled: 1, failed: 0 });
    expect(unattributed.settle).toHaveBeenCalled();
  });

  it("leaves the item claimed when the writer reports a failure", async () => {
    const { deps, unattributed } = makeDeps({
      invokeWriter: vi.fn(async () => ({
        appended: [],
        failed: [{ orderId: CLAIMED.orderId, error: "boom" }],
      })) as never,
    });
    const summary = await settleClaims(deps);
    expect(summary).toEqual({ processed: 1, settled: 0, failed: 1 });
    expect(unattributed.settle).not.toHaveBeenCalled();
  });

  it("leaves the item claimed when the claimed recommendation vanished", async () => {
    const { deps, unattributed } = makeDeps({
      recommendations: { get: vi.fn(async () => undefined) },
    });
    const summary = await settleClaims(deps);
    expect(summary).toEqual({ processed: 1, settled: 0, failed: 1 });
    expect(unattributed.settle).not.toHaveBeenCalled();
  });

  it("does nothing in dry mode (no writer): claims stay queued", async () => {
    const { deps, unattributed } = makeDeps({ invokeWriter: null });
    const summary = await settleClaims(deps);
    expect(summary).toEqual({ processed: 0, settled: 0, failed: 0 });
    expect(unattributed.listByState).not.toHaveBeenCalled();
  });

  it("a throwing writer counts as failed and does not settle", async () => {
    const { deps, unattributed } = makeDeps({
      invokeWriter: vi.fn(async () => {
        throw new Error("invoke exploded");
      }) as never,
    });
    const summary = await settleClaims(deps);
    expect(summary).toEqual({ processed: 1, settled: 0, failed: 1 });
    expect(unattributed.settle).not.toHaveBeenCalled();
  });
});
