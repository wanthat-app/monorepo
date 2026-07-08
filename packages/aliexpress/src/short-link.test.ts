import { describe, expect, it } from "vitest";
import { expandAliExpressShortLink } from "./short-link";

const SHORT = "https://a.aliexpress.com/_c3TWMcp5";
const ID = "1005006123456789";
const ITEM = `https://www.aliexpress.com/item/${ID}.html`;

/** Fake fetch serving a redirect map; records every URL actually fetched. */
function redirectFetch(hops: Record<string, string | { status: number }>) {
  const fetched: string[] = [];
  const fetchFn = (async (url: unknown) => {
    fetched.push(String(url));
    const target = hops[String(url)];
    if (target === undefined) return new Response(null, { status: 404 });
    if (typeof target !== "string") return new Response(null, { status: target.status });
    return new Response(null, { status: 302, headers: { location: target } });
  }) as typeof fetch;
  return { fetchFn, fetched };
}

describe("expandAliExpressShortLink", () => {
  it("resolves a direct redirect to the item URL", async () => {
    const { fetchFn } = redirectFetch({ [SHORT]: ITEM });
    expect(await expandAliExpressShortLink(SHORT, fetchFn)).toEqual({
      storeId: "aliexpress",
      storeProductId: ID,
      canonicalUrl: ITEM,
    });
  });

  it("finds the product URL embedded in a share-interstitial query param", async () => {
    const interstitial = `https://star.aliexpress.com/share/share.htm?businessType=ProductDetail&url=${encodeURIComponent(`${ITEM}?sourceType=620`)}`;
    const { fetchFn, fetched } = redirectFetch({ [SHORT]: interstitial });
    expect(await expandAliExpressShortLink(SHORT, fetchFn)).toEqual({
      storeId: "aliexpress",
      storeProductId: ID,
      canonicalUrl: ITEM,
    });
    // The interstitial itself is never fetched — its URL already reveals the product.
    expect(fetched).toEqual([SHORT]);
  });

  it("follows a bounded multi-hop chain on allow-listed hosts", async () => {
    const mid = "https://star.aliexpress.com/share/redirect.htm?x=1";
    const { fetchFn } = redirectFetch({ [SHORT]: mid, [mid]: ITEM });
    expect((await expandAliExpressShortLink(SHORT, fetchFn))?.storeProductId).toBe(ID);
  });

  it("NEVER fetches an off-allow-list redirect target (SSRF pin)", async () => {
    const { fetchFn, fetched } = redirectFetch({
      [SHORT]: "https://evil.example/item/1005006123456789.html",
    });
    expect(await expandAliExpressShortLink(SHORT, fetchFn)).toBeNull();
    expect(fetched).toEqual([SHORT]);
  });

  it("refuses to start from a non-AliExpress URL", async () => {
    const { fetchFn, fetched } = redirectFetch({});
    expect(await expandAliExpressShortLink("https://evil.example/_x", fetchFn)).toBeNull();
    expect(fetched).toEqual([]);
  });

  it("gives up on a dead end (no redirect) and on the hop cap", async () => {
    const { fetchFn } = redirectFetch({ [SHORT]: { status: 200 } });
    expect(await expandAliExpressShortLink(SHORT, fetchFn)).toBeNull();

    const loop = redirectFetch({
      [SHORT]: "https://a.aliexpress.com/_loop",
      "https://a.aliexpress.com/_loop": SHORT,
    });
    expect(await expandAliExpressShortLink(SHORT, loop.fetchFn)).toBeNull();
    expect(loop.fetched.length).toBeLessThanOrEqual(4);
  });
});
