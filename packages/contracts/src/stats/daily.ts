import { z } from "zod";

/** One day of a dashboard trend: an ISO calendar date (YYYY-MM-DD, Asia/Jerusalem) + a count.
 * Series are dense (zero-filled) and ascending so charts get a fixed 30-day axis. */
export const DailyCount = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD"),
  count: z.number().int().nonnegative(),
});
export type DailyCount = z.infer<typeof DailyCount>;
