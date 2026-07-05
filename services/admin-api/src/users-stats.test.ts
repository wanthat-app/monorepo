import { describe, expect, it } from "vitest";
import { buildUsersStats, last30Dates } from "./users-stats";

describe("last30Dates", () => {
  it("returns 30 ascending YYYY-MM-DD dates ending today (in the given tz)", () => {
    const now = Date.UTC(2026, 5, 30, 12, 0, 0); // 2026-06-30 noon UTC
    const dates = last30Dates(now, "UTC");
    expect(dates).toHaveLength(30);
    expect(dates[0]).toBe("2026-06-01");
    expect(dates[29]).toBe("2026-06-30");
    expect([...dates].sort()).toEqual(dates); // already ascending
  });
});

describe("buildUsersStats", () => {
  const axis = last30Dates(Date.UTC(2026, 5, 30, 12), "UTC");

  it("coerces string counts, zero-fills the trend onto the full 30-day axis", () => {
    const stats = buildUsersStats(
      {
        total: "2",
        active: "2",
        suspended: "0",
        new_today: "1",
        new_7d: "1",
        new_30d: "2",
      },
      [
        { date: "2026-06-10", count: "1" },
        { date: "2026-06-30", count: "1" },
      ],
      axis,
    );
    expect(stats.total).toBe(2);
    expect(stats.newToday).toBe(1);
    expect(stats.dailySignups).toHaveLength(30);
    expect(stats.dailySignups.find((d) => d.date === "2026-06-10")?.count).toBe(1);
    expect(stats.dailySignups.find((d) => d.date === "2026-06-30")?.count).toBe(1);
    // A day with no signups is present with count 0 (dense series).
    expect(stats.dailySignups.find((d) => d.date === "2026-06-11")?.count).toBe(0);
    expect(stats.dailySignups.reduce((s, d) => s + d.count, 0)).toBe(2);
  });

  it("handles an empty database (no rows) as all zeros + a 30-day zero series", () => {
    const stats = buildUsersStats(undefined, [], axis);
    expect(stats.total).toBe(0);
    expect(stats.active).toBe(0);
    expect(stats.dailySignups).toHaveLength(30);
    expect(stats.dailySignups.every((d) => d.count === 0)).toBe(true);
  });
});
