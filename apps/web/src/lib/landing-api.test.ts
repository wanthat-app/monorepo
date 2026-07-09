import { afterEach, describe, expect, it, vi } from "vitest";
import { getOrMintGuestId, resolveRedirect } from "./landing-api";

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

const stubFetch = (status: number, payload: unknown) => {
  const mock = vi.fn(async () => ({ ok: status < 400, status, json: async () => payload }));
  vi.stubGlobal("fetch", mock);
  return mock;
};

afterEach(() => vi.unstubAllGlobals());

describe("resolveRedirect", () => {
  it("POSTs same-origin with the Bearer header and parses a redirect", async () => {
    const mock = stubFetch(200, { outcome: "redirect", url: "https://s.click.aliexpress.com/x" });
    const res = await resolveRedirect("rec1", { token: "tok" });
    expect(res).toEqual({ outcome: "redirect", url: "https://s.click.aliexpress.com/x" });
    const [url, init] = mock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/p/rec1/resolve");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok");
    expect(init.body).toBe("{}");
  });

  it("sends the guestId body without an auth header, and parses authRequired", async () => {
    const mock = stubFetch(200, { outcome: "authRequired" });
    const res = await resolveRedirect("rec1", { guestId: "g-1" });
    expect(res).toEqual({ outcome: "authRequired" });
    const [, init] = mock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBeUndefined();
    expect(init.body).toBe(JSON.stringify({ guestId: "g-1" }));
  });

  it("throws on a non-2xx answer and on a malformed payload", async () => {
    stubFetch(500, {});
    await expect(resolveRedirect("rec1", {})).rejects.toThrow("resolve failed: 500");
    stubFetch(200, { outcome: "weird" });
    await expect(resolveRedirect("rec1", {})).rejects.toThrow();
  });
});

describe("getOrMintGuestId", () => {
  it("mints once, persists, and returns the same id after", () => {
    const store = stubStorage();
    const first = getOrMintGuestId();
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(store.get("wanthat.guestId")).toBe(first);
    expect(getOrMintGuestId()).toBe(first);
  });

  it("returns a pre-existing stored id untouched", () => {
    const store = stubStorage();
    store.set("wanthat.guestId", "g-existing");
    expect(getOrMintGuestId()).toBe("g-existing");
  });
});
