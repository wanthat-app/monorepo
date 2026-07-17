import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./api";

const login = vi.hoisted(() => ({
  refreshAdminTokens: vi.fn(),
  clearAdminTokens: vi.fn(),
  beginAdminLogin: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./admin-login", () => login);

import { adminApi, normalizePhonePrefix } from "./admin-api";

afterEach(() => vi.unstubAllGlobals());
beforeEach(() => {
  login.refreshAdminTokens.mockReset();
  login.clearAdminTokens.mockReset();
  login.beginAdminLogin.mockClear();
});

describe("adminRequest 401 handling", () => {
  it("refreshes once on a 401 and retries with the new id token", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ items: [] }) });
    vi.stubGlobal("fetch", fetchMock);
    login.refreshAdminTokens.mockResolvedValue({ idToken: "fresh-tok" });

    const res = await adminApi.listConfig("stale-tok");
    expect(res.items).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const retry = fetchMock.mock.calls[1] as [string, { headers: Record<string, string> }];
    expect(retry[1].headers.authorization).toBe("Bearer fresh-tok");
    expect(login.beginAdminLogin).not.toHaveBeenCalled();
  });

  it("clears the session and restarts the login when the refresh fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) }),
    );
    login.refreshAdminTokens.mockResolvedValue(null);

    await expect(adminApi.listConfig("stale-tok")).rejects.toMatchObject({ status: 401 });
    expect(login.clearAdminTokens).toHaveBeenCalled();
    expect(login.beginAdminLogin).toHaveBeenCalled();
  });

  it("clears the session and restarts the login when the retry is still 401", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) }),
    );
    login.refreshAdminTokens.mockResolvedValue({ idToken: "fresh-tok" });

    await expect(adminApi.listConfig("stale-tok")).rejects.toBeInstanceOf(ApiError);
    expect(login.clearAdminTokens).toHaveBeenCalled();
    expect(login.beginAdminLogin).toHaveBeenCalled();
  });

  it("does not touch the session on non-401 errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({ error: "boom" }) }),
    );

    await expect(adminApi.listConfig("tok")).rejects.toMatchObject({ status: 500, code: "boom" });
    expect(login.refreshAdminTokens).not.toHaveBeenCalled();
    expect(login.clearAdminTokens).not.toHaveBeenCalled();
    expect(login.beginAdminLogin).not.toHaveBeenCalled();
  });
});

describe("users surface (Cognito-backed, ADR-0006)", () => {
  const ok = (body: unknown = {}) => ({ ok: true, status: 200, json: async () => body });

  it("listUsers sends token pagination (search/pageSize/nextToken), never a page number", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok({ users: [], total: 0, approximate: true }));
    vi.stubGlobal("fetch", fetchMock);

    await adminApi.listUsers("tok", { search: "+9725", pageSize: 20, nextToken: "opaque==" });
    const [calledUrl] = fetchMock.mock.calls[0] as [string];
    const url = new URL(calledUrl, "https://x.invalid");
    expect(url.searchParams.get("search")).toBe("+9725");
    expect(url.searchParams.get("pageSize")).toBe("20");
    expect(url.searchParams.get("nextToken")).toBe("opaque==");
    expect(url.searchParams.has("page")).toBe(false);
  });

  it.each([
    ["disableUser", "/admin/users/disable"],
    ["enableUser", "/admin/users/enable"],
    ["globalSignOutUser", "/admin/users/global-signout"],
  ] as const)("%s POSTs the phone to %s", async (fn, path) => {
    const fetchMock = vi.fn().mockResolvedValue(ok({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await adminApi[fn]("tok", "+972501234567");
    const [url, init] = fetchMock.mock.calls[0] as [string, { method: string; body: string }];
    expect(url.endsWith(path)).toBe(true);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ phone: "+972501234567" });
  });
});

describe("activity page sources (PR-5: audit feed + OTP sink are separate routes)", () => {
  const ok = (body: unknown = {}) => ({ ok: true, status: 200, json: async () => body });

  it("listOtpSink GETs /admin/otp-sink", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok({ items: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await adminApi.listOtpSink("tok");
    expect(res.items).toEqual([]);
    const [url, init] = fetchMock.mock.calls[0] as [string, { method: string }];
    expect(url.endsWith("/admin/otp-sink")).toBe(true);
    expect(init.method).toBe("GET");
  });

  it("refreshFxRates POSTs /admin/fx-rates/refresh with no body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok({ rates: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await adminApi.refreshFxRates("tok");
    expect(res.rates).toEqual([]);
    const [url, init] = fetchMock.mock.calls[0] as [string, { method: string; body?: string }];
    expect(url.endsWith("/admin/fx-rates/refresh")).toBe(true);
    expect(init.method).toBe("POST");
    expect(init.body).toBeUndefined();
  });
});

describe("normalizePhonePrefix", () => {
  it.each([
    ["05", "+9725"],
    ["050-123", "+97250123"],
    ["0501234567", "+972501234567"],
    ["+97250", "+97250"],
    ["97250", "+97250"],
    ["0097250", "+97250"],
    ["50", "+97250"],
    ["  05 0-12(3) ", "+97250123"],
    ["", ""],
  ])("%s -> %s", (input, expected) => {
    expect(normalizePhonePrefix(input)).toBe(expected);
  });
});
