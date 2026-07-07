import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./api";

const login = vi.hoisted(() => ({
  refreshAdminTokens: vi.fn(),
  clearAdminTokens: vi.fn(),
  beginAdminLogin: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./admin-login", () => login);

import { adminApi } from "./admin-api";

afterEach(() => vi.unstubAllGlobals());
beforeEach(() => {
  login.refreshAdminTokens.mockReset();
  login.clearAdminTokens.mockReset();
  login.beginAdminLogin.mockClear();
});

describe("adminRequest 401 handling", () => {
  it("refreshes once on a 401 and retries with the new access token", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ items: [] }) });
    vi.stubGlobal("fetch", fetchMock);
    login.refreshAdminTokens.mockResolvedValue({ accessToken: "fresh-tok" });

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
    login.refreshAdminTokens.mockResolvedValue({ accessToken: "fresh-tok" });

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
