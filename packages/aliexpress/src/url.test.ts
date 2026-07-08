import { describe, expect, it } from "vitest";
import { parseAliExpressProductUrl } from "./url";

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
    "https://a.aliexpress.com/_mNmXVxK", // share short-link: needs a fetch to resolve — unsupported (SSRF-safe)
    "https://www.aliexpress.com/store/912345",
    "https://www.aliexpress.com/item/notdigits.html",
    `ftp://www.aliexpress.com/item/${id}.html`,
    "not a url",
  ])("rejects %s", (url) => {
    expect(parseAliExpressProductUrl(url)).toBeNull();
  });
});
