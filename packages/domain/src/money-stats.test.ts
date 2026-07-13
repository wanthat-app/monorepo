import { describe, expect, it } from "vitest";
import { deriveMoneyStats, type MoneyStatsRow } from "./money-stats";

const DATES = ["2026-07-11", "2026-07-12", "2026-07-13"];

const row = (over: Partial<MoneyStatsRow>): MoneyStatsRow => ({
  kind: "referrer_cashback",
  amountMinor: 500n,
  currency: "USD",
  orderId: "order-1",
  status: "pending",
  date: "2026-07-12",
  ...over,
});

describe("deriveMoneyStats — lifecycle collapse", () => {
  it("furthest status wins: pending+confirmed rows count once, as confirmed", () => {
    const stats = deriveMoneyStats(
      [row({ status: "pending", date: "2026-07-11" }), row({ status: "confirmed" })],
      DATES,
    );
    expect(stats.totals).toEqual([
      {
        currency: "USD",
        confirmedMinor: 500n,
        pendingMinor: 0n,
        confirmedInWindowMinor: 500n,
      },
    ]);
  });

  it("clawback contributes zero everywhere", () => {
    const stats = deriveMoneyStats(
      [row({ status: "pending" }), row({ status: "confirmed" }), row({ status: "clawback" })],
      DATES,
    );
    expect(stats.totals[0]?.confirmedMinor).toBe(0n);
    expect(stats.totals[0]?.pendingMinor).toBe(0n);
    expect(stats.totals[0]?.confirmedInWindowMinor).toBe(0n);
  });

  it("same order, different kinds collapse separately", () => {
    const stats = deriveMoneyStats(
      [
        row({ kind: "referrer_cashback", status: "confirmed", amountMinor: 500n }),
        row({ kind: "consumer_reward", status: "pending", amountMinor: 200n }),
      ],
      DATES,
    );
    expect(stats.totals[0]?.confirmedMinor).toBe(500n);
    expect(stats.totals[0]?.pendingMinor).toBe(200n);
  });

  it("NULL orderId rows stand alone (never collapsed together)", () => {
    const stats = deriveMoneyStats(
      [
        row({ orderId: null, status: "pending", amountMinor: 100n }),
        row({ orderId: null, status: "pending", amountMinor: 100n }),
      ],
      DATES,
    );
    expect(stats.totals[0]?.pendingMinor).toBe(200n);
  });
});

describe("deriveMoneyStats — window", () => {
  it("confirmed-in-window uses the CONFIRMED row's date, not the pending row's", () => {
    const stats = deriveMoneyStats(
      [
        row({ status: "pending", date: "2026-06-01" }), // long before the window
        row({ status: "confirmed", date: "2026-07-12" }),
      ],
      DATES,
    );
    expect(stats.totals[0]?.confirmedInWindowMinor).toBe(500n);
  });

  it("a reward confirmed before the window counts all-time but not in-window", () => {
    const stats = deriveMoneyStats([row({ status: "confirmed", date: "2026-06-01" })], DATES);
    expect(stats.totals[0]?.confirmedMinor).toBe(500n);
    expect(stats.totals[0]?.confirmedInWindowMinor).toBe(0n);
  });
});

describe("deriveMoneyStats — conversions", () => {
  it("both kinds on one order = ONE conversion, bucketed to the earliest row's date", () => {
    const stats = deriveMoneyStats(
      [
        row({ kind: "referrer_cashback", date: "2026-07-12" }),
        row({ kind: "consumer_reward", date: "2026-07-13" }),
      ],
      DATES,
    );
    expect(stats.conversionsInWindow).toBe(1);
    expect(stats.dailyConversions).toEqual([
      { date: "2026-07-11", count: 0 },
      { date: "2026-07-12", count: 1 },
      { date: "2026-07-13", count: 0 },
    ]);
  });

  it("orders first seen before the window are not window conversions", () => {
    const stats = deriveMoneyStats(
      [row({ date: "2026-06-01" }), row({ orderId: "order-2", date: "2026-07-13" })],
      DATES,
    );
    expect(stats.conversionsInWindow).toBe(1);
  });

  it("orphan rows (null orderId) are not conversions", () => {
    const stats = deriveMoneyStats([row({ orderId: null })], DATES);
    expect(stats.conversionsInWindow).toBe(0);
  });

  it("clawed-back orders still COUNT as conversions (the order happened)", () => {
    const stats = deriveMoneyStats(
      [row({ status: "pending" }), row({ status: "clawback", date: "2026-07-13" })],
      DATES,
    );
    expect(stats.conversionsInWindow).toBe(1);
  });
});

describe("deriveMoneyStats — shape", () => {
  it("multi-currency totals are sorted by currency", () => {
    const stats = deriveMoneyStats(
      [
        row({ currency: "USD", status: "confirmed" }),
        row({ currency: "ILS", orderId: "order-ils", status: "pending", amountMinor: 300n }),
      ],
      DATES,
    );
    expect(stats.totals.map((t) => t.currency)).toEqual(["ILS", "USD"]);
  });

  it("an empty ledger yields empty totals and a dense zero series", () => {
    const stats = deriveMoneyStats([], DATES);
    expect(stats.totals).toEqual([]);
    expect(stats.conversionsInWindow).toBe(0);
    expect(stats.dailyConversions).toEqual(DATES.map((date) => ({ date, count: 0 })));
  });
});
