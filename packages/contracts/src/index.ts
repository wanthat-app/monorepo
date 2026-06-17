import { z } from "zod";

/**
 * Schema-first contracts (ADR-0008). Each contract is defined once as a Zod schema;
 * the static type is inferred via z.infer, and the same schema validates at every
 * trust boundary (API input, external AliExpress payloads, env/config).
 *
 * These are illustrative stubs — extend as the domain is built.
 */

/** ISO-4217 currency code (e.g. ILS, USD). */
export const Currency = z.string().regex(/^[A-Z]{3}$/);
export type Currency = z.infer<typeof Currency>;

/** A monetary amount in integer minor units (agorot for ILS), tagged with its currency. */
export const MoneyMinor = z.object({
  amountMinor: z.bigint(),
  currency: Currency,
});
export type MoneyMinor = z.infer<typeof MoneyMinor>;

/**
 * Attribution values echoed back via AliExpress `custom_parameters` (ADR-0003).
 * `ref` (referrer short_id) is always present; the consumer is `c` (customer_id) when
 * authenticated at click-through, else `g` (opaque guestId) for anonymous clicks.
 */
export const CustomParameters = z.object({
  ref: z.string(),
  c: z.string().uuid().optional(),
  g: z.string().optional(),
});
export type CustomParameters = z.infer<typeof CustomParameters>;

export const Customer = z.object({
  id: z.string().uuid(),
  phoneE164: z.string(),
  email: z.string().email(),
  firstName: z.string(),
  lastName: z.string(),
  locale: z.string().default("he-IL"),
  status: z.enum(["active", "suspended"]),
});
export type Customer = z.infer<typeof Customer>;
