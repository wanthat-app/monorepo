/**
 * member-catalog — the non-VPC "links edge" (ADR-0006 rev: Cognito-native auth), behind the shared app
 * HTTP API.
 *
 * Serves the links module (`/products/resolve` + `/recommendations*`) plus the tiny PUBLIC
 * `/config` projection (allow-listed runtime-config keys) — Aurora-free by design
 * (ADR-0004), and placed on a non-VPC function so its synchronous retailer-proxy invoke is a free
 * non-VPC-to-Lambda call instead of needing a paid lambda interface endpoint in the VPC. The former
 * `/auth/*` surface is gone: the browser talks to Cognito directly (ADR-0006), so this function
 * holds no Cognito access and no auth state. HTTP routing via Hono (ADR-0011); request bodies
 * validated with the shared Zod contracts at the boundary.
 */

import { jerusalemDate } from "@wanthat/dynamo";
import { Hono } from "hono";
import type { LambdaEvent } from "hono/aws-lambda";
import { handle } from "hono/aws-lambda";
import { subFromClaims } from "./claims";
import { publicConfigRouter } from "./config/router";
import { getContext } from "./context";
import { productsRouter, recommendationsRouter } from "./links/router";

const SERVICE = "member-catalog";
const app = new Hono<{ Bindings: { event: LambdaEvent } }>();

// Unauthenticated liveness probe — the one positive signal for the pipeline smoke test.
app.get("/healthz", (c) => c.json({ ok: true, service: SERVICE }));

// PUBLIC config projection (allow-listed keys only) — no JWT authorizer at the gateway, like
// /healthz. The SPA reads it pre-sign-in (e.g. the register screen's OTP channel options).
app.route("/config", publicConfigRouter());

// Presence stamp (dashboard active-member metric, spec 2026-07-12): any authenticated call
// marks the member active today. Fire-and-forget - never delays or fails the request; routes
// without JWT claims (healthz, public config) skip through.
app.use("*", async (c, next) => {
  const sub = subFromClaims(c);
  if (sub) getContext().opsMetrics.touch(sub, jerusalemDate());
  await next();
});

// The links module (ADR-0002), behind the JWT authorizer at the gateway.
app.route("/products", productsRouter());
app.route("/recommendations", recommendationsRouter());

// Log any uncaught handler error (otherwise Hono returns 500 with no trace) so a failed proxy
// invoke or DynamoDB hiccup on the links routes surfaces as a clean, logged internal_error.
app.onError((err, c) => {
  console.error(`${SERVICE} error on ${c.req.method} ${c.req.path}:`, err);
  return c.json({ error: "internal_error", service: SERVICE }, 500);
});

// Anything else on this function is not its concern — a clean 501 rather than a 404.
app.all("*", (c) => c.json({ error: "not_implemented", service: SERVICE, path: c.req.path }, 501));

export const handler = handle(app);
export { app };
