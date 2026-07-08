import { describe, expect, it } from "vitest";
import { app } from "./handler";

/**
 * Until the T8 infra teardown, API Gateway still routes the deleted auth surface
 * (`/auth/session`, `/auth/register`, `/me`) at this Lambda. Those requests must fall through to
 * Hono's default 404 — never a crash and never a stale handler.
 */
describe("app-core routing after the auth-surface removal", () => {
  it("serves the liveness probe", async () => {
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, service: "app-core" });
  });

  it.each([
    ["POST", "/auth/session"],
    ["POST", "/auth/register"],
    ["GET", "/me"],
    ["PATCH", "/me"],
    ["POST", "/me/attribution/claim"],
  ])("404s the deleted route %s %s", async (method, path) => {
    const res = await app.request(path, { method, body: method === "GET" ? undefined : "{}" });
    expect(res.status).toBe(404);
  });

  it("404s unknown paths via the Hono default (no 501 catch-all anymore)", async () => {
    expect((await app.request("/nope")).status).toBe(404);
  });
});
