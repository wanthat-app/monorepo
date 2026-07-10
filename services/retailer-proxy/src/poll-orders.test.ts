import { Logger } from "@aws-lambda-powertools/logger";
import {
  AliExpressApiError,
  type AliExpressOrder,
  type OrderListByIndexParams,
  type OrderListPage,
} from "@wanthat/aliexpress";
import { describe, expect, it, vi } from "vitest";
import {
  POLL_STATUSES,
  POLLER_STATE_KEY,
  type PollOrdersDeps,
  pollOrders,
  toGmt8,
} from "./poll-orders";

const NOW = new Date("2026-07-10T10:00:00.000Z");
const SUB_REFERRER = "22222222-2222-2222-2222-222222222222";
const REC = {
  recommendationId: "abc123DEF45",
  ownerId: SUB_REFERRER,
  cashback: { referrerBps: 5000, consumerBps: 0 },
};

const anOrder = (id: string): AliExpressOrder => ({
  orderId: id,
  status: "Payment Completed",
  customParameters: JSON.stringify({ af: `dev:user:${SUB_REFERRER}:rec:abc123DEF45` }),
  commissionMinor: "124",
  commissionCurrency: "USD",
  orderTimeGmt8: null,
});

interface FakeClient {
  listOrdersByIndex: ReturnType<typeof vi.fn>;
}

function makeDeps(over: Partial<PollOrdersDeps> = {}, pages?: (call: number) => OrderListPage) {
  const listOrdersByIndex = vi.fn(
    async (_params: OrderListByIndexParams): Promise<OrderListPage> => {
      return pages
        ? pages(listOrdersByIndex.mock.calls.length)
        : { orders: [], nextQueryIndexId: null };
    },
  );
  const fakeClient: FakeClient = { listOrdersByIndex };
  const state = { get: vi.fn(async () => undefined as never), put: vi.fn(async () => {}) };
  const unattributed = { recordSighting: vi.fn(async () => {}) };
  const deps: PollOrdersDeps = {
    client: vi.fn(async () => fakeClient as never),
    state: state as never,
    config: {
      get: vi.fn(async (key: string) =>
        key === "poller.intervalMinutes" ? 30 : key === "poller.lookbackHours" ? 72 : 0,
      ),
    } as never,
    attribution: {
      recommendations: { get: vi.fn(async () => REC as never) },
      guests: { get: vi.fn(async () => undefined) },
      env: "dev",
      fallbackSplit: vi.fn(async () => ({ referrerBps: 5000, consumerBps: 0 })),
      now: () => NOW,
    },
    unattributed,
    invokeWriter: null,
    now: () => NOW,
    sleep: async () => {},
    logger: new Logger({ serviceName: "test" }),
    ...over,
  };
  return { deps, listOrdersByIndex, state, unattributed };
}

describe("toGmt8", () => {
  it("formats UTC instants on the platform's +8 clock", () => {
    expect(toGmt8(new Date("2026-07-10T00:00:00.000Z"))).toBe("2026-07-10 08:00:00");
    expect(toGmt8(new Date("2026-07-09T20:30:00.000Z"))).toBe("2026-07-10 04:30:00");
  });
});

