import { z } from "zod";
import { DailyCount } from "./daily";

/**
 * GET /admin/stats/catalog — exact entity totals from the transactional counters (the sentinel
 * `#counter` items incremented atomically with each conditional create), plus the daily
 * recommendations-created trend (`recsDaily#<date>` items in OpsCounters, bumped fire-and-forget
 * by app-links on each NEW create). `products` = shared catalog items; `recommendations` =
 * members' created links. `dailyCreated`: dense, ascending, exactly 30 entries (oldest → today,
 * Asia/Jerusalem); days before the 2026-07 dashboard slice read as zero.
 */
export const CatalogStats = z.object({
  products: z.number().int().nonnegative(),
  recommendations: z.number().int().nonnegative(),
  dailyCreated: z.array(DailyCount).length(30),
});
export type CatalogStats = z.infer<typeof CatalogStats>;
