/**
 * App API — identity + links + wallet Lambdalith (ADR-0002), behind API Gateway HTTP API.
 * In-VPC; reaches Aurora via IAM auth (@wanthat/db) and the Retailer Proxy via Lambda invoke
 * (ADR-0004). HTTP routing via Hono (ADR-0011); request bodies validated with the shared Zod
 * contracts at the boundary.
 *
 * Walking skeleton — `/healthz` returns 200 as a liveness signal; every other route returns a
 * structured 501. Wire the identity / links / wallet modules onto this app as they land.
 */
import { Hono } from "hono";
import { handle } from "hono/aws-lambda";

const SERVICE = "app-api";
const app = new Hono();

// TODO: Powertools logger/tracer/metrics middleware (ADR-0011).

// Unauthenticated liveness probe — the one positive signal for the pipeline smoke test.
app.get("/healthz", (c) => c.json({ ok: true, service: SERVICE }));

// TODO: /auth/* (identity), /me + /links + /products/* (links), /wallet* (wallet).
// Until those land, every other route is a clean 501 rather than a 404.
app.all("*", (c) => c.json({ error: "not_implemented", service: SERVICE, path: c.req.path }, 501));

export const handler = handle(app);
export { app };
