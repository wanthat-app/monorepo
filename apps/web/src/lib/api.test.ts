import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, authApi } from "./api";

afterEach(() => vi.unstubAllGlobals());

describe("api client", () => {
  it("POSTs /auth/start and returns the parsed body", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ challengeId: "c1", resendAfterSec: 30, expiresInSec: 180 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await authApi.start("+972541234567", "sms");
    expect(res.challengeId).toBe("c1");
    const call = fetchMock.mock.calls[0] as [string, { method: string }];
    expect(call[0]).toContain("/auth/start");
    expect(call[1].method).toBe("POST");
  });

  it("attaches the Bearer token for authorised calls", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ challengeId: "c1", options: {} }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await authApi.passkeyRegisterOptions("tok-123");
    const call = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(call[1].headers.authorization).toBe("Bearer tok-123");
  });

  it("GETs the userless passkey login challenge with no body or token", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ challengeId: "c1", options: {} }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await authApi.passkeyLoginChallenge();
    expect(res.challengeId).toBe("c1");
    const call = fetchMock.mock.calls[0] as [string, { method?: string; body?: unknown }];
    expect(call[0]).toContain("/auth/passkey/login/challenge");
    expect(call[1].method ?? "GET").toBe("GET");
    expect(call[1].body).toBeUndefined();
  });

  it("GETs the member's passkey list with the Bearer token", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ passkeys: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await authApi.passkeyList("tok-123");
    expect(res.passkeys).toEqual([]);
    const call = fetchMock.mock.calls[0] as [
      string,
      { method?: string; headers: Record<string, string> },
    ];
    expect(call[0]).toContain("/auth/passkey/list");
    expect(call[1].method ?? "GET").toBe("GET");
    expect(call[1].headers.authorization).toBe("Bearer tok-123");
  });

  it("throws ApiError carrying the server error code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        json: async () => ({ error: "rate_limited" }),
      }),
    );
    await expect(authApi.start("+972", "sms")).rejects.toBeInstanceOf(ApiError);
    await expect(authApi.start("+972", "sms")).rejects.toMatchObject({
      status: 429,
      code: "rate_limited",
    });
  });
});
