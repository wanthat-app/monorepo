/**
 * app-core — the in-VPC "core" (ADR-0021), behind the shared app HTTP API.
 *
 * Serves the endpoints that touch Aurora: `/auth/register`, `/me`, `/me/*` (and later wallet). Stays
 * IN-VPC with IAM DB auth (ADR-0003) and reserved concurrency; DynamoDB over the free gateway
 * endpoint. It verifies the registration ticket minted by `app-auth` but calls NO Cognito
 * control-plane API, so it needs no Cognito egress (the `cognito-idp` interface endpoint is removed).
 * HTTP routing via Hono (ADR-0011); request bodies validated with the shared Zod contracts.
 */

import { waitForDb } from "@wanthat/db";
import { Hono } from "hono";
import type { LambdaEvent } from "hono/aws-lambda";
import { handle } from "hono/aws-lambda";
import { authRouter } from "./auth/register";
import { getContext } from "./context";
import { meRouter } from "./me/router";

const SERVICE = "app-core";
const app = new Hono<{ Bindings: { event: LambdaEvent } }>();

// Unauthenticated liveness probe — the one positive signal for the pipeline smoke test.
app.get("/healthz", (c) => c.json({ ok: true, service: SERVICE }));

// DB warm-up probe: `select 1` against Aurora so a client can kick off the scale-to-zero resume
// EARLY. The SPA fires this (fire-and-forget) when the landing/auth page loads, overlapping the
// ~20s resume with the human reading the page / doing Face ID instead of serialising it after the
// biometric (measured 20–22s /auth/session tails; Lambda init was only ~0.4s). Public like
// /auth/session — an abuser could keep Aurora awake, but no more than by calling /auth/session.
app.get("/healthz/db", async (c) => {
  const started = Date.now();
  await waitForDb(getContext().db, { attempts: 1 });
  return c.json({ ok: true, service: SERVICE, ms: Date.now() - started });
});

// `/auth/session` + `/auth/register` are unauthenticated by design (a valid ticket is the credential);
// `/me` sits behind the JWT authorizer at the gateway and reads the verified claims.
app.route("/auth", authRouter());
app.route("/me", meRouter());

// Log any uncaught handler error (otherwise Hono returns 500 with no trace) so an in-VPC connection
// failure surfaces instead of a silent Lambda timeout.
app.onError((err, c) => {
  console.error(`${SERVICE} error on ${c.req.method} ${c.req.path}:`, err);
  return c.json({ error: "internal_error", service: SERVICE }, 500);
});

// Links + wallet not yet implemented — a clean 501 rather than a 404.
app.all("*", (c) => c.json({ error: "not_implemented", service: SERVICE, path: c.req.path }, 501));

export const handler = handle(app);
export { app };
