import { afterEach, describe, expect, it, vi } from "vitest";
import { CACHE_TTL_MS, clearAllCaches, readCache, writeCache } from "./stale-cache";

/** Map-backed localStorage stub with the iteration API clearAllCaches needs. */
function stubStorage() {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  });
  return store;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("stale-cache", () => {
  it("round-trips per user and per kind", () => {
    stubStorage();
    writeCache("wallet", "sub-a", { n: 1 });
    writeCache("wallet", "sub-b", { n: 2 });
    writeCache("activity", "sub-a", [{ id: "x" }]);
    expect(readCache("wallet", "sub-a")).toEqual({ n: 1 });
    expect(readCache("wallet", "sub-b")).toEqual({ n: 2 });
    expect(readCache("activity", "sub-a")).toEqual([{ id: "x" }]);
    expect(readCache("wallet", "sub-c")).toBeNull();
  });

  it("expires entries older than the 7-day TTL", () => {
    stubStorage();
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    writeCache("wallet", "s", { n: 1 });
    now.mockReturnValue(1_000_000 + CACHE_TTL_MS - 1);
    expect(readCache("wallet", "s")).toEqual({ n: 1 });
    now.mockReturnValue(1_000_000 + CACHE_TTL_MS + 1);
    expect(readCache("wallet", "s")).toBeNull();
  });

  it("treats a version mismatch and corrupt JSON as a miss", () => {
    const store = stubStorage();
    store.set("wanthat.cache.wallet.s", JSON.stringify({ v: 99, savedAt: Date.now(), data: 1 }));
    expect(readCache("wallet", "s")).toBeNull();
    store.set("wanthat.cache.wallet.s", "{not json");
    expect(readCache("wallet", "s")).toBeNull();
  });

  it("survives a throwing storage (private mode) as miss / silent no-write", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    });
    expect(readCache("wallet", "s")).toBeNull();
    expect(() => writeCache("wallet", "s", { n: 1 })).not.toThrow();
    expect(() => clearAllCaches()).not.toThrow();
  });

  it("clearAllCaches removes only wanthat.cache.* keys", () => {
    const store = stubStorage();
    writeCache("wallet", "s", { n: 1 });
    writeCache("activity", "s", []);
    store.set("wanthat.refreshToken", "keep-me");
    clearAllCaches();
    expect(store.has("wanthat.refreshToken")).toBe(true);
    expect([...store.keys()].filter((k) => k.startsWith("wanthat.cache."))).toEqual([]);
  });
});
