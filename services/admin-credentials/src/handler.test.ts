import { beforeEach, describe, expect, it, vi } from "vitest";

const { ctx } = vi.hoisted(() => ({
  ctx: {
    retailerSecret: { put: vi.fn(), status: vi.fn() },
    cognitoUsers: {
      remove: vi.fn(),
      list: vi.fn(),
      disable: vi.fn(),
      enable: vi.fn(),
      globalSignOut: vi.fn(),
    },
    recommendations: { deleteByOwner: vi.fn() },
    customerCounter: { decrementTotal: vi.fn(), markDisabled: vi.fn(), markEnabled: vi.fn() },
  },
}));
vi.mock("./context", () => ({ getContext: () => ctx }));

import { app } from "./handler";

const adminEnv = {
  event: {
    requestContext: {
      authorizer: {
        jwt: { claims: { "cognito:groups": ["admin"], email: "dennis@wanthat.co.il" } },
      },
    },
  },
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

  it("PUT stores trimmed credentials and answers with the secret's status only — no echo", async () => {
    ctx.retailerSecret.put.mockResolvedValue(undefined);
    ctx.retailerSecret.status.mockResolvedValue({
      configured: true,
      lastUpdatedAt: "2026-07-07T10:00:00.000Z",
    });
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
    expect(body).toEqual({ configured: true, lastUpdatedAt: "2026-07-07T10:00:00.000Z" });
  });

  it("PUT answers a generic 500 without the submitted values when Secrets Manager fails", async () => {
    ctx.retailerSecret.put.mockRejectedValue(new Error("sm down"));
    const res = await app.request(
      PATH,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ appKey: "512345", appSecret: "topsecret" }),
      },
      adminEnv,
    );
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain("512345");
    expect(text).not.toContain("topsecret");
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

const SUB = "3f1c9a2e-0000-4000-8000-000000000000";

function post(path: string, body: unknown, env: object = adminEnv) {
  return app.request(
    path,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    env,
  );
}

describe("cognito user delete", () => {
  beforeEach(() => {
    ctx.cognitoUsers.remove.mockReset();
    ctx.recommendations.deleteByOwner.mockReset();
    ctx.customerCounter.decrementTotal.mockReset().mockResolvedValue(true);
  });

  it("403s a non-admin", async () => {
    const res = await post("/admin/users/cognito-delete", {}, memberEnv);
    expect(res.status).toBe(403);
  });

  it("removes the account and erases its recommendations under the resolved sub", async () => {
    ctx.cognitoUsers.remove.mockResolvedValue({ existed: true, sub: SUB, wasDisabled: false });
    ctx.recommendations.deleteByOwner.mockResolvedValue(3);
    const res = await post("/admin/users/cognito-delete", { phone: "+972501234567" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, existed: true, recommendationsDeleted: 3 });
    expect(ctx.cognitoUsers.remove).toHaveBeenCalledWith("+972501234567");
    expect(ctx.recommendations.deleteByOwner).toHaveBeenCalledWith(SUB);
  });

  it("decrements the customer counter, passing the account's suspension state through", async () => {
    ctx.cognitoUsers.remove.mockResolvedValue({ existed: true, sub: SUB, wasDisabled: true });
    ctx.recommendations.deleteByOwner.mockResolvedValue(0);
    const res = await post("/admin/users/cognito-delete", { phone: "+972501234567" });
    expect(res.status).toBe(200);
    expect(ctx.customerCounter.decrementTotal).toHaveBeenCalledTimes(1);
    expect(ctx.customerCounter.decrementTotal).toHaveBeenCalledWith(true);
  });

  it("treats an already-deleted account as success and skips the rec cleanup (no sub)", async () => {
    ctx.cognitoUsers.remove.mockResolvedValue({ existed: false, wasDisabled: false });
    const res = await post("/admin/users/cognito-delete", { phone: "+972501234567" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, existed: false });
    expect(ctx.recommendations.deleteByOwner).not.toHaveBeenCalled();
    // The idempotent retry of a delete must not decrement again.
    expect(ctx.customerCounter.decrementTotal).not.toHaveBeenCalled();
  });

  it("still answers ok when the counter write fails (drift logged, route unaffected)", async () => {
    ctx.cognitoUsers.remove.mockResolvedValue({ existed: true, sub: SUB, wasDisabled: false });
    ctx.recommendations.deleteByOwner.mockResolvedValue(0);
    ctx.customerCounter.decrementTotal.mockRejectedValue(new Error("dynamo down"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await post("/admin/users/cognito-delete", { phone: "+972501234567" });
    expect(res.status).toBe(200);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("customer_counter_drift"));
    error.mockRestore();
  });

  it("400s a malformed phone", async () => {
    const res = await post("/admin/users/cognito-delete", { phone: "0501234567" });
    expect(res.status).toBe(400);
  });
});

describe("users list (Cognito ListUsers)", () => {
  beforeEach(() => ctx.cognitoUsers.list.mockReset());

  const ROW = {
    id: SUB,
    phone: "+972501234567",
    email: null,
    firstName: "Maya",
    lastName: "Levi",
    locale: "he-IL",
    status: "active",
    userStatus: "CONFIRMED",
    createdAt: "2026-07-09T10:00:00.000Z",
    updatedAt: "2026-07-09T10:00:00.000Z",
  };

  it("403s a non-admin", async () => {
    expect((await app.request("/admin/users", {}, memberEnv)).status).toBe(403);
  });

  it("pages with the Cognito token and passes the phone prefix through", async () => {
    ctx.cognitoUsers.list.mockResolvedValue({
      users: [ROW],
      total: 41,
      approximate: true,
      nextToken: "tok2",
    });
    const res = await app.request(
      "/admin/users?search=%2B9725&pageSize=20&nextToken=tok1",
      {},
      adminEnv,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      users: [ROW],
      total: 41,
      approximate: true,
      nextToken: "tok2",
    });
    expect(ctx.cognitoUsers.list).toHaveBeenCalledWith({
      phonePrefix: "+9725",
      limit: 20,
      nextToken: "tok1",
    });
  });

  it("rejects a pageSize above Cognito's Limit cap (60)", async () => {
    const res = await app.request("/admin/users?pageSize=61", {}, adminEnv);
    expect(res.status).toBe(400);
    expect(ctx.cognitoUsers.list).not.toHaveBeenCalled();
  });
});

