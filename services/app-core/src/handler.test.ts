import { beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted fake so the vi.mock factory can close over it (vitest hoists vi.mock above imports).
// Only the piece the presence middleware touches; routers are tested against their own fakes.
const { fake } = vi.hoisted(() => ({
  fake: { opsMetrics: { touch: vi.fn() } },
}));
vi.mock("./context", () => ({ getContext: () => fake }));

import { app } from "./handler";

/**
 * Until the T8 infra teardown, API Gateway still routes the deleted auth surface
 * (`/auth/session`, `/auth/register`, `/me`) at this Lambda — and, since refactor PR 2b, the
 * deleted merged `GET /activity` (the SPA now merges wallet entries + recommendations
 * client-side). Those requests must fall through to Hono's default 404 — never a crash and
 * never a stale handler.
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
    ["GET", "/activity"],
  ])("404s the deleted route %s %s", async (method, path) => {
    const res = await app.request(path, { method, body: method === "GET" ? undefined : "{}" });
    expect(res.status).toBe(404);
  });

  it("404s unknown paths via the Hono default (no 501 catch-all anymore)", async () => {
    expect((await app.request("/nope")).status).toBe(404);
  });
});

describe("presence middleware (dashboard active-member metric)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("stamps presence for an authenticated call", async () => {
    await app.request(
      "/wallet",
      {},
      { event: { requestContext: { authorizer: { jwt: { claims: { sub: "sub-1" } } } } } },
    );
    expect(fake.opsMetrics.touch).toHaveBeenCalledWith(
      "sub-1",
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    );
  });

  it("does not stamp /healthz (no claims)", async () => {
    await app.request("/healthz", {});
    expect(fake.opsMetrics.touch).not.toHaveBeenCalled();
  });
});
