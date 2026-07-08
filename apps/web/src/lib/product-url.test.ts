import { describe, expect, it } from "vitest";
import { isSupportedProductUrl, looksLikeUrl } from "./product-url";

describe("isSupportedProductUrl", () => {
  it.each([
    "https://www.aliexpress.com/item/1005006123456789.html",
    "https://he.aliexpress.com/item/1005006123456789.html?spm=a2g0o.detail",
    " https://m.aliexpress.com/i/1005006123456789.html ",
  ])("accepts %s", (url) => {
    expect(isSupportedProductUrl(url)).toBe(true);
  });

  it.each([
    "https://www.amazon.com/dp/B00X",
    "https://a.aliexpress.com/_mShort",
    "https://aliexpress.com.evil.example/item/1005006123456789.html",
    "not a url",
  ])("rejects %s", (url) => {
    expect(isSupportedProductUrl(url)).toBe(false);
  });
});

describe("looksLikeUrl", () => {
  it("recognises a pasted URL and ignores prose", () => {
    expect(looksLikeUrl("https://he.aliexpress.com/item/1.html")).toBe(true);
    expect(looksLikeUrl("check this out")).toBe(false);
  });
});
