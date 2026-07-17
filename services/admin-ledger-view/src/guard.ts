import type { Context, Next } from "hono";
import type { LambdaEvent } from "hono/aws-lambda";

export type Bindings = { event: LambdaEvent };

/**
 * Admin authorisation (ADR-0002, defence in depth). The HTTP API JWT authorizer already validates
 * the token; this re-checks membership of the Cognito `admin` group in-handler, since the JWT
 * authorizer cannot gate on group membership (that would need a Lambda authorizer — deferred).
 */
export async function requireAdmin(c: Context<{ Bindings: Bindings }>, next: Next) {
  // biome-ignore lint/suspicious/noExplicitAny: authorizer claim shape varies by event type
  const claims = (c.env?.event as any)?.requestContext?.authorizer?.jwt?.claims ?? {};
  const groups = claims["cognito:groups"];
  const isAdmin = Array.isArray(groups)
    ? groups.includes("admin")
    : typeof groups === "string" && groups.split(/[\s,[\]]+/).includes("admin");
  if (!isAdmin) return c.json({ error: "forbidden" }, 403);
  await next();
}
