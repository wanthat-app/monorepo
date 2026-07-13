import type { Context } from "hono";
import type { Bindings } from "./guard";

/** Money's wire rule (bigint minor units → decimal string); `c.json` throws on bigint. */
export function moneyJson(c: Context<{ Bindings: Bindings }>, value: unknown): Response {
  return c.body(
    JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
    200,
    { "content-type": "application/json" },
  );
}
