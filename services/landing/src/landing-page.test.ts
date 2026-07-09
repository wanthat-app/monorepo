import type { RecommendationItem } from "@wanthat/dynamo";
import { describe, expect, it } from "vitest";
import { buildRender, formatMinor, injectLanding, ogHead, pickLocale } from "./landing-page";

const SHELL =
  '<!doctype html><html lang="en"><head><meta charset="utf-8" />' +
  "<title>Wanthat</title>" +
  '<script type="module" crossorigin src="/assets/index-abc123.js"></script>' +
  '<link rel="stylesheet" href="/assets/index-abc123.css" />' +
  '</head><body><div id="root"></div></body></html>';

const NOW = "2026-07-01T00:00:00.000Z";
const ITEM: RecommendationItem = {
  recommendationId: "abc123DEF45",
  ownerId: "sub-1",
  storeId: "aliexpress",
  storeProductId: "1005006123456789",
  affiliateUrl: "https://s.click.aliexpress.com/e/_x",
  title: 'Fish "Feeder" <Pro>',
  imageUrl: "https://ae01.alicdn.com/kf/feeder.jpg",
  price: { amountMinor: "2500", currency: "USD" },
  commissionBps: 800,
  cashback: { referrerBps: 5000, consumerBps: 2500 },
  review: { text: "Great feeder, my fish love it!" },
  referrerFirstName: "Dana",
  clicks: 0,
  conversions: 0,
  createdAt: NOW,
  updatedAt: NOW,
};

describe("pickLocale", () => {
  it("defaults to Hebrew, honours ?lang, falls back to Accept-Language", () => {
    expect(pickLocale(undefined, undefined)).toBe("he");
    expect(pickLocale("en", undefined)).toBe("en");
    expect(pickLocale("he", "en-US")).toBe("he");
    expect(pickLocale(undefined, "en-GB,en;q=0.9")).toBe("en");
  });
});

describe("formatMinor", () => {
  it("formats minor units with symbol, grouping, and two decimals", () => {
    expect(formatMinor(8750n, "ILS")).toBe("₪87.50");
    expect(formatMinor(2500n, "USD")).toBe("$25.00");
    expect(formatMinor(123456789n, "ILS")).toBe("₪1,234,567.89");
    expect(formatMinor(-50n, "ILS")).toBe("-₪0.50");
    expect(formatMinor(100n, "JPY")).toBe("JPY 1.00");
  });
});

describe("buildRender", () => {
  it("converts price and consumer cashback to ILS display strings", () => {
    const r = buildRender(ITEM, "3.5000", 0);
    expect(r.priceDisplay).toBe("₪87.50"); // 2500 USD-minor x 3.5
    // gross = 2500 x 8% = 200; consumer 25% -> 50 USD-minor; x 3.5 -> ₪1.75
    expect(r.cashbackDisplay).toBe("₪1.75");
    expect(r.merchant).toBe("AliExpress");
    expect(r.referrerFirstName).toBe("Dana");
    expect(r.reviewText).toBe("Great feeder, my fish love it!");
  });

  it("withholds the fx conversion commission like the wallet does", () => {
    const r = buildRender(ITEM, "3.5000", 200); // 2% margin
    expect(r.priceDisplay).toBe("₪85.75"); // 8750 x 98%
  });

  it("falls back to origin currency when no fx rate is cached", () => {
    const r = buildRender(ITEM, null, 0);
    expect(r.priceDisplay).toBe("$25.00");
    expect(r.cashbackDisplay).toBe("$0.50");
  });

  it("handles an unpriced product and a bare item", () => {
    const r = buildRender(
      { ...ITEM, price: null, review: null, referrerFirstName: null, imageUrl: null },
      null,
      0,
    );
    expect(r.priceDisplay).toBeNull();
    expect(r.cashbackDisplay).toBeNull();
    expect(r.reviewText).toBeNull();
    expect(r.referrerFirstName).toBeNull();
  });
});

describe("ogHead", () => {
  it("uses the stored absolute image URL and the review as the description", () => {
    const head = ogHead(buildRender(ITEM, "3.5000", 0), "https://dev.wanthat.app", ITEM.recommendationId, "en");
    expect(head).toContain('<meta property="og:image" content="https://ae01.alicdn.com/kf/feeder.jpg" />');
    expect(head).toContain('content="Great feeder, my fish love it!"');
    expect(head).toContain('<meta property="og:url" content="https://dev.wanthat.app/p/abc123DEF45" />');
    expect(head).toContain('<meta name="twitter:card" content="summary_large_image" />');
  });

  it("falls back to the cashback disclosure without a review, and omits image tags without an image", () => {
    const head = ogHead(
      buildRender({ ...ITEM, review: null, imageUrl: null }, "3.5000", 0),
      "https://dev.wanthat.app",
      ITEM.recommendationId,
      "en",
    );
    expect(head).toContain("earn ₪1.75 cashback");
    expect(head).not.toContain("og:image");
    expect(head).not.toContain("twitter:card");
  });

  it("HTML-escapes user-controlled content", () => {
    const head = ogHead(buildRender(ITEM, null, 0), "https://dev.wanthat.app", ITEM.recommendationId, "en");
    expect(head).not.toContain("<Pro>");
    expect(head).toContain("&lt;Pro&gt;");
  });
});

describe("injectLanding", () => {
  it("injects OG, the snapshot script, and the server card, keeping the SPA's asset tags", () => {
    const html = injectLanding(
      SHELL,
      buildRender(ITEM, "3.5000", 0),
      '{"status":"ok"}',
      "https://dev.wanthat.app",
      ITEM.recommendationId,
      "en",
    );
    expect(html).toContain('property="og:title"');
    expect(html).toContain('src="/assets/index-abc123.js"'); // the SPA still boots
    expect(html).toContain('window.__WANTHAT_LANDING__ = {"status":"ok"};');
    expect(html).toMatch(/<div id="root">.*Feeder.*<\/div>/s); // content-first card
    expect(html).toContain("Dana"); // attribution line
    expect(html).toContain("₪87.50");
    expect(html).not.toContain("<title>Wanthat</title>"); // generic title dropped
    expect(html).not.toContain("<Pro>"); // escaped in card + head
    expect(html).not.toContain("s.click.aliexpress.com"); // the affiliate URL never renders
  });

  it("renders a generic head and empty root card for a null render, still injecting the snapshot", () => {
    const html = injectLanding(
      SHELL,
      null,
      '{"status":"notFound"}',
      "https://dev.wanthat.app",
      "gone1234567",
      "en",
    );
    expect(html).toContain('window.__WANTHAT_LANDING__ = {"status":"notFound"};');
    expect(html).toContain("<title>wanthat</title>");
    expect(html).not.toContain("og:image");
  });
});
