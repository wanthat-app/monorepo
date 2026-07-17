import { beforeEach, describe, expect, it, vi } from "vitest";

const { ctx } = vi.hoisted(() => ({
  ctx: {
    retailerSecret: { put: vi.fn(), status: vi.fn() },
    cognitoUsers: {
      remove: vi.fn(),
      list: vi.fn(),
      getBySub: vi.fn(),
      disable: vi.fn(),
      enable: vi.fn(),
      globalSignOut: vi.fn(),
    },
    recommendations: { deleteByOwner: vi.fn(), count: vi.fn().mockResolvedValue(0) },
    customerCounter: {
      get: vi.fn().mockResolvedValue({ total: 0, disabled: 0 }),
      decrementTotal: vi.fn(),
      markDisabled: vi.fn(),
      markEnabled: vi.fn(),
    },
    opsMetrics: {
      // Default: every daily metric reads as a zero-filled map; window counts read 0.
      getDailyCounts: vi.fn(
        async (_metric: string, dates: string[]) => new Map(dates.map((d) => [d, 0])),
      ),
      countActiveSince: vi.fn().mockResolvedValue(0),
    },
    config: { getAll: vi.fn().mockResolvedValue([]), put: vi.fn(), get: vi.fn() },
    products: { count: vi.fn().mockResolvedValue(0) },
    otpSink: { scanAll: vi.fn().mockResolvedValue([]) },
    audit: { write: vi.fn().mockResolvedValue(undefined) },
    fxRates: { refresh: vi.fn() },
  },
}));
vi.mock("./context", () => ({ getContext: () => ctx }));

import { CONFIG_DEFAULTS } from "@wanthat/contracts";
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

const SUB = "3f1c9a2e-0000-4000-8000-000000000000";

function post(path: string, body: unknown, env: object = adminEnv) {
  return app.request(
    path,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    env,
  );
}

beforeEach(() => {
  ctx.audit.write.mockReset().mockResolvedValue(undefined);
});

describe("admin-console authorisation", () => {
  it("403s a non-admin on /admin routes", async () => {
    expect((await app.request("/admin/config", {}, memberEnv)).status).toBe(403);
  });

  it("501s routes that live on admin-ledger-view (activity, money, wallet)", async () => {
    for (const path of ["/admin/activity", "/admin/stats/money", `/admin/users/${SUB}/wallet`]) {
      expect((await app.request(path, {}, adminEnv)).status).toBe(501);
    }
  });

  it("answers the public healthz without auth", async () => {
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, service: "admin-console" });
  });
});

