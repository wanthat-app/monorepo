import { describe, expect, it } from "vitest";
import { extractAliExpressUrl, isAliExpressShortLink, parseAliExpressProductUrl } from "./url";

describe("parseAliExpressProductUrl", () => {
  const id = "1005006123456789";

  it.each([
    `https://www.aliexpress.com/item/${id}.html`,
    `https://he.aliexpress.com/item/${id}.html?spm=a2g0o.detail&gatewayAdapt=glo2isr`,
    `https://m.aliexpress.com/item/${id}.html`,
    `https://aliexpress.com/item/${id}`,
    `https://www.aliexpress.us/item/${id}.html`,
    `https://he.aliexpress.com/i/${id}.html`,
    `http://www.aliexpress.com/item/${id}.htm`,
  ])("parses %s", (url) => {
    expect(parseAliExpressProductUrl(url)).toEqual({
      storeId: "aliexpress",
      storeProductId: id,
    });
  });

  it.each([
    "https://www.amazon.com/dp/B00X",
    `https://aliexpress.com.evil.example/item/${id}.html`,
    `https://evilaliexpress.com/item/${id}.html`,
    "https://a.aliexpress.com/_mNmXVxK", // share short-link: resolvable only via expansion, not parse
    "https://www.aliexpress.com/store/912345",
    "https://www.aliexpress.com/item/notdigits.html",
    `ftp://www.aliexpress.com/item/${id}.html`,
    "not a url",
  ])("rejects %s", (url) => {
    expect(parseAliExpressProductUrl(url)).toBeNull();
  });
});

describe("isAliExpressShortLink", () => {
  it("recognises the share-button short link and nothing looser", () => {
    expect(isAliExpressShortLink("https://a.aliexpress.com/_c3TWMcp5")).toBe(true);
    expect(isAliExpressShortLink("https://a.aliexpress.com/somepage")).toBe(false);
    expect(isAliExpressShortLink("https://a.aliexpress.com.evil.example/_c3TWMcp5")).toBe(false);
    expect(isAliExpressShortLink("https://www.aliexpress.com/_c3TWMcp5")).toBe(false);
  });
});

describe("extractAliExpressUrl", () => {
  const id = "1005006123456789";

  it("extracts the short link from the real share-button message", () => {
    const shareText =
      "I just found this on AliExpress:  | USB To 5V DC Power Cable USB A to DC Boost Cable " +
      "With Adapters USB to DC Jack Connector Power Supply Adapter For Wifi Router Fan\n" +
      "https://a.aliexpress.com/_c3TWMcp5";
    expect(extractAliExpressUrl(shareText)).toEqual({
      kind: "shortLink",
      url: "https://a.aliexpress.com/_c3TWMcp5",
    });
  });

  it("extracts a product URL from surrounding prose and strips trailing punctuation", () => {
    expect(
      extractAliExpressUrl(`check this out: https://he.aliexpress.com/item/${id}.html, so good!`),
    ).toEqual({
      kind: "product",
      url: `https://he.aliexpress.com/item/${id}.html`,
      storeId: "aliexpress",
      storeProductId: id,
    });
  });

  it("accepts a bare URL and skips unsupported URLs in the text", () => {
    expect(extractAliExpressUrl(`https://www.aliexpress.com/item/${id}.html`)?.kind).toBe(
      "product",
    );
    expect(
      extractAliExpressUrl(
        `see https://example.com/x then https://www.aliexpress.com/item/${id}.html`,
      )?.kind,
    ).toBe("product");
  });

  it("returns null when the text carries no supported URL", () => {
    expect(extractAliExpressUrl("no links here")).toBeNull();
    expect(extractAliExpressUrl("https://www.amazon.com/dp/B00X")).toBeNull();
  });
});
