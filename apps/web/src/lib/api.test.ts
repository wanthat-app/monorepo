import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, linksApi, walletApi } from "./api";

afterEach(() => vi.unstubAllGlobals());

describe("api client (wallet + links — the app-api surface left after ADR-0006)", () => {
  it("GETs the wallet with the Bearer token", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ balances: [], estimated: null }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await walletApi.get("tok-123");
    expect(res.balances).toEqual([]);
    const call = fetchMock.mock.calls[0] as [
      string,
      { method?: string; headers: Record<string, string> },
    ];
    expect(call[0]).toContain("/wallet");
    expect(call[1].method ?? "GET").toBe("GET");
    expect(call[1].headers.authorization).toBe("Bearer tok-123");
  });

  it("POSTs /products/resolve with the pasted URL and returns the parsed body", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ product: { title: "x" }, estimate: {}, displayFx: null }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await linksApi.resolveProduct("tok-123", "https://example.com/p");
    expect(res.displayFx).toBeNull();
    const call = fetchMock.mock.calls[0] as [string, { method: string; body: string }];
    expect(call[0]).toContain("/products/resolve");
    expect(call[1].method).toBe("POST");
    expect(JSON.parse(call[1].body).url).toBe("https://example.com/p");
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
    await expect(walletApi.get("tok")).rejects.toBeInstanceOf(ApiError);
    await expect(walletApi.get("tok")).rejects.toMatchObject({
      status: 429,
      code: "rate_limited",
    });
  });
});
