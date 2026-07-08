import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Bindings } from "./claims";

/**
 * Serialise a contract-parsed value with Money's wire rule (bigint minor units → decimal
 * string). `c.json` would throw on bigint — JSON has no bigint (see contracts/common/money.ts).
 * Every response that carries a `Money` (directly or nested) must go through this, not `c.json`.
 */
export function moneyJson(
  c: Context<{ Bindings: Bindings }>,
  value: unknown,
  status: ContentfulStatusCode = 200,
): Response {
  return c.body(
    JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
    status,
    { "content-type": "application/json" },
  );
}
