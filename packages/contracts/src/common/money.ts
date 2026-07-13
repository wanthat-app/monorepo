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

/** Basis points — 1/100 of a percent. `0`–`10000` spans 0–100%. Used for commission/cashback rates. */
export const Bps = z.number().int().min(0).max(10000);
export type Bps = z.infer<typeof Bps>;

/**
 * Serialise a contract-parsed value as an HTTP response with Money's wire rule (bigint minor
 * units → decimal string; `JSON.stringify`/`c.json` throw on bigint). Every response that
 * carries a `Money` (directly or nested) must go through this. Framework-free on purpose —
 * hono handlers return the `Response` as-is — so the wire rule has exactly one home.
 */
export function moneyJson(value: unknown, status = 200): Response {
  return new Response(
    JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
    { status, headers: { "content-type": "application/json" } },
  );
}
