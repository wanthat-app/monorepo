import { describe, expect, it } from "vitest";
import { UsersStats } from "./users";

const dense = Array.from({ length: 30 }, (_, i) => ({
  date: `2026-06-${String(i + 1).padStart(2, "0")}`,
  count: i,
}));

describe("UsersStats contract", () => {
  it("accepts a well-formed stats object with a dense 30-day series", () => {
    const ok = UsersStats.safeParse({
      total: 2,
      active: 2,
      suspended: 0,
      newToday: 1,
      new7d: 1,
      new30d: 2,
      dailySignups: dense,
    });
    expect(ok.success).toBe(true);
  });

  it("rejects a signup series that is not exactly 30 entries", () => {
    expect(
      UsersStats.safeParse({
        total: 0,
        active: 0,
        suspended: 0,
        newToday: 0,
        new7d: 0,
        new30d: 0,
        dailySignups: dense.slice(0, 29),
      }).success,
    ).toBe(false);
  });

  it("rejects negative counts and malformed dates", () => {
    expect(UsersStats.safeParse({ total: -1 }).success).toBe(false);
    expect(UsersStats.pick({ total: true }).shape.total.safeParse(-1).success).toBe(false);
    expect(
      UsersStats.shape.dailySignups.element.safeParse({ date: "2026/06/01", count: 1 }).success,
    ).toBe(false);
  });
});