describe("ban tooling (disable / enable / global-signout)", () => {
  // Per-route lifecycle resolutions: disable/enable answer the AdminGetUser-derived prior state
  // (the counter must count each state CHANGE once); global-signout keeps the plain boolean.
  const routes = [
    {
      path: "/admin/users/disable",
      fn: () => ctx.cognitoUsers.disable,
      ok: { found: true, wasEnabled: true },
      notFound: { found: false, wasEnabled: false },
    },
    {
      path: "/admin/users/enable",
      fn: () => ctx.cognitoUsers.enable,
      ok: { found: true, wasDisabled: true },
      notFound: { found: false, wasDisabled: false },
    },
    {
      path: "/admin/users/global-signout",
      fn: () => ctx.cognitoUsers.globalSignOut,
      ok: true,
      notFound: false,
    },
  ];

  beforeEach(() => {
    ctx.cognitoUsers.disable.mockReset();
    ctx.cognitoUsers.enable.mockReset();
    ctx.cognitoUsers.globalSignOut.mockReset();
    ctx.customerCounter.markDisabled.mockReset().mockResolvedValue(true);
    ctx.customerCounter.markEnabled.mockReset().mockResolvedValue(true);
  });

  it("403s a non-admin on every route", async () => {
    for (const r of routes) {
      expect((await post(r.path, { phone: "+972501234567" }, memberEnv)).status).toBe(403);
    }
  });

  it("answers a bare ok and calls the matching lifecycle action", async () => {
    for (const r of routes) {
      r.fn().mockResolvedValue(r.ok);
      const res = await post(r.path, { phone: "+972501234567" });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(r.fn()).toHaveBeenCalledWith("+972501234567");
    }
  });

  it("404s an unknown phone", async () => {
    for (const r of routes) {
      r.fn().mockResolvedValue(r.notFound);
      const res = await post(r.path, { phone: "+972501234567" });
      expect(res.status).toBe(404);
      expect(((await res.json()) as { error: string }).error).toBe("not_found");
    }
  });

  it("400s a malformed phone without touching Cognito", async () => {
    for (const r of routes) {
      const res = await post(r.path, { phone: "0501234567" });
      expect(res.status).toBe(400);
      expect(r.fn()).not.toHaveBeenCalled();
    }
  });

  it("disable marks the counter ONLY when the user was actually enabled (idempotent repeat)", async () => {
    ctx.cognitoUsers.disable.mockResolvedValue({ found: true, wasEnabled: true });
    expect((await post("/admin/users/disable", { phone: "+972501234567" })).status).toBe(200);
    expect(ctx.customerCounter.markDisabled).toHaveBeenCalledTimes(1);

    // Repeat: Cognito reports the user was already disabled - no second count.
    ctx.cognitoUsers.disable.mockResolvedValue({ found: true, wasEnabled: false });
    expect((await post("/admin/users/disable", { phone: "+972501234567" })).status).toBe(200);
    expect(ctx.customerCounter.markDisabled).toHaveBeenCalledTimes(1);
  });

  it("enable lifts the counter symmetrically, once per actual state change", async () => {
    ctx.cognitoUsers.enable.mockResolvedValue({ found: true, wasDisabled: true });
    expect((await post("/admin/users/enable", { phone: "+972501234567" })).status).toBe(200);
    expect(ctx.customerCounter.markEnabled).toHaveBeenCalledTimes(1);

    ctx.cognitoUsers.enable.mockResolvedValue({ found: true, wasDisabled: false });
    expect((await post("/admin/users/enable", { phone: "+972501234567" })).status).toBe(200);
    expect(ctx.customerCounter.markEnabled).toHaveBeenCalledTimes(1);
  });

  it("global-signout never touches the counter (no population change)", async () => {
    ctx.cognitoUsers.globalSignOut.mockResolvedValue(true);
    expect((await post("/admin/users/global-signout", { phone: "+972501234567" })).status).toBe(
      200,
    );
    expect(ctx.customerCounter.markDisabled).not.toHaveBeenCalled();
    expect(ctx.customerCounter.markEnabled).not.toHaveBeenCalled();
  });

  it("still answers ok when the counter write fails (drift logged, action already done)", async () => {
    ctx.cognitoUsers.disable.mockResolvedValue({ found: true, wasEnabled: true });
    ctx.customerCounter.markDisabled.mockRejectedValue(new Error("dynamo down"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await post("/admin/users/disable", { phone: "+972501234567" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(error).toHaveBeenCalledWith(expect.stringContaining("customer_counter_drift"));
    error.mockRestore();
  });
});
