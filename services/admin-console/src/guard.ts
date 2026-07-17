import type { Context, Next } from "hono";
import type { LambdaEvent } from "hono/aws-lambda";

export type Bindings = { event: LambdaEvent };

/**
 * Admin authorisation (ADR-0002, defence in depth). The HTTP API JWT authorizer already validates
 * the token; this re-checks membership of the Cognito `admin` group in-handler, since the JWT
 * authorizer cannot gate on group membership (that would need a Lambda authorizer — deferred).
 */
export async function requireAdmin(c: Context<{ Bindings: Bindings }>, next: Next) {
  const claims = claimsFrom(c);
  const groups = claims["cognito:groups"];
  const isAdmin = Array.isArray(groups)
    ? groups.includes("admin")
    : typeof groups === "string" && groups.split(/[\s,[\]]+/).includes("admin");
  if (!isAdmin) return c.json({ error: "forbidden" }, 403);
  await next();
}

function claimsFrom(c: Context<{ Bindings: Bindings }>): Record<string, unknown> {
  // biome-ignore lint/suspicious/noExplicitAny: authorizer claim shape varies by event type
  return (c.env?.event as any)?.requestContext?.authorizer?.jwt?.claims ?? {};
}

/**
 * The audit-friendly actor: the admin's email (ID-token claim — the admin SPA deliberately
 * sends the ID token so audit actors are readable emails), falling back to username/sub.
 */
export function actorFrom(c: Context<{ Bindings: Bindings }>): string {
  const claims = claimsFrom(c);
  return (
    (typeof claims.email === "string" && claims.email) ||
    (typeof claims.username === "string" && claims.username) ||
    String(claims.sub ?? "unknown")
  );
}
