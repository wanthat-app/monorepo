import { describe, expect, it } from "vitest";
import { DailyCount } from "./daily";
import { UsersStats } from "./users";

const dense = Array.from({ length: 30 }, (_, i) => ({
  date: `2026-06-${String(i + 1).padStart(2, "0")}`,
  count: i,
}));

const FULL = {
  usersCount: 41,
  suspendedUsersCount: 3,
  newToday: 1,
  new7d: 1,
  new30d: 2,
  active7d: 4,
  active30d: 9,
  dailySignups: dense,
  dailyActive: dense,
};

describe("UsersStats contract", () => {
  it("accepts a well-formed stats object with dense 30-day series", () => {
    expect(UsersStats.safeParse(FULL).success).toBe(true);
  });

  it("rejects the empty object — every field is served since the dashboard-KPIs slice", () => {
    expect(UsersStats.safeParse({}).success).toBe(false);
  });

  it("rejects a series that is not exactly 30 entries", () => {
    expect(UsersStats.safeParse({ ...FULL, dailySignups: dense.slice(0, 29) }).success).toBe(false);
    expect(UsersStats.safeParse({ ...FULL, dailyActive: dense.slice(0, 29) }).success).toBe(false);
  });

  it("rejects negative counts and malformed dates", () => {
    expect(UsersStats.safeParse({ ...FULL, usersCount: -1 }).success).toBe(false);
    expect(UsersStats.safeParse({ ...FULL, suspendedUsersCount: -1 }).success).toBe(false);
    expect(UsersStats.safeParse({ ...FULL, active7d: -1 }).success).toBe(false);
    expect(DailyCount.safeParse({ date: "2026/06/01", count: 1 }).success).toBe(false);
    expect(DailyCount.safeParse({ date: "2026-06-01", count: -1 }).success).toBe(false);
  });
});
