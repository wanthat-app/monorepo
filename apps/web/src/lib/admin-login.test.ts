import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureFreshAdminTokens, refreshAdminTokens, verifyAdminOauthState } from "./admin-login";

// A Map-backed sessionStorage stub (the test runs in the node environment, which has no DOM).
function stubSessionStorage(seed: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(seed));
  vi.stubGlobal("sessionStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  return store;
}

afterEach(() => vi.unstubAllGlobals());

describe("verifyAdminOauthState (CSRF)", () => {
  it("accepts a matching state and clears it (single-use)", () => {
    const store = stubSessionStorage({ "wanthat.admin.oauthState": "abc123" });
    expect(verifyAdminOauthState("abc123")).toBe(true);
    expect(store.has("wanthat.admin.oauthState")).toBe(false);
  });

  it("rejects a mismatched state and still clears the stored value", () => {
    const store = stubSessionStorage({ "wanthat.admin.oauthState": "abc123" });
    expect(verifyAdminOauthState("tampered")).toBe(false);
    expect(store.has("wanthat.admin.oauthState")).toBe(false);
  });

  it("rejects when nothing was stored or the callback omits state", () => {
    stubSessionStorage();
    expect(verifyAdminOauthState("abc123")).toBe(false);
    stubSessionStorage({ "wanthat.admin.oauthState": "abc123" });
    expect(verifyAdminOauthState(null)).toBe(false);
  });
});

// An unsigned JWT whose payload carries the given claims (client-side expiry reads only).
function makeJwt(claims: Record<string, unknown>): string {
  const payload = btoa(JSON.stringify(claims)).replace(/\+/g, "-").replace(/\//g, "_");
  return `header.${payload}.signature`;
}

function storedTokens(accessToken: string) {
  return {
    "wanthat.admin.tokens": JSON.stringify({
      accessToken,
      idToken: "id-1",
      refreshToken: "refresh-1",
      expiresIn: 3600,
    }),
  };
}

const nowSec = () => Math.floor(Date.now() / 1000);

describe("ensureFreshAdminTokens", () => {
  it("returns the stored tokens untouched while the access token is still fresh", async () => {
    stubSessionStorage(storedTokens(makeJwt({ exp: nowSec() + 3600 })));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const tokens = await ensureFreshAdminTokens();
    expect(tokens?.refreshToken).toBe("refresh-1");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refreshes an expired access token and persists the new pair (refresh token kept)", async () => {
    const store = stubSessionStorage(storedTokens(makeJwt({ exp: nowSec() - 10 })));
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: "new-access", id_token: "new-id", expires_in: 3600 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const tokens = await ensureFreshAdminTokens();
    expect(tokens?.accessToken).toBe("new-access");
    expect(tokens?.refreshToken).toBe("refresh-1"); // Cognito refresh grant returns no new one
    const call = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(call[0]).toContain("/oauth2/token");
    expect(call[1].body).toContain("grant_type=refresh_token");
    expect(call[1].body).toContain("refresh_token=refresh-1");
    const persisted = JSON.parse(store.get("wanthat.admin.tokens") ?? "{}") as {
      accessToken: string;
    };
    expect(persisted.accessToken).toBe("new-access");
  });

  it("treats an undecodable access token as expired", async () => {
    stubSessionStorage(storedTokens("not-a-jwt"));
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: "new-access", id_token: "new-id", expires_in: 3600 }),
    });
    vi.stubGlobal("fetch", fetchMock);
    expect((await ensureFreshAdminTokens())?.accessToken).toBe("new-access");
  });

  it("clears the stored tokens and returns null when the refresh is rejected", async () => {
    const store = stubSessionStorage(storedTokens(makeJwt({ exp: nowSec() - 10 })));
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 400, json: async () => ({}) }),
    );

    expect(await ensureFreshAdminTokens()).toBeNull();
    expect(store.has("wanthat.admin.tokens")).toBe(false);
  });

  it("returns null without fetching when no tokens are stored", async () => {
    stubSessionStorage();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await ensureFreshAdminTokens()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("refreshAdminTokens", () => {
  it("returns null when the token endpoint is unreachable", async () => {
    stubSessionStorage(storedTokens(makeJwt({ exp: nowSec() - 10 })));
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    expect(await refreshAdminTokens()).toBeNull();
  });
});