// ---------------------------------------------------------------------------
// Retailer credentials (absorbed from admin-credentials — feature retained)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Runtime config (sole writer; audit-or-fail via audit-writer)
// ---------------------------------------------------------------------------

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
    // nothing stored), and the acting admin from the ID-token claims (email).
    expect(ctx.audit.write).toHaveBeenCalledWith({
      event: "config_changed",
      key: "landing.countdownSeconds",
      value: 5,
      previous: CONFIG_DEFAULTS["landing.countdownSeconds"],
      actor: "dennis@wanthat.co.il",
    });
  });

  it("audits the stored value as `previous` when the key was set before", async () => {
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
    expect(ctx.audit.write).toHaveBeenCalledWith(
      expect.objectContaining({ previous: 3, value: 5 }),
    );
  });

  it("fails the save loudly when the audit invoke fails (the trail must not break silently)", async () => {
    ctx.config.getAll.mockResolvedValue([]);
    ctx.config.put.mockResolvedValue({
      key: "landing.countdownSeconds",
      value: 5,
      updatedAt: "2026-06-29T00:00:00.000Z",
    });
    ctx.audit.write.mockRejectedValueOnce(new Error("audit-writer down"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
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
    error.mockRestore();
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

// ---------------------------------------------------------------------------
// Users (Cognito) + moderation with audit-or-fail
// ---------------------------------------------------------------------------

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

  it("removes the account, erases its recommendations, and chains a user_deleted audit", async () => {
    ctx.cognitoUsers.remove.mockResolvedValue({ existed: true, sub: SUB, wasDisabled: false });
    ctx.recommendations.deleteByOwner.mockResolvedValue(3);
    const res = await post("/admin/users/cognito-delete", { phone: "+972501234567" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, existed: true, recommendationsDeleted: 3 });
    expect(ctx.cognitoUsers.remove).toHaveBeenCalledWith("+972501234567");
    expect(ctx.recommendations.deleteByOwner).toHaveBeenCalledWith(SUB);
    expect(ctx.audit.write).toHaveBeenCalledWith({
      event: "user_deleted",
      sub: SUB,
      actor: "dennis@wanthat.co.il",
    });
  });

  it("fails loudly when the user_deleted audit invoke fails (delete already happened)", async () => {
    ctx.cognitoUsers.remove.mockResolvedValue({ existed: true, sub: SUB, wasDisabled: false });
    ctx.recommendations.deleteByOwner.mockResolvedValue(0);
    ctx.audit.write.mockRejectedValueOnce(new Error("audit-writer down"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await post("/admin/users/cognito-delete", { phone: "+972501234567" });
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toBe("audit_failed");
    error.mockRestore();
  });

  it("decrements the customer counter, passing the account's suspension state through", async () => {
    ctx.cognitoUsers.remove.mockResolvedValue({ existed: true, sub: SUB, wasDisabled: true });
    ctx.recommendations.deleteByOwner.mockResolvedValue(0);
    const res = await post("/admin/users/cognito-delete", { phone: "+972501234567" });
    expect(res.status).toBe(200);
    expect(ctx.customerCounter.decrementTotal).toHaveBeenCalledTimes(1);
    expect(ctx.customerCounter.decrementTotal).toHaveBeenCalledWith(true);
  });

  it("treats an already-deleted account as success — no cleanup, no counter, no audit", async () => {
    ctx.cognitoUsers.remove.mockResolvedValue({ existed: false, wasDisabled: false });
    const res = await post("/admin/users/cognito-delete", { phone: "+972501234567" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, existed: false });
    expect(ctx.recommendations.deleteByOwner).not.toHaveBeenCalled();
    // The idempotent retry of a delete must not decrement or re-audit.
    expect(ctx.customerCounter.decrementTotal).not.toHaveBeenCalled();
    expect(ctx.audit.write).not.toHaveBeenCalled();
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

  it("serves one member by sub (GET /admin/users/:sub) and 404s a malformed sub", async () => {
    ctx.cognitoUsers.getBySub.mockResolvedValue(ROW);
    const res = await app.request(`/admin/users/${SUB}`, {}, adminEnv);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user: ROW });
    expect((await app.request("/admin/users/not-a-uuid", {}, adminEnv)).status).toBe(404);
  });

  it("410s the removed Aurora-side delete (cognito-delete stands alone)", async () => {
    const res = await app.request(`/admin/users/${SUB}`, { method: "DELETE" }, adminEnv);
    expect(res.status).toBe(410);
    expect(((await res.json()) as { error: string }).error).toBe("gone");
  });
});

describe("ban tooling (disable / enable / global-signout) with audit-or-fail", () => {
  // Per-route lifecycle resolutions: disable/enable answer the AdminGetUser-derived prior state
  // (the counter must count each state CHANGE once) plus the sub for the audit event;
  // global-signout answers found + sub.
  const routes = [
    {
      path: "/admin/users/disable",
      event: "user_disabled",
      fn: () => ctx.cognitoUsers.disable,
      ok: { found: true, wasEnabled: true, sub: SUB },
      notFound: { found: false, wasEnabled: false },
    },
    {
      path: "/admin/users/enable",
      event: "user_enabled",
      fn: () => ctx.cognitoUsers.enable,
      ok: { found: true, wasDisabled: true, sub: SUB },
      notFound: { found: false, wasDisabled: false },
    },
    {
      path: "/admin/users/global-signout",
      event: "user_signed_out",
      fn: () => ctx.cognitoUsers.globalSignOut,
      ok: { found: true, sub: SUB },
      notFound: { found: false },
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

  it("answers ok, calls the lifecycle action, and chains the matching audit event", async () => {
    for (const r of routes) {
      ctx.audit.write.mockClear();
      r.fn().mockResolvedValue(r.ok);
      const res = await post(r.path, { phone: "+972501234567" });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(r.fn()).toHaveBeenCalledWith("+972501234567");
      // The moderation audit (closes the old "NOT IMPLEMENTED" gap): member sub + acting admin.
      expect(ctx.audit.write).toHaveBeenCalledWith({
        event: r.event,
        sub: SUB,
        actor: "dennis@wanthat.co.il",
      });
    }
  });

  it("fails loudly (500 audit_failed) when the audit invoke fails, on every route", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const r of routes) {
      r.fn().mockResolvedValue(r.ok);
      ctx.audit.write.mockRejectedValueOnce(new Error("audit-writer down"));
      const res = await post(r.path, { phone: "+972501234567" });
      expect(res.status).toBe(500);
      expect(((await res.json()) as { error: string }).error).toBe("audit_failed");
    }
    error.mockRestore();
  });

  it("404s an unknown phone without auditing", async () => {
    for (const r of routes) {
      r.fn().mockResolvedValue(r.notFound);
      const res = await post(r.path, { phone: "+972501234567" });
      expect(res.status).toBe(404);
      expect(((await res.json()) as { error: string }).error).toBe("not_found");
    }
    expect(ctx.audit.write).not.toHaveBeenCalled();
  });

  it("400s a malformed phone without touching Cognito", async () => {
    for (const r of routes) {
      const res = await post(r.path, { phone: "0501234567" });
      expect(res.status).toBe(400);
      expect(r.fn()).not.toHaveBeenCalled();
    }
  });

  it("disable marks the counter ONLY when the user was actually enabled (idempotent repeat)", async () => {
    ctx.cognitoUsers.disable.mockResolvedValue({ found: true, wasEnabled: true, sub: SUB });
    expect((await post("/admin/users/disable", { phone: "+972501234567" })).status).toBe(200);
    expect(ctx.customerCounter.markDisabled).toHaveBeenCalledTimes(1);

    // Repeat: Cognito reports the user was already disabled - no second count.
    ctx.cognitoUsers.disable.mockResolvedValue({ found: true, wasEnabled: false, sub: SUB });
    expect((await post("/admin/users/disable", { phone: "+972501234567" })).status).toBe(200);
    expect(ctx.customerCounter.markDisabled).toHaveBeenCalledTimes(1);
  });

  it("enable lifts the counter symmetrically, once per actual state change", async () => {
    ctx.cognitoUsers.enable.mockResolvedValue({ found: true, wasDisabled: true, sub: SUB });
    expect((await post("/admin/users/enable", { phone: "+972501234567" })).status).toBe(200);
    expect(ctx.customerCounter.markEnabled).toHaveBeenCalledTimes(1);

    ctx.cognitoUsers.enable.mockResolvedValue({ found: true, wasDisabled: false, sub: SUB });
    expect((await post("/admin/users/enable", { phone: "+972501234567" })).status).toBe(200);
    expect(ctx.customerCounter.markEnabled).toHaveBeenCalledTimes(1);
  });

  it("global-signout never touches the counter (no population change)", async () => {
    ctx.cognitoUsers.globalSignOut.mockResolvedValue({ found: true, sub: SUB });
    expect((await post("/admin/users/global-signout", { phone: "+972501234567" })).status).toBe(
      200,
    );
    expect(ctx.customerCounter.markDisabled).not.toHaveBeenCalled();
    expect(ctx.customerCounter.markEnabled).not.toHaveBeenCalled();
  });

  it("still answers ok when the counter write fails (drift logged, action already done)", async () => {
    ctx.cognitoUsers.disable.mockResolvedValue({ found: true, wasEnabled: true, sub: SUB });
    ctx.customerCounter.markDisabled.mockRejectedValue(new Error("dynamo down"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await post("/admin/users/disable", { phone: "+972501234567" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(error).toHaveBeenCalledWith(expect.stringContaining("customer_counter_drift"));
    error.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Stats (DynamoDB counters)
// ---------------------------------------------------------------------------

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

  it("overview reports the EXACT usersCount", async () => {
    ctx.customerCounter.get.mockResolvedValue({ total: 41, disabled: 3 });
    const res = await app.request("/admin/stats/overview", {}, adminEnv);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ usersCount: 41 });
  });

  it("403s a non-admin", async () => {
    expect((await app.request("/admin/stats/users", {}, memberEnv)).status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// OTP sink + on-demand FX refresh
// ---------------------------------------------------------------------------

describe("GET /admin/otp-sink", () => {
  it("lists the live parked codes, dropping TTL-expired items", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    ctx.otpSink.scanAll.mockResolvedValue([
      {
        phone: "+972520000001",
        code: "48213976",
        channel: "whatsapp",
        triggerSource: "t",
        createdAt: "2026-07-08T11:40:00.000Z",
        ttl: nowSec + 300,
      },
      {
        phone: "+972520000002",
        code: "11112222",
        channel: "sms",
        triggerSource: "t",
        createdAt: "2026-07-08T11:00:00.000Z",
        ttl: nowSec - 10, // lagging TTL deletion — filtered here
      },
    ]);
    const res = await app.request("/admin/otp-sink", {}, adminEnv);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { type: string; code?: string }[] };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      type: "otp_sent",
      phone: "+972520000001",
      code: "48213976",
      channel: "whatsapp",
    });
  });

  it("403s a non-admin", async () => {
    expect((await app.request("/admin/otp-sink", {}, memberEnv)).status).toBe(403);
  });
});

describe("POST /admin/fx-rates/refresh", () => {
  const RATE = {
    base: "USD",
    quote: "ILS",
    rate: "3.38",
    asOf: "2026-07-16T00:00:00.000Z",
  };

  it("sync-invokes fx-rates and answers with the freshly cached rates", async () => {
    ctx.fxRates.refresh.mockResolvedValue({
      status: "ok",
      provider: "ecb",
      updated: [RATE],
      failed: [],
      rates: [RATE],
    });
    const res = await app.request("/admin/fx-rates/refresh", { method: "POST" }, adminEnv);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ rates: [RATE] });
    expect(ctx.fxRates.refresh).toHaveBeenCalledTimes(1);
  });

  it("502s when the invoke fails", async () => {
    ctx.fxRates.refresh.mockRejectedValue(new Error("lambda down"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await app.request("/admin/fx-rates/refresh", { method: "POST" }, adminEnv);
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toBe("fx_refresh_failed");
    error.mockRestore();
  });

  it("403s a non-admin", async () => {
    const res = await app.request("/admin/fx-rates/refresh", { method: "POST" }, memberEnv);
    expect(res.status).toBe(403);
  });
});
