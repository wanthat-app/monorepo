import { describe, expect, it, vi } from "vitest";

const { ctx } = vi.hoisted(() => ({
  ctx: {
    config: { getAll: vi.fn().mockResolvedValue([]), put: vi.fn() },
    products: { count: vi.fn().mockResolvedValue(0) },
    recommendations: { count: vi.fn().mockResolvedValue(0) },
    db: {},
  } as {
    config: { getAll: ReturnType<typeof vi.fn>; put: ReturnType<typeof vi.fn> };
    products: { count: ReturnType<typeof vi.fn> };
    recommendations: { count: ReturnType<typeof vi.fn> };
    db: object;
    devOtpSink?: { scanAll: ReturnType<typeof vi.fn> };
  },
}));
vi.mock("./context", () => ({ getContext: () => ctx }));

const { dbFns } = vi.hoisted(() => ({
  dbFns: {
    adminDeleteCustomer: vi.fn(),
    listAuditLog: vi.fn(),
  },
}));
vi.mock("@wanthat/db", () => dbFns);

import { app } from "./handler";

const adminEnv = {
  event: {
    requestContext: {
      authorizer: {
        jwt: { claims: { "cognito:groups": ["admin"], username: "dennis@wanthat.co.il" } },
      },
    },
  },
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

describe("admin catalog stats", () => {
  it("answers the exact totals from the transactional counters", async () => {
    ctx.products.count.mockResolvedValue(41);
    ctx.recommendations.count.mockResolvedValue(97);
    const res = await app.request("/admin/stats/catalog", {}, adminEnv);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ products: 41, recommendations: 97 });
    expect(ctx.products.count).toHaveBeenCalledWith("aliexpress");
  });

  it("403s a non-admin", async () => {
    expect((await app.request("/admin/stats/catalog", {}, memberEnv)).status).toBe(403);
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

describe("admin users (Aurora-side delete only - listing/ban tooling live on admin-credentials)", () => {
  it("501s the list route here - GET /admin/users is served by admin-credentials (ADR-0006)", async () => {
    const res = await app.request("/admin/users", {}, adminEnv);
    expect(res.status).toBe(501);
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
    expect(dbFns.adminDeleteCustomer).toHaveBeenCalledWith(
      expect.anything(),
      USER.id,
      "dennis@wanthat.co.il",
    );
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

describe("admin activity", () => {
  const ENTRY = {
    id: "7",
    createdAt: new Date("2026-07-08T11:32:00.000Z"),
    payload: {
      type: "user_registered",
      customerId: USER.id,
      phone: USER.phone,
      firstName: USER.firstName,
      lastName: USER.lastName,
      email: USER.email,
    },
  };

  it("lists audit entries as feed items", async () => {
    dbFns.listAuditLog.mockResolvedValue({ entries: [ENTRY], total: 1 });
    const res = await app.request("/admin/activity", {}, adminEnv);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { id: string; type: string }[]; total: number };
    expect(body.total).toBe(1);
    expect(body.items[0]).toMatchObject({ id: "audit_7", type: "user_registered" });
    expect(dbFns.listAuditLog).toHaveBeenCalledWith(expect.anything(), { page: 1, pageSize: 20 });
  });

  it("rejects an out-of-range pageSize", async () => {
    const res = await app.request("/admin/activity?pageSize=500", {}, adminEnv);
    expect(res.status).toBe(400);
  });

  it("merges live dev-sink codes into page 1 when the sink is configured", async () => {
    dbFns.listAuditLog.mockResolvedValue({ entries: [ENTRY], total: 1 });
    ctx.devOtpSink = {
      scanAll: vi.fn().mockResolvedValue([
        {
          phone: "+972520000001",
          code: "48213976",
          channel: "whatsapp",
          triggerSource: "t",
          createdAt: "2026-07-08T11:40:00.000Z",
          ttl: Math.floor(Date.now() / 1000) + 300,
        },
      ]),
    };
    const res = await app.request("/admin/activity", {}, adminEnv);
    const body = (await res.json()) as { items: { type: string; code?: string }[]; total: number };
    expect(body.total).toBe(2);
    expect(body.items[0]).toMatchObject({ type: "otp_sent", code: "48213976" });
    delete ctx.devOtpSink;
  });

  it("does not merge sink codes on page 2", async () => {
    dbFns.listAuditLog.mockResolvedValue({ entries: [], total: 21 });
    ctx.devOtpSink = { scanAll: vi.fn() };
    const res = await app.request("/admin/activity?page=2", {}, adminEnv);
    expect(res.status).toBe(200);
    expect(ctx.devOtpSink.scanAll).not.toHaveBeenCalled();
    delete ctx.devOtpSink;
  });
});
