import { beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted fake so the vi.mock factory can close over it (vitest hoists vi.mock above imports).
// Only the pieces the middleware touches; the routers get their own fakes in router.test.ts.
const { fake } = vi.hoisted(() => ({
  fake: {
    opsMetrics: { touch: vi.fn() },
    config: { getMany: vi.fn(async () => new Map()) },
  },
}));
vi.mock("./context", () => ({ getContext: () => fake }));

import { app } from "./handler";

const claimsEnv = (sub: string) => ({
  event: { requestContext: { authorizer: { jwt: { claims: { sub } } } } },
});

describe("presence middleware (dashboard active-member metric)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("stamps presence for an authenticated call", async () => {
    await app.request("/recommendations", {}, claimsEnv("sub-1"));
    expect(fake.opsMetrics.touch).toHaveBeenCalledWith(
      "sub-1",
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    );
  });

  it("does not stamp public routes (no claims)", async () => {
    const res = await app.request("/healthz", {});
    expect(res.status).toBe(200);
    expect(fake.opsMetrics.touch).not.toHaveBeenCalled();
  });
});
