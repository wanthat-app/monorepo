import { describe, expect, it, vi } from "vitest";

const { ctx } = vi.hoisted(() => ({
  ctx: {
    config: { getAll: vi.fn().mockResolvedValue([]), put: vi.fn() },
    db: {},
  },
}));
vi.mock("./context", () => ({ getContext: () => ctx }));

const { dbFns } = vi.hoisted(() => ({
  dbFns: {
    listCustomers: vi.fn(),
    adminDeleteCustomer: vi.fn(),
  },
}));
vi.mock("@wanthat/db", () => dbFns);

import { app } from "./handler";

const adminEnv = {
  event: { requestContext: { authorizer: { jwt: { claims: { "cognito:groups": ["admin"] } } } } },
};
const memberEnv = {
  event: { requestContext: { authorizer: { jwt: { claims: { "cognito:groups": ["user"] } } } } },
};

describe("admin-api authorisation", () => {
  it("403s a non-admin on /admin routes", async () => {
    const res = await app.request("/admin/config", {}, memberEnv);
    expect(res.status).toBe(403);
  });
});

describe("admin config", () => {
  it("lists every key with its effective value", async () => {
    ctx.config.getAll.mockResolvedValue([]);
    const res = await app.request("/admin/config", {}, adminEnv);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { key: string }[] };
    // Every known key is present, defaulted (auth.smsEnabled among them).
    expect(body.items.some((i) => i.key === "auth.smsEnabled")).toBe(true);
    expect(body.items.length).toBeGreaterThanOrEqual(8);
  });

  it("validates and persists a config write", async () => {
    ctx.config.put.mockResolvedValue({
      key: "landing.countdownSeconds",
      value: 5,
      updatedAt: "2026-06-29T00:00:00.000Z",
    });
    const res = await app.request(
      "/admin/config/landing.countdownSeconds",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: 5 }),
      },
      adminEnv,
    );
    expect(res.status).toBe(200);
    expect(ctx.config.put).toHaveBeenCalledWith("landing.countdownSeconds", 5, expect.any(String));
  });

  it("404s an unknown config key", async () => {
    const res = await app.request(
      "/admin/config/not.a.key",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: 1 }),
      },
      adminEnv,
    );
    expect(res.status).toBe(404);
  });
});

const USER = {
  id: "1e8e4c2a-9a6b-4c7e-8f2d-0a1b2c3d4e5f",
  phone: "+972501234567",
  email: "maya@example.com",
  firstName: "Maya",
  lastName: "Levi",
  locale: "he-IL",
  status: "active",
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
};

describe("admin users", () => {
  it("lists users with paging + search passthrough", async () => {
    dbFns.listCustomers.mockResolvedValue({ users: [USER], total: 41 });
    const res = await app.request("/admin/users?search=%2B9725&page=2&pageSize=20", {}, adminEnv);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { users: unknown[]; total: number; page: number };
    expect(body.total).toBe(41);
    expect(body.page).toBe(2);
    expect(body.users).toHaveLength(1);
    expect(dbFns.listCustomers).toHaveBeenCalledWith(expect.anything(), {
      search: "+9725",
      page: 2,
      pageSize: 20,
    });
  });

  it("rejects an out-of-range pageSize", async () => {
    const res = await app.request("/admin/users?pageSize=500", {}, adminEnv);
    expect(res.status).toBe(400);
  });

  it("refuses to delete a user with wallet history", async () => {
    dbFns.adminDeleteCustomer.mockResolvedValue({ outcome: "has_wallet_history" });
    const res = await app.request(`/admin/users/${USER.id}`, { method: "DELETE" }, adminEnv);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("has_wallet_history");
  });

  it("deletes a clean user and returns the phone for Cognito cleanup", async () => {
    dbFns.adminDeleteCustomer.mockResolvedValue({ outcome: "deleted", phone: USER.phone });
    const res = await app.request(`/admin/users/${USER.id}`, { method: "DELETE" }, adminEnv);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true, id: USER.id, phone: USER.phone });
    expect(dbFns.adminDeleteCustomer).toHaveBeenCalledWith(expect.anything(), USER.id);
  });

  it("404s a delete for an unknown id", async () => {
    dbFns.adminDeleteCustomer.mockResolvedValue({ outcome: "not_found" });
    const res = await app.request(`/admin/users/${USER.id}`, { method: "DELETE" }, adminEnv);
    expect(res.status).toBe(404);
  });

  it("400s a non-uuid id", async () => {
    const res = await app.request("/admin/users/not-a-uuid", { method: "DELETE" }, adminEnv);
    expect(res.status).toBe(400);
  });
});
