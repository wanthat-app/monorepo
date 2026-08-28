import { Logger } from "@aws-lambda-powertools/logger";
import type {
  AliExpressOrder,
  OrderListByIndexParams,
  OrderListPage,
} from "@wanthat/aliexpress";
import type { WriteConversionsRequest, WriteConversionsResponse } from "@wanthat/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  CONFIRMED_STATE_KEY,
  CONFIRMED_STATUS,
  type ScanConfirmedDeps,
  scanConfirmedOrders,
} from "./scan-confirmed";

const NOW = new Date("2026-08-28T10:00:00.000Z");
const REFERRER = "22222222-2222-2222-2222-222222222222";
const REC = {
  recommendationId: "abc123DEF45",
  ownerId: REFERRER,
  cashback: { referrerBps: 5000, consumerBps: 0 },
};

/** A confirmed order; `customParameters` null → no_ref (manual), or set → tracked. */
function order(over: Partial<AliExpressOrder> = {}): AliExpressOrder {
  return {
    orderId: "O1",
    status: CONFIRMED_STATUS,
    customParameters: null,
    commissionMinor: "100",
    commissionCurrency: "USD",
    orderTimeGmt8: null,
    productId: null,
    productTitle: null,
    productImageUrl: null,
    productDetailUrl: null,
    productCount: null,
    paidAmountMinor: null,
    commissionRate: null,
    subOrderId: null,
    ...over,
  };
}

const trackedOrder = (over: Partial<AliExpressOrder> = {}) =>
  order({ customParameters: JSON.stringify({ af: `dev:user:${REFERRER}:rec:abc123DEF45` }), ...over });

function makeDeps(opts: {
  orders?: AliExpressOrder[];
  claims?: Record<string, { recommendationId: string } | undefined>;
  lastRunAt?: string;
  confirmScanDays?: number;
  intervalMinutes?: number;
  withWriter?: boolean;
}) {
  const capturedWindows: OrderListByIndexParams[] = [];
  const listOrdersByIndex = vi.fn(async (params: OrderListByIndexParams): Promise<OrderListPage> => {
    capturedWindows.push(params);
    return { orders: opts.orders ?? [], nextQueryIndexId: null };
  });
  const writes: WriteConversionsRequest[] = [];
  const invokeWriter = opts.withWriter
    ? vi.fn(async (req: WriteConversionsRequest): Promise<WriteConversionsResponse> => {
        writes.push(req);
        return {
          appended: req.conversions.map((c) => ({
            orderId: c.resolved.orderId,
            kind: "referrer_cashback" as const,
            status: c.resolved.status,
          })),
          failed: [],
          conversionTotals: {},
        };
      })
    : null;
  const recordSighting = vi.fn(async () => {});
  const get = vi.fn(async (orderId: string) => {
    const claim = opts.claims?.[orderId];
    return claim
      ? ({ orderId, claim: { ...claim, claimedBy: "admin", claimedAt: "x" } } as never)
      : undefined;
  });
  const state = {
    get: vi.fn(async () =>
      opts.lastRunAt
        ? ({ stateKey: CONFIRMED_STATE_KEY, lastRunAt: opts.lastRunAt, watermarkEndTime: opts.lastRunAt } as never)
        : undefined,
    ),
    put: vi.fn(async () => {}),
  };
  const deps: ScanConfirmedDeps = {
    client: vi.fn(async () => ({ listOrdersByIndex }) as never),
    state: state as never,
    config: {
      get: vi.fn(async (key: string) =>
        key === "poller.confirmScanDays"
          ? (opts.confirmScanDays ?? 80)
          : key === "poller.confirmScanIntervalMinutes"
            ? (opts.intervalMinutes ?? 720)
            : 0,
      ),
    } as never,
    attribution: {
      recommendations: { get: vi.fn(async () => REC as never) },
      guests: { get: vi.fn(async () => undefined) },
      env: "dev",
      fallbackSplit: vi.fn(async () => ({ referrerBps: 5000, consumerBps: 0 })),
      now: () => NOW,
    },
    unattributed: { get, recordSighting } as never,
    invokeWriter: invokeWriter as never,
    now: () => NOW,
    sleep: async () => {},
    logger: new Logger({ serviceName: "test" }),
  };
  return { deps, listOrdersByIndex, capturedWindows, writes, invokeWriter, recordSighting, state, get };
}

describe("scanConfirmedOrders", () => {
  it("writes a confirmed row for a tracked matured order", async () => {
    const { deps, writes } = makeDeps({ orders: [trackedOrder()], withWriter: true });
    const summary = await scanConfirmedOrders(deps);
    expect(summary.ran).toBe(true);
    expect(summary.resolved).toBe(1);
    expect(writes[0]?.conversions[0]?.resolved.status).toBe("confirmed");
  });

  it("injects the stored claim for a manual matured order (no_ref + claim)", async () => {
    const { deps, writes } = makeDeps({
      orders: [order({ orderId: "O9" })],
      claims: { O9: { recommendationId: "abc123DEF45" } },
      withWriter: true,
    });
    const summary = await scanConfirmedOrders(deps);
    expect(summary.injected).toBe(1);
    const w = writes[0]?.conversions[0];
    expect(w?.resolved.status).toBe("confirmed");
    expect(w?.consumer).toBe("none");
    expect(w?.resolved.recommendationId).toBe("abc123DEF45");
    expect(w?.resolved.referrer.reward.amountMinor).toBe(50n);
  });

  it("only sights an unclaimed no_ref order, never credits it", async () => {
    const { deps, writes, recordSighting } = makeDeps({
      orders: [order({ orderId: "O0" })],
      claims: {},
      withWriter: true,
    });
    const summary = await scanConfirmedOrders(deps);
    expect(summary.injected).toBe(0);
    expect(summary.resolved).toBe(0);
    expect(summary.sighted).toBe(1);
    expect(writes).toHaveLength(0);
    expect(recordSighting).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: "O0" }),
      expect.any(String),
    );
  });

  it("skips when the confirm-scan interval has not elapsed", async () => {
    const { deps, listOrdersByIndex, state } = makeDeps({
      lastRunAt: new Date(NOW.getTime() - 60 * 60_000).toISOString(), // 60 min ago < 720
    });
    const summary = await scanConfirmedOrders(deps);
    expect(summary.ran).toBe(false);
    expect(deps.client).not.toHaveBeenCalled();
    expect(listOrdersByIndex).not.toHaveBeenCalled();
    expect(state.put).not.toHaveBeenCalled();
  });

  it("scans [now - confirmScanDays, now] for Buyer Confirmed Receipt", async () => {
    const { deps, capturedWindows } = makeDeps({ confirmScanDays: 80 });
    await scanConfirmedOrders(deps);
    const p = capturedWindows[0];
    expect(p?.status).toBe(CONFIRMED_STATUS);
    // start 80 days before now, in GMT+8 → "2026-06-09 18:00:00"; end now+8h → "2026-08-28 18:00:00"
    expect(p?.startTime).toBe("2026-06-09 18:00:00");
    expect(p?.endTime).toBe("2026-08-28 18:00:00");
  });

  it("advances the cadence gate after a successful run", async () => {
    const { deps, state } = makeDeps({ orders: [trackedOrder()], withWriter: true });
    await scanConfirmedOrders(deps);
    expect(state.put).toHaveBeenCalledWith(
      expect.objectContaining({ stateKey: CONFIRMED_STATE_KEY, lastRunAt: NOW.toISOString() }),
    );
  });
});
