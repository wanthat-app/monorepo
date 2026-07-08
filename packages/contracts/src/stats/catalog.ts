import { z } from "zod";

/**
 * GET /admin/stats/catalog — exact entity totals from the transactional counters (the sentinel
 * `#counter` items incremented atomically with each conditional create). `products` = shared
 * catalog items; `recommendations` = members' created links.
 */
export const CatalogStats = z.object({
  products: z.number().int().nonnegative(),
  recommendations: z.number().int().nonnegative(),
});
export type CatalogStats = z.infer<typeof CatalogStats>;
