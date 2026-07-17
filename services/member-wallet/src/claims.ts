import type { Context } from "hono";
import type { LambdaEvent } from "hono/aws-lambda";

export type Bindings = { event: LambdaEvent };

/** Pull the Cognito `sub` from the API Gateway JWT authorizer claims (HTTP API v2 shape). */
export function subFromClaims(c: Context<{ Bindings: Bindings }>): string | undefined {
  // biome-ignore lint/suspicious/noExplicitAny: the authorizer claim shape varies by event type
  const claims = (c.env?.event as any)?.requestContext?.authorizer?.jwt?.claims;
  const sub = claims?.sub;
  return typeof sub === "string" ? sub : undefined;
}
