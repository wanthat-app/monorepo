import { z } from "zod";
import { ExchangeRate } from "./rate";

// GET /admin/fx-rates — the current cached rates, for visibility in the admin console.
export const ListFxRatesResponse = z.object({ rates: z.array(ExchangeRate) });
export type ListFxRatesResponse = z.infer<typeof ListFxRatesResponse>;

// POST /admin/fx-rates/refresh — trigger an out-of-band rates-update run (audited admin action),
// e.g. before a known FX move; returns the freshly cached rates.
export const RefreshFxRatesResponse = z.object({ rates: z.array(ExchangeRate) });
export type RefreshFxRatesResponse = z.infer<typeof RefreshFxRatesResponse>;
