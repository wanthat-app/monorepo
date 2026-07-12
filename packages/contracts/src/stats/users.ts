import { z } from "zod";
import { DailyCount } from "./daily";

/**
 * GET /admin/stats/users — the dashboard's population + activity metrics, all served from the
 * OpsCounters DynamoDB table (in-VPC admin-api needs no cognito-idp — ADR-0004):
 *
 * - `usersCount` / `suspendedUsersCount`: the EXACT `customerCounter` item (atomic ADD, kept by
 *   the Post-Confirmation trigger + the admin moderation routes). Counts CONFIRMED customers
 *   only — deliberately narrower than the users page's approximate whole-pool estimate
 *   (`ListUsersResponse.total`, includes UNCONFIRMED).
 * - `newToday` / `new7d` / `new30d` + `dailySignups`: sums of the `signupsDaily#<date>` items.
 * - `active7d` / `active30d`: DISTINCT members whose `presence#<sub>` stamp falls in the window.
 *   "Active" means USED THE APP (any authenticated member-API call) — not "signed in recently",
 *   which refresh-token sessions would undercount.
 * - `dailyActive`: the `activeDaily#<date>` items (distinct members per single day).
 *
 * All windows/dates are Asia/Jerusalem. Counters exist from the 2026-07 dashboard slice onward;
 * earlier days read as zero (spec 2026-07-12, approach B).
 */
export const UsersStats = z.object({
  usersCount: z.number().int().nonnegative(),
  suspendedUsersCount: z.number().int().nonnegative(),
  /** Registered since local midnight today / in the rolling last 7 / 30 days. */
  newToday: z.number().int().nonnegative(),
  new7d: z.number().int().nonnegative(),
  new30d: z.number().int().nonnegative(),
  /** Distinct members active in the rolling last 7 / 30 days (see "active" above). */
  active7d: z.number().int().nonnegative(),
  active30d: z.number().int().nonnegative(),
  /** Dense, ascending, exactly 30 entries (oldest → today). */
  dailySignups: z.array(DailyCount).length(30),
  dailyActive: z.array(DailyCount).length(30),
});
export type UsersStats = z.infer<typeof UsersStats>;
