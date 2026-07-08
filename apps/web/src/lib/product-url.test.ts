import { describe, expect, it } from "vitest";
import { extractSupportedUrl } from "./product-url";

describe("extractSupportedUrl", () => {
  const item = "https://he.aliexpress.com/item/1005006123456789.html";

  it("extracts the short link from the real share-button message", () => {
    const shareText =
      "I just found this on AliExpress:  | USB To 5V DC Power Cable USB A to DC Boost Cable " +
      "With Adapters USB to DC Jack Connector Power Supply Adapter For Wifi Router Fan\n" +
      "https://a.aliexpress.com/_c3TWMcp5";
    expect(extractSupportedUrl(shareText)).toBe("https://a.aliexpress.com/_c3TWMcp5");
  });

  it("accepts a bare product URL and one inside prose (trailing punctuation stripped)", () => {
    expect(extractSupportedUrl(item)).toBe(item);
    expect(extractSupportedUrl(` look: ${item}?spm=x, nice!`)).toBe(`${item}?spm=x`);
  });

  it("returns null for unsupported stores, lookalike hosts and plain prose", () => {
    expect(extractSupportedUrl("https://www.amazon.com/dp/B00X")).toBeNull();
    expect(
      extractSupportedUrl("https://aliexpress.com.evil.example/item/1005006123456789.html"),
    ).toBeNull();
    expect(extractSupportedUrl("no links here")).toBeNull();
  });
});
