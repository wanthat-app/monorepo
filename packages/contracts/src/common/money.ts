import { z } from "zod";

/** ISO-4217 currency code (e.g. ILS, USD). */
export const Currency = z
  .string()
  .regex(/^[A-Z]{3}$/, "ISO-4217 currency code")
  .describe("ISO-4217 currency");
export type Currency = z.infer<typeof Currency>;

/**
 * Monetary amount: integer **minor units** as a `bigint` (money must be exact — never a
 * float), tagged with its `currency`. On the JSON wire the amount travels as a decimal string
 * (JSON has no bigint); this schema accepts that string (or a bigint) and yields a `bigint`,
 * and the HTTP layer serialises bigint → string on the way out. May be negative
 * (clawbacks/adjustments). No currency is assumed — every amount carries its own, so the
 * model is currency-agnostic by design.
 */
export const Money = z.object({
  amountMinor: z.union([z.bigint(), z.string().regex(/^-?\d+$/)]).transform((v) => BigInt(v)),
  currency: Currency,
});
export type Money = z.infer<typeof Money>;