describe("pollOrders", () => {
  it("gates on poller.intervalMinutes without touching the retailer", async () => {
    const { deps, listOrdersByIndex, state } = makeDeps();
    state.get.mockResolvedValue({
      stateKey: POLLER_STATE_KEY,
      lastRunAt: new Date(NOW.getTime() - 10 * 60_000).toISOString(), // 10 min ago < 30
      watermarkEndTime: NOW.toISOString(),
    } as never);
    const res = await pollOrders(deps);
    expect(res).toMatchObject({ status: "ok", ran: false, written: null });
    expect(deps.client).not.toHaveBeenCalled();
    expect(listOrdersByIndex).not.toHaveBeenCalled();
    expect(state.put).not.toHaveBeenCalled();
  });

  it("first run sweeps the full lookback window per status, pages cursors, advances state", async () => {
    const { deps, listOrdersByIndex, state } = makeDeps({}, (call) =>
      call === 1
        ? { orders: [anOrder("o-1")], nextQueryIndexId: "c2" }
        : call === 2
          ? { orders: [anOrder("o-2")], nextQueryIndexId: null }
          : { orders: [], nextQueryIndexId: null },
    );
    const res = await pollOrders(deps);
    if (res.status !== "ok") throw new Error("expected ok");
    expect(res.ran).toBe(true);
    // 72h lookback from NOW, GMT+8
    expect(res.window).toEqual({
      startTime: "2026-07-07 18:00:00",
      endTime: "2026-07-10 18:00:00",
    });
    expect(res.fetched).toBe(2);
    expect(res.resolved).toBe(2);
    expect(res.written).toBeNull(); // dry mode
    // one cursor loop per status: 2 pages for the first + 1 each for the other two
    expect(listOrdersByIndex).toHaveBeenCalledTimes(2 + (POLL_STATUSES.length - 1));
    expect(listOrdersByIndex.mock.calls[0]?.[0]).toMatchObject({
      status: POLL_STATUSES[0],
      pageSize: 50,
    });
    expect(listOrdersByIndex.mock.calls[1]?.[0]).toMatchObject({ startQueryIndexId: "c2" });
    expect(state.put).toHaveBeenCalledWith({
      stateKey: POLLER_STATE_KEY,
      lastRunAt: NOW.toISOString(),
      watermarkEndTime: NOW.toISOString(),
    });
  });

  it("windows from the watermark minus overlap when state exists and a run is due", async () => {
    const { deps, state } = makeDeps();
    state.get.mockResolvedValue({
      stateKey: POLLER_STATE_KEY,
      lastRunAt: new Date(NOW.getTime() - 45 * 60_000).toISOString(), // due (45 > 30)
      watermarkEndTime: new Date(NOW.getTime() - 45 * 60_000).toISOString(),
    } as never);
    const res = await pollOrders(deps);
    if (res.status !== "ok") throw new Error("expected ok");
    // watermark 09:15Z − 1h overlap = 08:15Z → 16:15 GMT+8
    expect(res.window?.startTime).toBe("2026-07-10 16:15:00");
  });

  it("retries once on ApiCallLimit, then succeeds", async () => {
    let calls = 0;
    const { deps, listOrdersByIndex } = makeDeps();
    listOrdersByIndex.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) throw new AliExpressApiError("ApiCallLimit", "slow down");
      return { orders: [], nextQueryIndexId: null };
    });
    const res = await pollOrders(deps);
    expect(res.status).toBe("ok");
  });

  it("aborts with error and no state advance when a page throws", async () => {
    const { deps, listOrdersByIndex, state } = makeDeps();
    listOrdersByIndex.mockRejectedValue(new AliExpressApiError("http_500", "boom"));
    const res = await pollOrders(deps);
    expect(res).toMatchObject({ status: "error", code: "upstream_error" });
    expect(state.put).not.toHaveBeenCalled();
  });

  it("answers retailer_not_configured when there is no credential", async () => {
    const { deps } = makeDeps({ client: vi.fn(async () => null) });
    const res = await pollOrders(deps);
    expect(res).toMatchObject({ status: "error", code: "retailer_not_configured" });
  });

  it("passes resolved conversions to the writer in batches and aggregates the summary", async () => {
    const orders = Array.from({ length: 30 }, (_, i) => anOrder(`o-${i}`));
    const invokeWriter = vi.fn(async (req: { conversions: unknown[] }) => ({
      appended: req.conversions.map(() => ({
        orderId: "x",
        kind: "referrer_cashback",
        status: "pending",
      })),
      failed: [],
    }));
    const { deps } = makeDeps({ invokeWriter: invokeWriter as never }, (call) =>
      call === 1 ? { orders, nextQueryIndexId: null } : { orders: [], nextQueryIndexId: null },
    );
    const res = await pollOrders(deps);
    if (res.status !== "ok") throw new Error("expected ok");
    expect(invokeWriter).toHaveBeenCalledTimes(2); // 25 + 5
    expect(invokeWriter.mock.calls[0]?.[0].conversions).toHaveLength(25);
    expect(res.written).toEqual({ appended: 30, failed: 0 });
  });

  it("counts untracked orders without failing the run and emits the typed funnel event", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { deps, unattributed } = makeDeps({}, (call) =>
        call === 1
          ? {
              orders: [anOrder("good"), { ...anOrder("bad"), customParameters: null }],
              nextQueryIndexId: null,
            }
          : { orders: [], nextQueryIndexId: null },
      );
      const res = await pollOrders(deps);
      if (res.status !== "ok") throw new Error("expected ok");
      expect(res.resolved).toBe(1);
      expect(res.untracked).toBe(1);

      // The claim-queue projection saw the same sighting.
      expect(unattributed.recordSighting).toHaveBeenCalledWith(
        {
          orderId: "bad",
          reason: "no_ref",
          orderStatus: "Payment Completed",
          commissionMinor: "124",
          currency: "USD",
          occurredAt: null,
        },
        NOW.toISOString(),
      );

      const events = logSpy.mock.calls
        .map((c) => String(c[0]))
        .filter((l) => l.includes('"order_untracked"'))
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(events).toEqual([
        {
          type: "order_untracked",
          orderId: "bad",
          reason: "no_ref",
          orderStatus: "Payment Completed",
          amount: { amountMinor: "124", currency: "USD" },
          at: NOW.toISOString(),
        },
      ]);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("a foreign-env order counts as untracked but emits NO funnel event (not ours)", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const foreign = {
        ...anOrder("other-env"),
        customParameters: JSON.stringify({
          af: `prod:user:${SUB_REFERRER}:rec:abc123DEF45`,
        }),
      };
      const { deps, unattributed } = makeDeps({}, (call) =>
        call === 1
          ? { orders: [foreign], nextQueryIndexId: null }
          : { orders: [], nextQueryIndexId: null },
      );
      const res = await pollOrders(deps);
      if (res.status !== "ok") throw new Error("expected ok");
      expect(res.untracked).toBe(1);
      expect(
        logSpy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('"order_untracked"')),
      ).toEqual([]);
      expect(unattributed.recordSighting).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
    }
  });
});
