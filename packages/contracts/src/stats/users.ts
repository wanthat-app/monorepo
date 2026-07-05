import { z } from "zod";

/** One day of the signup trend: an ISO calendar date (YYYY-MM-DD, Asia/Jerusalem) + how many
 * customers registered that day. The series is dense (zero-filled) so the chart has a fixed axis. */
export const UsersDailySignup = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD"),
  count: z.number().int().nonnegative(),
});
export type UsersDailySignup = z.infer<typeof UsersDailySignup>;

/**
 * GET /admin/stats/users — real customer metrics for the admin dashboard (ADR-0002/0020). All derived
 * from the Aurora `customer` table (read-only as `app_ro`): a total, status split, recent-signup
 * windows, and a 30-day daily-signup trend. Day boundaries are Asia/Jerusalem (the operating market).
 */
export const UsersStats = z.object({
  total: z.number().int().nonnegative(),
  active: z.number().int().nonnegative(),
  suspended: z.number().int().nonnegative(),
  /** Registered since local midnight today (Asia/Jerusalem). */
  newToday: z.number().int().nonnegative(),
  /** Registered in the rolling last 7 / 30 days. */
  new7d: z.number().int().nonnegative(),
  new30d: z.number().int().nonnegative(),
  /** Dense, ascending, exactly 30 entries (oldest → today) for the trend chart. */
  dailySignups: z.array(UsersDailySignup).length(30),
});
export type UsersStats = z.infer<typeof UsersStats>;
