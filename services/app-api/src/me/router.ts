import {
  AttributionClaimBody,
  GetMeResponse,
  UpdateProfileBody,
  UpdateProfileResponse,
} from "@wanthat/contracts";
import { findByCognitoSub, updateProfile } from "@wanthat/db";
import type { Context } from "hono";
import { Hono } from "hono";
import type { LambdaEvent } from "hono/aws-lambda";
import { getContext } from "../context";

type Bindings = { event: LambdaEvent };

/** Pull the Cognito `sub` from the API Gateway JWT authorizer claims (HTTP API v2 shape). */
function subFromClaims(c: Context<{ Bindings: Bindings }>): string | undefined {
  // biome-ignore lint/suspicious/noExplicitAny: the authorizer claim shape varies by event type
  const claims = (c.env?.event as any)?.requestContext?.authorizer?.jwt?.claims;
  const sub = claims?.sub;
  return typeof sub === "string" ? sub : undefined;
}

async function parseBody<T>(
  c: Context<{ Bindings: Bindings }>,
  schema: { safeParse: (v: unknown) => { success: boolean; data?: T } },
): Promise<T | null> {
  try {
    const r = schema.safeParse(await c.req.json());
    return r.success ? (r.data as T) : null;
  } catch {
    return null;
  }
}

export function meRouter(): Hono<{ Bindings: Bindings }> {
  const me = new Hono<{ Bindings: Bindings }>();

  // GET /me — the authenticated member's profile.
  me.get("/", async (c) => {
    const sub = subFromClaims(c);
    if (!sub) return c.json({ error: "unauthorized" }, 401);
    const ctx = getContext();
    const profile = await findByCognitoSub(ctx.db, sub);
    if (!profile) return c.json({ error: "not_found" }, 404);
    return c.json(GetMeResponse.parse({ profile }));
  });

  // PATCH /me — update mutable profile fields (UC6); email also mirrored to Cognito.
  me.patch("/", async (c) => {
    const sub = subFromClaims(c);
    if (!sub) return c.json({ error: "unauthorized" }, 401);
    const body = await parseBody(c, UpdateProfileBody);
    if (!body) return c.json({ error: "invalid_request" }, 400);
    const ctx = getContext();

    const profile = await updateProfile(ctx.db, sub, body);
    if (!profile) return c.json({ error: "not_found" }, 404);
    return c.json(UpdateProfileResponse.parse({ profile }));
  });

  // POST /me/attribution/claim — best-effort guest→member retro-attribution (ADR-0008).
  me.post("/attribution/claim", async (c) => {
    const sub = subFromClaims(c);
    if (!sub) return c.json({ error: "unauthorized" }, 401);
    const body = await parseBody(c, AttributionClaimBody);
    if (!body) return c.json({ error: "invalid_request" }, 400);
    const ctx = getContext();

    const profile = await findByCognitoSub(ctx.db, sub);
    if (!profile) return c.json({ error: "not_found" }, 404);

    const claimedAt = new Date().toISOString();
    let claimed = 0;
    for (const guestId of body.guestIds) {
      if (await ctx.guests.claim(guestId, profile.id, claimedAt)) claimed += 1;
    }
    return c.json({ claimed });
  });

  return me;
}
