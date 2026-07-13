import { describe, expect, it, vi } from "vitest";

const { ctx } = vi.hoisted(() => ({
  ctx: {
    config: { getAll: vi.fn().mockResolvedValue([]), put: vi.fn(), get: vi.fn() },
    products: { count: vi.fn().mockResolvedValue(0) },
    recommendations: { count: vi.fn().mockResolvedValue(0) },
    customerCounter: { get: vi.fn().mockResolvedValue({ total: 0, disabled: 0 }) },
    opsMetrics: {
      // Default: every daily metric reads as a zero-filled map; window counts read 0.
      getDailyCounts: vi.fn(
        async (_metric: string, dates: string[]) => new Map(dates.map((d) => [d, 0])),
      ),
      countActiveSince: vi.fn().mockResolvedValue(0),
    },
    fx: { get: vi.fn().mockResolvedValue(undefined) },
    db: {},
  } as {
    config: {
      getAll: ReturnType<typeof vi.fn>;
      put: ReturnType<typeof vi.fn>;
      get: ReturnType<typeof vi.fn>;
    };
    products: { count: ReturnType<typeof vi.fn> };
    recommendations: { count: ReturnType<typeof vi.fn> };
    customerCounter: { get: ReturnType<typeof vi.fn> };
    opsMetrics: {
      getDailyCounts: ReturnType<typeof vi.fn>;
      countActiveSince: ReturnType<typeof vi.fn>;
    };
    fx: { get: ReturnType<typeof vi.fn> };
    db: object;
    otpSink?: { scanAll: ReturnType<typeof vi.fn> };
  },
}));
vi.mock("./context", () => ({ getContext: () => ctx }));

const { dbFns } = vi.hoisted(() => ({
  dbFns: {
    listAuditLog: vi.fn(),
    appendConfigChangeAudit: vi.fn().mockResolvedValue(undefined),
    listRewardRows: vi.fn().mockResolvedValue([]),
  },
}));
vi.mock("@wanthat/db", () => dbFns);

import { CONFIG_DEFAULTS } from "@wanthat/contracts";
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
    expect(await res.json()).toEqual(
      expect.objectContaining({ products: 41, recommendations: 97 }),
    );
    expect(ctx.products.count).toHaveBeenCalledWith("aliexpress");
  });

  it("includes the dense 30-day created trend", async () => {
    ctx.products.count.mockResolvedValue(1);
    ctx.recommendations.count.mockResolvedValue(2);
    const res = await app.request("/admin/stats/catalog", {}, adminEnv);
    const body = (await res.json()) as { dailyCreated: { date: string; count: number }[] };
    expect(body.dailyCreated.length).toBe(30);
    expect(ctx.opsMetrics.getDailyCounts).toHaveBeenCalledWith("recsDaily", expect.any(Array));
  });

  it("403s a non-admin", async () => {
    expect((await app.request("/admin/stats/catalog", {}, memberEnv)).status).toBe(403);
  });
});

