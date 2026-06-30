import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyAdminOauthState } from "./admin-login";

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
