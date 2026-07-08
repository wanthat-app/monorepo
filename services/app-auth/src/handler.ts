/**
 * app-auth — the non-VPC "app edge" (ADR-0020), behind the shared app HTTP API.
 *
 * Serves the endpoints that touch only Cognito + DynamoDB: the `/auth/*` OTP flow, passkey
 * enrolment, and the links module (`/products/resolve` + `/recommendations*` — Aurora-free by
 * design, ADR-0004, and placed HERE so its synchronous retailer-proxy invoke is a free
 * non-VPC→Lambda call instead of needing a paid lambda interface endpoint in the VPC). Runs
 * OUTSIDE the VPC so it reaches the Managed-Login customer pool over Cognito's public endpoint
 * (PrivateLink is disabled for Managed-Login pools, ADR-0020). Holds no Aurora access; the
 * Aurora seam (`/auth/register`, `/me`) is served by `app-core`. HTTP routing via Hono
 * (ADR-0011); request bodies validated with the shared Zod contracts at the boundary.
 */

import { Hono } from "hono";
import type { LambdaEvent } from "hono/aws-lambda";
import { handle } from "hono/aws-lambda";
import { authRouter } from "./auth/router";
import { productsRouter, recommendationsRouter } from "./links/router";

const SERVICE = "app-auth";
const app = new Hono<{ Bindings: { event: LambdaEvent } }>();

// Unauthenticated liveness probe — the one positive signal for the pipeline smoke test.
app.get("/healthz", (c) => c.json({ ok: true, service: SERVICE }));

// Identity (UC1/UC2). `/auth/*` is unauthenticated by design (it issues the tokens); passkey
// enrolment reads the caller's Bearer access token directly (see the router).
app.route("/auth", authRouter());

// The links module (ADR-0002), behind the JWT authorizer at the gateway.
app.route("/products", productsRouter());
app.route("/recommendations", recommendationsRouter());

// Anything else on this function is not its concern — a clean 501 rather than a 404.
app.all("*", (c) => c.json({ error: "not_implemented", service: SERVICE, path: c.req.path }, 501));

export const handler = handle(app);
export { app };
