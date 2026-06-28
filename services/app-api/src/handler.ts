/**
 * App API — identity + links + wallet Lambdalith (ADR-0002), behind API Gateway HTTP API.
 * In-VPC; reaches Aurora via IAM auth (@wanthat/db) and the Retailer Proxy via Lambda invoke
 * (ADR-0004). HTTP routing via Hono (ADR-0011); request bodies validated with the shared Zod
 * contracts at the boundary.
 *
 * Skeleton — wire the identity / links / wallet modules onto this app.
 */
import { Hono } from "hono";
import { handle } from "hono/aws-lambda";

const app = new Hono();

// TODO: Powertools logger/tracer/metrics middleware (ADR-0011).
app.get("/me", (c) => c.json({ ok: true })); // identity module — placeholder
// TODO: /auth/* (identity), /links + /products/* (links), /wallet* (wallet)

app.notFound((c) => c.json({ error: "not_found" }, 404));

export const handler = handle(app);
export { app };
