import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearSession,
  completeSignIn,
  getSnapshot,
  hasStoredSession,
  rehydrate,
  rememberedPhone,
  resetForTests,
} from "./store";

// The store's only network touch is the refresh (cognito.ts) — pin its config.
vi.mock("../lib/config", () => ({
  getConfig: () => ({ cognitoRegion: "il-central-1", userPoolClientId: "client-123" }),
}));

function fakeJwt(payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `eyJhbGciOiJub25lIn0.${body}.sig`;
}

const ID_TOKEN = fakeJwt({
  sub: "s-1",
  phone_number: "+972541234567",
  given_name: "Dana",
  family_name: "Levi",
  locale: "he-IL",
});

/** In-memory localStorage stub; returns the backing map for assertions. */
function stubStorage() {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  return store;
}

beforeEach(() => resetForTests());
afterEach(() => vi.unstubAllGlobals());

describe("session store", () => {
  it("completeSignIn: signedIn snapshot with claims-decoded profile; refresh + phone persisted", () => {
    const store = stubStorage();

    completeSignIn({ AccessToken: "at", IdToken: ID_TOKEN, RefreshToken: "rt-1", ExpiresIn: 3600 });

    const snap = getSnapshot();
    expect(snap.status).toBe("signedIn");
    expect(snap.profile?.firstName).toBe("Dana");
    expect(snap.profile?.phone).toBe("+972541234567");
    expect(snap.tokens?.accessToken).toBe("at");
    expect(store.get("wanthat.refreshToken")).toBe("rt-1");
    expect(store.get("wanthat.phone")).toBe("+972541234567");
    expect(hasStoredSession()).toBe(true);
    expect(rememberedPhone()).toBe("+972541234567");
  });

  it("clearSession drops the refresh token but KEEPS the remembered phone (the passkey gate)", () => {
    const store = stubStorage();
    completeSignIn({ AccessToken: "at", IdToken: ID_TOKEN, RefreshToken: "rt-1", ExpiresIn: 3600 });

    clearSession();

    expect(getSnapshot().status).toBe("signedOut");
    expect(getSnapshot().profile).toBeNull();
    expect(store.has("wanthat.refreshToken")).toBe(false);
    expect(store.get("wanthat.phone")).toBe("+972541234567");
  });

  it("rehydrate without a stored token resolves signedOut without any network call", async () => {
    stubStorage();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await rehydrate();

    expect(getSnapshot().status).toBe("signedOut");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rehydrate exchanges the stored refresh token and keeps it when Cognito rotates nothing", async () => {
    const store = stubStorage();
    store.set("wanthat.refreshToken", "rt-stored");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        // REFRESH_TOKEN_AUTH returns no RefreshToken — the stored one must survive.
        AuthenticationResult: { AccessToken: "at2", IdToken: ID_TOKEN, ExpiresIn: 3600 },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await rehydrate();

    expect(getSnapshot().status).toBe("signedIn");
    expect(getSnapshot().tokens?.refreshToken).toBe("rt-stored");
    const body = JSON.parse((fetchMock.mock.calls[0] as [string, { body: string }])[1].body) as {
      AuthFlow: string;
      AuthParameters: { REFRESH_TOKEN: string };
    };
    expect(body.AuthFlow).toBe("REFRESH_TOKEN_AUTH");
    expect(body.AuthParameters.REFRESH_TOKEN).toBe("rt-stored");
  });

  it("rehydrate discards the stored token ONLY on a real rejection (NotAuthorized)", async () => {
    const store = stubStorage();
    store.set("wanthat.refreshToken", "rt-revoked");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({ __type: "NotAuthorizedException", message: "Refresh Token revoked" }),
      }),
    );

    await rehydrate();

    expect(getSnapshot().status).toBe("signedOut");
    expect(store.has("wanthat.refreshToken")).toBe(false);
  });

  it("rehydrate keeps the stored token on a network failure (no logout over a blip)", async () => {
    const store = stubStorage();
    store.set("wanthat.refreshToken", "rt-keep");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("network down")));

    await rehydrate();

    expect(getSnapshot().status).toBe("signedOut");
    expect(store.get("wanthat.refreshToken")).toBe("rt-keep");
  });

  it("rehydrate runs at most once (StrictMode double-mount safety)", async () => {
    const store = stubStorage();
    store.set("wanthat.refreshToken", "rt-stored");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        AuthenticationResult: { AccessToken: "at", IdToken: ID_TOKEN, ExpiresIn: 3600 },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await Promise.all([rehydrate(), rehydrate()]);
    await rehydrate();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
