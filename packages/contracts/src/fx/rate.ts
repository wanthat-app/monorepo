import { z } from "zod";
import { Currency, IsoDateTime } from "../common";

/** An exact decimal exchange rate as a string — quote units per **1** base unit, e.g. `"3.7215"`. */
export const RateDecimal = z.string().regex(/^\d+(\.\d+)?$/, "decimal rate");
export type RateDecimal = z.infer<typeof RateDecimal>;

/**
 * A cached FX rate (UC8 — FX rate update). One item per ordered pair in the DynamoDB `fx_rate`
 * table, keyed by `(base, quote)`: `rate` is quote-per-base, refreshed by the scheduled rates-updater
 * from an external provider, and read by the conversion function at display + withdrawal. `asOf` is
 * when the provider quoted it — the basis for any staleness check.
 */
export const ExchangeRate = z.object({
  base: Currency,
  quote: Currency,
  rate: RateDecimal,
  asOf: IsoDateTime,
});
export type ExchangeRate = z.infer<typeof ExchangeRate>;