describe("admin users stats", () => {
  it("aggregates counters, windows and dense 30-day series", async () => {
    ctx.customerCounter.get.mockResolvedValue({ total: 12, disabled: 2 });
    // signups: 2 today (last date), 3 on the oldest date; active: 1 every day.
    ctx.opsMetrics.getDailyCounts.mockImplementation(
      async (metric: string, dates: string[]) =>
        new Map(
          dates.map((d, i) => [
            d,
            metric === "signupsDaily" ? (i === dates.length - 1 ? 2 : i === 0 ? 3 : 0) : 1,
          ]),
        ),
    );
    ctx.opsMetrics.countActiveSince.mockResolvedValueOnce(4).mockResolvedValueOnce(9);
    const res = await app.request("/admin/stats/users", {}, adminEnv);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.usersCount).toBe(12);
    expect(body.suspendedUsersCount).toBe(2);
    expect(body.newToday).toBe(2);
    expect(body.new7d).toBe(2); // the oldest-day 3 falls outside the 7-day window
    expect(body.new30d).toBe(5);
    expect(body.active7d).toBe(4);
    expect(body.active30d).toBe(9);
    expect((body.dailySignups as unknown[]).length).toBe(30);
    expect((body.dailyActive as unknown[]).length).toBe(30);
  });

  it("403s a non-admin", async () => {
    expect((await app.request("/admin/stats/users", {}, memberEnv)).status).toBe(403);
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

  it("validates and persists a config write, and chains a config_changed audit event", async () => {
    ctx.config.getAll.mockResolvedValue([]);
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
    // The audit rides every applied write: new value, prior effective value (the default —
    // nothing stored), and the acting admin from the token claims.
    expect(dbFns.appendConfigChangeAudit).toHaveBeenCalledWith(ctx.db, {
      key: "landing.countdownSeconds",
      value: 5,
      previous: CONFIG_DEFAULTS["landing.countdownSeconds"],
      actor: "dennis@wanthat.co.il",
    });
  });

  it("audits the stored value as `previous` when the key was set before", async () => {
    dbFns.appendConfigChangeAudit.mockClear();
    ctx.config.getAll.mockResolvedValue([
      { key: "landing.countdownSeconds", value: 3, updatedAt: "2026-06-01T00:00:00.000Z" },
    ]);
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
    expect(dbFns.appendConfigChangeAudit).toHaveBeenCalledWith(
      ctx.db,
      expect.objectContaining({ previous: 3, value: 5 }),
    );
  });

  it("fails the save loudly when the audit append fails (the trail must not break silently)", async () => {
    ctx.config.getAll.mockResolvedValue([]);
    ctx.config.put.mockResolvedValue({
      key: "landing.countdownSeconds",
      value: 5,
      updatedAt: "2026-06-29T00:00:00.000Z",
    });
    dbFns.appendConfigChangeAudit.mockRejectedValueOnce(new Error("db down"));
    const res = await app.request(
      "/admin/config/landing.countdownSeconds",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: 5 }),
      },
      adminEnv,
    );
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toBe("audit_failed");
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

describe("admin users (whole surface lives on admin-credentials since T7)", () => {
  it("501s the list route here - GET /admin/users is served by admin-credentials (ADR-0006)", async () => {
    const res = await app.request("/admin/users", {}, adminEnv);
    expect(res.status).toBe(501);
  });

  it("410s the removed Aurora-side delete (T7: no customer table; cognito-delete stands alone)", async () => {
    const res = await app.request(`/admin/users/${USER.id}`, { method: "DELETE" }, adminEnv);
    expect(res.status).toBe(410);
    expect(((await res.json()) as { error: string }).error).toBe("gone");
  });

  it("403s the delete route for a non-admin (the guard still runs before the 410)", async () => {
    const res = await app.request(`/admin/users/${USER.id}`, { method: "DELETE" }, memberEnv);
    expect(res.status).toBe(403);
  });
});

describe("admin user stats (exact customer counter - the customerCounter item in OpsCounters)", () => {
  it("serves the exact counter figures on /admin/stats/users", async () => {
    ctx.customerCounter.get.mockResolvedValue({ total: 41, disabled: 3 });
    const res = await app.request("/admin/stats/users", {}, adminEnv);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(
      expect.objectContaining({ usersCount: 41, suspendedUsersCount: 3 }),
    );
  });

  it("overview reports the EXACT usersCount alongside the other placeholders", async () => {
    ctx.customerCounter.get.mockResolvedValue({ total: 41, disabled: 3 });
    const res = await app.request("/admin/stats/overview", {}, adminEnv);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      usersCount: 41,
      pendingApprovals: null,
      totalCashbackMinor: null,
      conversions30d: null,
    });
  });

  it("an empty pool (missing counter item) reads as zero, not an error", async () => {
    ctx.customerCounter.get.mockResolvedValue({ total: 0, disabled: 0 });
    const res = await app.request("/admin/stats/users", {}, adminEnv);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(
      expect.objectContaining({ usersCount: 0, suspendedUsersCount: 0 }),
    );
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
    ctx.otpSink = {
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
    delete ctx.otpSink;
  });

  it("does not merge sink codes on page 2", async () => {
    dbFns.listAuditLog.mockResolvedValue({ entries: [], total: 21 });
    ctx.otpSink = { scanAll: vi.fn() };
    const res = await app.request("/admin/activity?page=2", {}, adminEnv);
    expect(res.status).toBe(200);
    expect(ctx.otpSink.scanAll).not.toHaveBeenCalled();
    delete ctx.otpSink;
  });
});

describe("admin money stats", () => {
  const reward = (over: Record<string, unknown>) => ({
    kind: "referrer_cashback",
    amountMinor: 500n,
    currency: "USD",
    orderId: "order-1",
    status: "confirmed",
    createdAt: new Date("2026-07-12T10:00:00Z"),
    ...over,
  });

  it("serves ledger-derived totals with the ILS estimate and per-active figure", async () => {
    dbFns.listRewardRows.mockResolvedValue([
      reward({}),
      reward({ kind: "consumer_reward", amountMinor: 200n, status: "pending" }),
    ]);
    ctx.fx.get.mockResolvedValue({ base: "USD", quote: "ILS", rate: "3.38" });
    ctx.config.get.mockResolvedValue(0); // 0 bps commission -> pure rate conversion
    ctx.opsMetrics.countActiveSince.mockResolvedValue(2);
    const res = await app.request("/admin/stats/money", {}, adminEnv);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, never>;
    expect(body.totals).toEqual([
      {
        currency: "USD",
        confirmed: { amountMinor: "500", currency: "USD" },
        pending: { amountMinor: "200", currency: "USD" },
      },
    ]);
    // 500 minor USD * 3.38 = 1690 minor ILS (0 bps commission).
    expect(body.ilsEstimate).toMatchObject({
      confirmed: { amountMinor: "1690", currency: "ILS" },
    });
    expect(body.conversions30d).toBe(1);
    expect((body.dailyConversions as unknown[]).length).toBe(30);
    // 1690 / 2 active members = 845.
    expect(body.cashbackPerActive30d).toEqual({ amountMinor: "845", currency: "ILS" });
  });

  it("empty ledger: hard-zero ILS estimate even with no rate cached", async () => {
    dbFns.listRewardRows.mockResolvedValue([]);
    ctx.fx.get.mockResolvedValue(undefined);
    ctx.config.get.mockResolvedValue(0);
    ctx.opsMetrics.countActiveSince.mockResolvedValue(0);
    const res = await app.request("/admin/stats/money", {}, adminEnv);
    const body = (await res.json()) as Record<string, never>;
    expect(body.ilsEstimate).toMatchObject({
      confirmed: { amountMinor: "0", currency: "ILS" },
    });
    expect(body.cashbackPerActive30d).toBeNull(); // 0 actives -> null
  });

  it("USD held but no rate: ilsEstimate and per-active are null", async () => {
    dbFns.listRewardRows.mockResolvedValue([reward({})]);
    ctx.fx.get.mockResolvedValue(undefined);
    ctx.config.get.mockResolvedValue(0);
    ctx.opsMetrics.countActiveSince.mockResolvedValue(5);
    const res = await app.request("/admin/stats/money", {}, adminEnv);
    const body = (await res.json()) as Record<string, never>;
    expect(body.ilsEstimate).toBeNull();
    expect(body.cashbackPerActive30d).toBeNull();
  });

  it("403s a non-admin", async () => {
    expect((await app.request("/admin/stats/money", {}, memberEnv)).status).toBe(403);
  });
});
