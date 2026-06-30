/**
 * App API — identity + links + wallet Lambdalith (ADR-0002), behind API Gateway HTTP API.
 * In-VPC; reaches Aurora via IAM auth (@wanthat/db) and Cognito over the cognito-idp interface
 * endpoint (ADR-0020). HTTP routing via Hono (ADR-0011); request bodies validated with the shared
 * Zod contracts at the boundary.
 *
 * Live: `/healthz`, the `/auth/*` flow (UC1 Onboard / UC2 Sign-in), and `/me`. Links + wallet land
 * with their slices and return a structured 501 until then.
 */

import { Hono } from "hono";
import type { LambdaEvent } from "hono/aws-lambda";
import { handle } from "hono/aws-lambda";
import { authRouter } from "./auth/router";
import { meRouter } from "./me/router";

const SERVICE = "app-api";
const app = new Hono<{ Bindings: { event: LambdaEvent } }>();

// Unauthenticated liveness probe — the one positive signal for the pipeline smoke test.
app.get("/healthz", (c) => c.json({ ok: true, service: SERVICE }));

// Identity (UC1/UC2). `/auth/*` is unauthenticated by design (it issues the tokens); `/me` sits
// behind the JWT authorizer at the gateway and reads the verified claims.
app.route("/auth", authRouter());
app.route("/me", meRouter());

// Links + wallet not yet implemented — a clean 501 rather than a 404.
app.all("*", (c) => c.json({ error: "not_implemented", service: SERVICE, path: c.req.path }, 501));

export const handler = handle(app);
export { app };
