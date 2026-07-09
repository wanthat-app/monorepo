import type { ConversionWrite } from "@wanthat/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type WriterDeps, writeConversions } from "./writer";

// The db primitives are unit-tested against real Postgres in @wanthat/db; here they are fakes.
vi.mock("@wanthat/db", () => ({
  appendWalletEntry: vi.fn(),
  appendAudit: vi.fn(),
}));

import { appendAudit, appendWalletEntry } from "@wanthat/db";

const appendEntryMock = vi.mocked(appendWalletEntry);
const appendAuditMock = vi.mocked(appendAudit);

const SUB_REFERRER = "22222222-2222-2222-2222-222222222222";
const SUB_MEMBER = "11111111-1111-1111-1111-111111111111";
const NOW = new Date("2026-07-10T12:00:00.000Z");

const memberWrite = (orderId: string): ConversionWrite => ({
  resolved: {
    orderId,
    recommendationId: "abc123DEF45",
    referrer: { sub: SUB_REFERRER, reward: { amountMinor: 62n, currency: "USD" } },
    consumer: { sub: SUB_MEMBER, reward: { amountMinor: 31n, currency: "USD" } },
    status: "pending",
    occurredAt: "2026-07-10T10:00:00.000Z",
  },
  gross: { amountMinor: 124n, currency: "USD" },
  consumer: "member",
});

function makeDeps(): WriterDeps & {
  recommendations: { incrementConversions: ReturnType<typeof vi.fn> };
} {
  return {
    db: {} as never,
    recommendations: { incrementConversions: vi.fn(async () => {}) },
    now: () => NOW,
  };
}

let logSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks();
  appendEntryMock.mockResolvedValue(true);
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => logSpy.mockRestore());

const conversionEvents = () =>
  logSpy.mock.calls
    .map((c) => String(c[0]))
    .filter((l) => l.includes('"conversion"'))
    .map((l) => JSON.parse(l) as Record<string, unknown>);

describe("writeConversions", () => {
  it("appends both parties, audits each row, emits ONE event, bumps the counter", async () => {
    const deps = makeDeps();
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
    expect(deps.recommendations.incrementConversions).toHaveBeenCalledWith("abc123DEF45");
  });

  it("no-ops a duplicate batch: no audit, no event, no counter", async () => {
    appendEntryMock.mockResolvedValue(false);
    const deps = makeDeps();
    const res = await writeConversions([memberWrite("o-1")], deps);
    expect(res.appended).toEqual([]);
    expect(appendAuditMock).not.toHaveBeenCalled();
    expect(conversionEvents()).toEqual([]);
    expect(deps.recommendations.incrementConversions).not.toHaveBeenCalled();
  });

  it("writes a single row for a consumer-null conversion, and skips the counter off-pending", async () => {
    const deps = makeDeps();
    const write = memberWrite("o-2");
    write.resolved.consumer = null;
    write.resolved.status = "confirmed";
    const res = await writeConversions([write], deps);
    expect(res.appended).toEqual([
      { orderId: "o-2", kind: "referrer_cashback", status: "confirmed" },
    ]);
    expect(deps.recommendations.incrementConversions).not.toHaveBeenCalled();
  });

  it("isolates a failing conversion; the rest of the batch lands", async () => {
    appendEntryMock.mockRejectedValueOnce(new Error("aurora hiccup")).mockResolvedValue(true);
    const deps = makeDeps();
    const res = await writeConversions([memberWrite("o-bad"), memberWrite("o-good")], deps);
    expect(res.failed).toEqual([{ orderId: "o-bad", error: "Error: aurora hiccup" }]);
    expect(res.appended.filter((a) => a.orderId === "o-good")).toHaveLength(2);
  });

  it("a counter failure never fails the conversion", async () => {
    const deps = makeDeps();
    deps.recommendations.incrementConversions.mockRejectedValue(new Error("ddb down"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await writeConversions([memberWrite("o-3")], deps);
    expect(res.failed).toEqual([]);
    expect(res.appended).toHaveLength(2);
    errSpy.mockRestore();
  });
});
