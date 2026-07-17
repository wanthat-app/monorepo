import type { ConversionWrite } from "@wanthat/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type WriterDeps, writeConversions } from "./writer";

// The db primitives are unit-tested against real Postgres in @wanthat/db; here they are fakes.
vi.mock("@wanthat/db", () => ({
  appendWalletEntry: vi.fn(),
  appendAudit: vi.fn(),
  conversionTotalsFor: vi.fn(),
}));

import { appendAudit, appendWalletEntry, conversionTotalsFor } from "@wanthat/db";

const appendEntryMock = vi.mocked(appendWalletEntry);
const appendAuditMock = vi.mocked(appendAudit);
const totalsMock = vi.mocked(conversionTotalsFor);

const SUB_REFERRER = "22222222-2222-2222-2222-222222222222";
const SUB_MEMBER = "11111111-1111-1111-1111-111111111111";
const NOW = new Date("2026-07-10T12:00:00.000Z");

const memberWrite = (orderId: string, recommendationId = "abc123DEF45"): ConversionWrite => ({
  resolved: {
    orderId,
    recommendationId,
    referrer: { sub: SUB_REFERRER, reward: { amountMinor: 62n, currency: "USD" } },
    consumer: { sub: SUB_MEMBER, reward: { amountMinor: 31n, currency: "USD" } },
    status: "pending",
    occurredAt: "2026-07-10T10:00:00.000Z",
  },
  gross: { amountMinor: 124n, currency: "USD" },
  consumer: "member",
});

function makeDeps(): WriterDeps {
  return {
    db: {} as never,
    now: () => NOW,
  };
}

let logSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks();
  appendEntryMock.mockResolvedValue(true);
  totalsMock.mockResolvedValue({ abc123DEF45: 1 });
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => logSpy.mockRestore());

const conversionEvents = () =>
  logSpy.mock.calls
    .map((c) => String(c[0]))
    .filter((l) => l.includes('"conversion"'))
    .map((l) => JSON.parse(l) as Record<string, unknown>);

describe("writeConversions", () => {
  it("appends both parties, audits each row, emits ONE event, answers derived totals", async () => {
    const deps = makeDeps();
    totalsMock.mockResolvedValue({ abc123DEF45: 3 });
    const res = await writeConversions([memberWrite("o-1")], deps);
    expect(res.appended).toEqual([
      { orderId: "o-1", kind: "referrer_cashback", status: "pending" },
      { orderId: "o-1", kind: "consumer_reward", status: "pending" },
    ]);
    expect(res.failed).toEqual([]);
    expect(appendAuditMock).toHaveBeenCalledTimes(2);
    // Audit payloads are JSON-safe (string minor units).
    expect(appendAuditMock.mock.calls[0]?.[1]).toMatchObject({
      type: "wallet_entry",
      amountMinor: "62",
      orderId: "o-1",
    });
    const events = conversionEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "conversion",
      orderId: "o-1",
      consumer: "member",
      status: "pending",
      amount: { amountMinor: "124", currency: "USD" },
    });
    // The projection query runs AFTER the appends, over the batch's recommendation ids.
    expect(totalsMock).toHaveBeenCalledWith(deps.db, ["abc123DEF45"]);
    expect(res.conversionTotals).toEqual({ abc123DEF45: 3 });
  });

  it("still answers absolute totals for a fully-duplicate batch (no audit, no event)", async () => {
    appendEntryMock.mockResolvedValue(false);
    totalsMock.mockResolvedValue({ abc123DEF45: 2 });
    const res = await writeConversions([memberWrite("o-1")], makeDeps());
    expect(res.appended).toEqual([]);
    expect(appendAuditMock).not.toHaveBeenCalled();
    expect(conversionEvents()).toEqual([]);
    // The absolute count is read from the ledger, so a duplicate re-offer re-answers it — that
    // is what lets a previously-lost stat application self-heal.
    expect(res.conversionTotals).toEqual({ abc123DEF45: 2 });
  });

  it("writes a single row for a consumer-null conversion", async () => {
    const write = memberWrite("o-2");
    write.resolved.consumer = null;
    write.resolved.status = "confirmed";
    const res = await writeConversions([write], makeDeps());
    expect(res.appended).toEqual([
      { orderId: "o-2", kind: "referrer_cashback", status: "confirmed" },
    ]);
  });

  it("isolates a failing conversion; the rest of the batch lands, totals still cover both recs", async () => {
    appendEntryMock.mockRejectedValueOnce(new Error("aurora hiccup")).mockResolvedValue(true);
    const deps = makeDeps();
    totalsMock.mockResolvedValue({ recBadAA111: 0, recGoodBB22: 1 });
    const res = await writeConversions(
      [memberWrite("o-bad", "recBadAA111"), memberWrite("o-good", "recGoodBB22")],
      deps,
    );
    expect(res.failed).toEqual([{ orderId: "o-bad", error: "Error: aurora hiccup" }]);
    expect(res.appended.filter((a) => a.orderId === "o-good")).toHaveLength(2);
    expect(totalsMock).toHaveBeenCalledWith(deps.db, ["recBadAA111", "recGoodBB22"]);
    expect(res.conversionTotals).toEqual({ recBadAA111: 0, recGoodBB22: 1 });
  });

  it("a totals-query failure never fails the batch — it degrades to an empty record", async () => {
    totalsMock.mockRejectedValue(new Error("query timeout"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await writeConversions([memberWrite("o-3")], makeDeps());
    expect(res.failed).toEqual([]);
    expect(res.appended).toHaveLength(2);
    expect(res.conversionTotals).toEqual({});
    expect(errSpy).toHaveBeenCalledOnce();
    errSpy.mockRestore();
  });
});
