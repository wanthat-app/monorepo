import { describe, expect, it, vi } from "vitest";

const { ctx } = vi.hoisted(() => ({
  ctx: {
    config: { get: vi.fn() },
    fx: { get: vi.fn().mockResolvedValue(undefined) },
    db: {},
  } as {
    config: { get: ReturnType<typeof vi.fn> };
    fx: { get: ReturnType<typeof vi.fn> };
    db: object;
  },
}));
vi.mock("./context", () => ({ getContext: () => ctx }));

const { dbFns } = vi.hoisted(() => ({
  dbFns: {
    listAuditLog: vi.fn(),
    listRewardRows: vi.fn().mockResolvedValue([]),
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

describe("admin-ledger-view authorisation", () => {
  it("403s a non-admin on /admin routes", async () => {
    const res = await app.request("/admin/activity", {}, memberEnv);
    expect(res.status).toBe(403);
  });

  it("501s routes that moved to admin-console (config, stats counters, users)", async () => {
    for (const path of ["/admin/config", "/admin/stats/users", "/admin/users", "/healthz"]) {
      const res = await app.request(path, {}, adminEnv);
      expect(res.status).toBe(501);
    }
  });
});

describe("admin activity (audit rows ONLY - the OTP sink is an admin-console route)", () => {
  const ENTRY = {
    id: "7",
    createdAt: new Date("2026-07-08T11:32:00.000Z"),
    payload: {
      type: "user_registered",
      phone: "+972501234567",
      firstName: "Maya",
      lastName: "Levi",
      email: "maya@example.com",
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

  it("total counts audit rows exactly (no sink merge - page boundaries are exact)", async () => {
    dbFns.listAuditLog.mockResolvedValue({ entries: [ENTRY], total: 21 });
    const res = await app.request("/admin/activity?page=2", {}, adminEnv);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { total: number; page: number };
    expect(body.total).toBe(21);
    expect(body.page).toBe(2);
  });
});

describe("admin money stats", () => {
  const reward = (over: Record<string, unknown>) => ({
    kind: "referrer_cashback",
    amountMinor: 500n,
    currency: "USD",
    orderId: "order-1",
    status: "confirmed",
    // Relative to the real clock: the route windows on `new Date()`, so a fixed
    // date would age out of lastNDates(30) and start failing a month from now.
    createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
    ...over,
  });

  it("serves ledger-derived totals with the ILS estimate incl. the in-window numerator", async () => {
    dbFns.listRewardRows.mockResolvedValue([
      reward({}),
      reward({ kind: "consumer_reward", amountMinor: 200n, status: "pending" }),
    ]);
    ctx.fx.get.mockResolvedValue({ base: "USD", quote: "ILS", rate: "3.38" });
    ctx.config.get.mockResolvedValue(0); // 0 bps commission -> pure rate conversion
    const res = await app.request("/admin/stats/money", {}, adminEnv);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.totals).toEqual([
      {
        currency: "USD",
        confirmed: { amountMinor: "500", currency: "USD" },
        pending: { amountMinor: "200", currency: "USD" },
      },
    ]);
    // 500 minor USD * 3.38 = 1690 minor ILS (0 bps commission). The confirmed reward sits
    // inside the 30-day window, so the client-side per-active numerator matches.
    expect(body.ilsEstimate).toMatchObject({
      confirmed: { amountMinor: "1690", currency: "ILS" },
      confirmedInWindow: { amountMinor: "1690", currency: "ILS" },
    });
    expect(body.conversions30d).toBe(1);
    expect((body.dailyConversions as unknown[]).length).toBe(30);
    // The active-member figure left this route (refactor PR-5): the SPA divides the in-window
    // numerator by /admin/stats/users active30d itself.
    expect(body).not.toHaveProperty("cashbackPerActive30d");
  });

  it("empty ledger: hard-zero ILS estimate even with no rate cached", async () => {
    dbFns.listRewardRows.mockResolvedValue([]);
    ctx.fx.get.mockResolvedValue(undefined);
    ctx.config.get.mockResolvedValue(0);
    const res = await app.request("/admin/stats/money", {}, adminEnv);
    const body = (await res.json()) as Record<string, never>;
    expect(body.ilsEstimate).toMatchObject({
      confirmed: { amountMinor: "0", currency: "ILS" },
      confirmedInWindow: { amountMinor: "0", currency: "ILS" },
    });
  });

  it("USD held but no rate: ilsEstimate is null", async () => {
    dbFns.listRewardRows.mockResolvedValue([reward({})]);
    ctx.fx.get.mockResolvedValue(undefined);
    ctx.config.get.mockResolvedValue(0);
    const res = await app.request("/admin/stats/money", {}, adminEnv);
    const body = (await res.json()) as Record<string, never>;
    expect(body.ilsEstimate).toBeNull();
  });

  it("403s a non-admin", async () => {
    expect((await app.request("/admin/stats/money", {}, memberEnv)).status).toBe(403);
  });
});
