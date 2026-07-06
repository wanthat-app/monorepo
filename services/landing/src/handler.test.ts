import { afterEach, describe, expect, it, vi } from "vitest";
import { injectLanding, MOCK_PRODUCT, ogHead, pickLocale } from "./landing-page";

const SHELL =
  '<!doctype html><html lang="en"><head><meta charset="utf-8" />' +
  "<title>Wanthat</title>" +
  '<script type="module" crossorigin src="/assets/index-abc123.js"></script>' +
  '<link rel="stylesheet" href="/assets/index-abc123.css" />' +
  '</head><body><div id="root"></div></body></html>';

describe("pickLocale", () => {
  it("defaults to Hebrew, honours ?lang, falls back to Accept-Language", () => {
    expect(pickLocale(undefined, undefined)).toBe("he");
    expect(pickLocale("en", undefined)).toBe("en");
    expect(pickLocale("he", "en-US")).toBe("he");
    expect(pickLocale(undefined, "en-GB,en;q=0.9")).toBe("en");
  });
});

describe("ogHead", () => {
  const head = ogHead(MOCK_PRODUCT, "https://dev.wanthat.app", "rec_123", "en");
  it("emits full OG + Twitter tags with absolute image + page URLs", () => {
    expect(head).toContain(
      '<meta property="og:title" content="Jebao Smart Aquarium Fish Feeder" />',
    );
    expect(head).toContain(
      '<meta property="og:image" content="https://dev.wanthat.app/product-feeder.jpg" />',
    );
    expect(head).toContain(
      '<meta property="og:url" content="https://dev.wanthat.app/p/rec_123" />',
    );
    expect(head).toContain('<meta name="twitter:card" content="summary_large_image" />');
    expect(head).toContain("₪12.40"); // the earn amount, in the description
  });
});

describe("injectLanding", () => {
  const html = injectLanding(SHELL, MOCK_PRODUCT, "https://dev.wanthat.app", "rec_123", "en");

  it("injects OG into <head> and a bot snapshot into #root, keeping the SPA's asset tags", () => {
    expect(html).toContain('property="og:title"');
    expect(html).toContain('src="/assets/index-abc123.js"'); // the SPA still boots
    expect(html).toContain('href="/assets/index-abc123.css"');
    expect(html).toMatch(/<div id="root">.*Jebao.*<\/div>/s); // bot-readable snapshot
    expect(html).not.toContain("<title>Wanthat</title>"); // generic title dropped
  });
});

describe("handler", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("fetches the SPA shell, injects OG, serves 200 HTML for /p/{id}", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, text: async () => SHELL })),
    );
    const { handler } = await import("./handler");
    const res = await handler({
      rawPath: "/p/rec_abc",
      headers: { host: "dev.wanthat.app" },
    } as never);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("og:title");
    expect(res.body).toContain("/p/rec_abc");
    expect(res.body).toContain("/assets/index-abc123.js");
  });

  it("404s a non-/p path", async () => {
    const { handler } = await import("./handler");
    const res = await handler({ rawPath: "/healthz" } as never);
    expect(res.statusCode).toBe(404);
  });
});
