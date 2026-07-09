import { z } from "zod";

/** One day of the signup trend: an ISO calendar date (YYYY-MM-DD, Asia/Jerusalem) + how many
 * customers registered that day. The series is dense (zero-filled) so the chart has a fixed axis. */
export const UsersDailySignup = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD"),
  count: z.number().int().nonnegative(),
});
export type UsersDailySignup = z.infer<typeof UsersDailySignup>;

/**
 * GET /admin/stats/users — customer-population metrics for the admin dashboard.
 *
 * Since T7 (ADR-0006 decision 4: Aurora is money-only; the `customer` table is dropped) these
 * metrics have NO in-VPC data source: the customer store is Cognito, and admin-api cannot reach
 * cognito-idp from the endpoint-free VPC (ADR-0004). Every field is therefore optional and the
 * endpoint currently returns an empty object; the approximate pool total is served instead by
 * `ListUsersResponse.total` on the users page (admin-credentials, non-VPC —
 * `DescribeUserPool.EstimatedNumberOfUsers`). The fields are kept, optional rather than deleted,
 * so the SPA dashboard keeps compiling until its Cognito-era rework decides what to show here
 * (status split and signup trend would need a `ListUsers`-derived aggregation — deliberately
 * deferred; see ADR-0006 "Admin user views").
 *
 * `usersCount` / `suspendedUsersCount` (additive) revived the dashboard KPI as an EXACT figure:
 * they read the `customerCounter` item in the OpsCounters table (atomic ADD, kept by
 * the Post-Confirmation trigger + the admin moderation routes). Semantics differ from the legacy
 * fields on purpose — the counter counts CONFIRMED customers only (only PostConfirmation
 * increments), while the users page's `ListUsersResponse.total` stays the approximate WHOLE pool
 * including UNCONFIRMED users.
 */
export const UsersStats = z.object({
  /** Exact confirmed-customer total from the `customerCounter` item. */
  usersCount: z.number().int().nonnegative().optional(),
  /** Exact suspended subset of `usersCount` (counter `disabled`). Active = usersCount - this. */
  suspendedUsersCount: z.number().int().nonnegative().optional(),
  total: z.number().int().nonnegative().optional(),
  active: z.number().int().nonnegative().optional(),
  suspended: z.number().int().nonnegative().optional(),
  /** Registered since local midnight today (Asia/Jerusalem). */
  newToday: z.number().int().nonnegative().optional(),
  /** Registered in the rolling last 7 / 30 days. */
  new7d: z.number().int().nonnegative().optional(),
  new30d: z.number().int().nonnegative().optional(),
  /** Dense, ascending, exactly 30 entries (oldest → today) for the trend chart. */
  dailySignups: z.array(UsersDailySignup).length(30).optional(),
});
export type UsersStats = z.infer<typeof UsersStats>;
