/**
 * member-wallet — the in-VPC wallet service (ADR-0006 rev: Cognito-native auth), behind the shared app
 * HTTP API.
 *
 * Serves ONLY the endpoints that touch Aurora money data: `/wallet`, `/wallet/entries` (stubs until
 * the conversion-poller slice) plus the `/healthz` probes. Authentication is fully Cognito-native —
 * the former `/auth/session`, `/auth/register`, and `/me` routes are deleted; anything not served
 * here falls through to Hono's default 404 (the gateway still routes the old paths at this Lambda
 * until the T8 infra teardown). Stays IN-VPC with IAM DB auth (ADR-0003) and reserved concurrency.
 * HTTP routing via Hono (ADR-0011); responses validated with the shared Zod contracts.
 */

import { waitForDb } from "@wanthat/db";
import { jerusalemDate } from "@wanthat/dynamo";
import { Hono } from "hono";
import type { LambdaEvent } from "hono/aws-lambda";
import { handle } from "hono/aws-lambda";
import { subFromClaims } from "./claims";
import { getContext } from "./context";
import { walletRouter } from "./wallet/router";

const SERVICE = "member-wallet";
const app = new Hono<{ Bindings: { event: LambdaEvent } }>();

// Unauthenticated liveness probe — the one positive signal for the pipeline smoke test.
app.get("/healthz", (c) => c.json({ ok: true, service: SERVICE }));

// DB warm-up probe: `select 1` against Aurora so a client can kick off the scale-to-zero resume
// EARLY. The SPA fires this (fire-and-forget) when it knows a wallet read is coming, overlapping
// the ~20s resume with the human instead of serialising it behind the first /wallet call. Public —
// an abuser could keep Aurora awake, but reserved concurrency caps the blast radius.
app.get("/healthz/db", async (c) => {
  const started = Date.now();
  await waitForDb(getContext().db, { attempts: 1 });
  return c.json({ ok: true, service: SERVICE, ms: Date.now() - started });
});

// Presence stamp (dashboard active-member metric, spec 2026-07-12): any authenticated call
// marks the member active today. Fire-and-forget - never delays or fails the request; the
// public healthz probes carry no claims and skip through.
app.use("*", async (c, next) => {
  const sub = subFromClaims(c);
  if (sub) getContext().opsMetrics.touch(sub, jerusalemDate());
  await next();
});

// `/wallet` sits behind the JWT authorizer at the gateway and reads the verified claims.
app.route("/wallet", walletRouter());
// The links module lives on the NON-VPC member-catalog edge (Aurora-free path; the sync retailer-proxy
// invoke is free there — in-VPC it would need a paid lambda interface endpoint, ADR-0004).
// The former merged `GET /activity` is DELETED (refactor PR 2b): the SPA now composes the member
// feed client-side from `GET /wallet/entries` (here) + `GET /recommendations` (member-catalog), so
// member-wallet keeps zero Recommendation-table access. The gateway may still route the old path at
// this Lambda until the infra teardown — it falls through to Hono's 404 like the auth surface.

// Log any uncaught handler error (otherwise Hono returns 500 with no trace) so an in-VPC connection
// failure surfaces instead of a silent Lambda timeout.
app.onError((err, c) => {
  console.error(`${SERVICE} error on ${c.req.method} ${c.req.path}:`, err);
  return c.json({ error: "internal_error", service: SERVICE }, 500);
});

export const handler = handle(app);
export { app };
