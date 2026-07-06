import { describe, expect, it } from "vitest";
import { handler } from "./handler";
import { MOCK_PRODUCT, pickLocale, renderLanding } from "./landing-page";

const ev = (path: string, headers: Record<string, string> = {}) =>
  ({ rawPath: path, headers, queryStringParameters: null }) as never;

describe("pickLocale", () => {
  it("defaults to Hebrew, honours ?lang, falls back to Accept-Language", () => {
    expect(pickLocale(undefined, undefined)).toBe("he");
    expect(pickLocale("en", undefined)).toBe("en");
    expect(pickLocale("he", "en-US")).toBe("he"); // explicit wins
    expect(pickLocale(undefined, "en-GB,en;q=0.9")).toBe("en");
  });
});

describe("renderLanding", () => {
  const html = renderLanding({
    product: MOCK_PRODUCT,
    locale: "en",
    origin: "https://dev.wanthat.app",
    recId: "rec_123",
  });

  it("is bot-friendly: full OG + Twitter tags with an absolute image + page URL", () => {
    expect(html).toContain('<meta property="og:title" content="Jebao Smart Aquarium Fish Feeder"');
    expect(html).toContain(
      '<meta property="og:image" content="https://dev.wanthat.app/product-feeder.jpg"',
    );
    expect(html).toContain('<meta property="og:url" content="https://dev.wanthat.app/p/rec_123"');
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image"');
    expect(html).toContain("₪12.40"); // the earn amount
  });

  it("links the CTAs into the real auth flow with a safe internal next, plus a guest path", () => {
    expect(html).toContain('href="/auth?intent=signup&next=%2Fgo%2Frec_123"');
    expect(html).toContain('href="/auth?next=%2Fgo%2Frec_123"');
    expect(html).toContain('href="/go/rec_123?guest=1"');
  });

  it("renders RTL for Hebrew", () => {
    const he = renderLanding({
      product: MOCK_PRODUCT,
      locale: "he",
      origin: "https://dev.wanthat.app",
      recId: "x",
    });
    expect(he).toContain('dir="rtl"');
    expect(he).toContain('lang="he"');
  });
});

describe("handler", () => {
  it("serves the landing HTML (200) for /p/{id} and emits nothing to the body but html", async () => {
    const res = await handler(ev("/p/rec_abc", { host: "dev.wanthat.app" }));
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("og:title");
    expect(res.body).toContain("/p/rec_abc");
  });

  it("404s a non-/p path", async () => {
    const res = await handler(ev("/healthz"));
    expect(res.statusCode).toBe(404);
  });
});
