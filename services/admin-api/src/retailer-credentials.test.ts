import { beforeEach, describe, expect, it, vi } from "vitest";

const { ctx } = vi.hoisted(() => ({
  ctx: {
    config: { getAll: vi.fn().mockResolvedValue([]), put: vi.fn() },
    db: {},
    retailerSecret: { put: vi.fn(), status: vi.fn() },
  },
}));
vi.mock("./context", () => ({ getContext: () => ctx }));

import { app } from "./handler";

const adminEnv = {
  event: { requestContext: { authorizer: { jwt: { claims: { "cognito:groups": ["admin"] } } } } },
};
const memberEnv = {
  event: { requestContext: { authorizer: { jwt: { claims: { "cognito:groups": ["user"] } } } } },
};

const PATH = "/admin/retailer/aliexpress/credentials";

describe("retailer credentials routes", () => {
  beforeEach(() => {
    ctx.retailerSecret.put.mockReset();
    ctx.retailerSecret.status.mockReset();
  });

  it("403s a non-admin", async () => {
    expect((await app.request(PATH, {}, memberEnv)).status).toBe(403);
    expect((await app.request(PATH, { method: "PUT", body: "{}" }, memberEnv)).status).toBe(403);
  });

  it("GET returns the write-only status, never a value", async () => {
    ctx.retailerSecret.status.mockResolvedValue({
      configured: true,
      lastUpdatedAt: "2026-07-07T10:00:00.000Z",
    });
    const res = await app.request(PATH, {}, adminEnv);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      configured: true,
      lastUpdatedAt: "2026-07-07T10:00:00.000Z",
    });
  });

  it("PUT stores trimmed credentials and answers with status only — no echo", async () => {
    ctx.retailerSecret.put.mockResolvedValue(undefined);
    const res = await app.request(
      PATH,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ appKey: " 512345 ", appSecret: " topsecret " }),
      },
      adminEnv,
    );
    expect(res.status).toBe(200);
    expect(ctx.retailerSecret.put).toHaveBeenCalledWith({
      appKey: "512345",
      appSecret: "topsecret",
    });
    const text = await res.text();
    expect(text).not.toContain("512345");
    expect(text).not.toContain("topsecret");
    const body = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["configured", "lastUpdatedAt"]);
    expect(body.configured).toBe(true);
  });

  it("PUT rejects a missing/blank field naming the field, not its content", async () => {
    const res = await app.request(
      PATH,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ appKey: "onlykey-no-secret" }),
      },
      adminEnv,
    );
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toContain("appSecret");
    expect(text).not.toContain("onlykey-no-secret");
    expect(ctx.retailerSecret.put).not.toHaveBeenCalled();
  });

  it("PUT rejects a non-JSON body", async () => {
    const res = await app.request(
      PATH,
      { method: "PUT", headers: { "content-type": "application/json" }, body: "not json" },
      adminEnv,
    );
    expect(res.status).toBe(400);
    expect(ctx.retailerSecret.put).not.toHaveBeenCalled();
  });
});
