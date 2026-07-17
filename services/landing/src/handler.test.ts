import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted fakes so the vi.mock factory can close over them (vitest hoists vi.mock above imports).
const { fake } = vi.hoisted(() => ({
  fake: {
    recommendations: { get: vi.fn() },
    config: { get: vi.fn() },
    fx: { get: vi.fn() },
    env: "dev",
  },
}));
vi.mock("./context", () => ({ getContext: () => fake }));

import { handler, resetCachesForTests } from "./handler";

// The landing app's shell (apps/landing/landing.html as built): its assets live under
// /landing-assets/* so they can never collide with the member SPA's /assets/*.
const SHELL =
  '<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8" />' +
  "<title>Wanthat</title>" +
  '<script type="module" crossorigin src="/landing-assets/landing-abc123.js"></script>' +
  '</head><body><div id="root"></div></body></html>';

const NOW = "2026-07-01T00:00:00.000Z";
const ITEM = {
  recommendationId: "abc123DEF45",
  ownerId: "sub-1",
  storeId: "aliexpress",
  storeProductId: "1005006123456789",
  affiliateUrl: "https://s.click.aliexpress.com/e/_x",
  title: "Jebao Smart Aquarium Fish Feeder",
  imageUrl: "https://ae01.alicdn.com/kf/feeder.jpg",
  price: { amountMinor: "2500", currency: "USD" },
  commissionBps: 800,
  cashback: { referrerBps: 5000, consumerBps: 2500 },
  review: { text: "Great feeder!" },
  referrerFirstName: "Dana",
  clicks: 0,
  conversions: 0,
  createdAt: NOW,
  updatedAt: NOW,
};

/** The parsed `window.__WANTHAT_LANDING__` object out of the served HTML. */
function snapshotOf(body: string): Record<string, unknown> {
  const m = body.match(/window\.__WANTHAT_LANDING__ = (.*?);<\/script>/s);
  if (!m?.[1]) throw new Error("no snapshot in body");
  return JSON.parse(m[1]) as Record<string, unknown>;
}

describe("handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetCachesForTests();
    vi.stubEnv("SITE_ORIGIN", "https://dev.wanthat.app");
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve({ ok: true, text: async () => SHELL })),
    );
    fake.config.get.mockImplementation(async (key: string) => {
      if (key === "landing.countdownSeconds") return 5;
      if (key === "fx.conversionCommissionBps") return 0;
      return 0;
    });
    fake.fx.get.mockResolvedValue({ base: "USD", quote: "ILS", rate: "3.5000", asOf: NOW });
    fake.recommendations.get.mockResolvedValue(ITEM);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("serves real OG tags, the server card, and an ok snapshot for a resolved link", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const res = await handler({ rawPath: "/p/abc123DEF45" } as never);
    expect(res.statusCode).toBe(200);
    // The edge cache is origin-controlled (ADR-0018): this opt-in header is what CloudFront's
    // max-60s policy keys on — losing it silently disables the viral-burst shield.
    expect(res.headers["cache-control"]).toBe("public, max-age=60");
    expect(res.body).toContain(
      '<meta property="og:title" content="Jebao Smart Aquarium Fish Feeder" />',
    );
    expect(res.body).toContain("₪87.50"); // 2500 USD-minor x 3.5, server-rendered
    expect(res.body).toContain('src="/landing-assets/landing-abc123.js"'); // the landing app still boots

    const snap = snapshotOf(res.body);
    expect(snap.status).toBe("ok");
    expect(snap.countdownSeconds).toBe(5);
    const landing = snap.landing as {
      recommendationId: string;
      product: { price: { amountMinor: string } };
      referrerFirstName: string;
    };
    expect(landing.recommendationId).toBe("abc123DEF45");
    expect(landing.referrerFirstName).toBe("Dana");
    expect(landing.product.price.amountMinor).toBe("2500"); // wire form, not bigint

    // The impression funnel event, contract-shaped for the Logs→Firehose subscription filter.
    const line = logSpy.mock.calls.map((c) => String(c[0])).find((l) => l.includes('"impression"'));
    expect(line).toBeDefined();
    expect(JSON.parse(line as string)).toMatchObject({
      type: "impression",
      recommendationId: "abc123DEF45",
    });
    logSpy.mockRestore();
  });

  it("serves a notFound snapshot + generic OG for an unknown id, without an impression", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    fake.recommendations.get.mockResolvedValue(undefined);
    const res = await handler({ rawPath: "/p/gone1234567" } as never);
    expect(res.statusCode).toBe(200);
    expect(snapshotOf(res.body)).toEqual({ status: "notFound" });
    expect(res.body).toContain("<title>wanthat</title>");
    expect(res.body).not.toContain("og:image");
    expect(logSpy.mock.calls.flat().join("\n")).not.toContain('"impression"');
    logSpy.mockRestore();
  });

  it("degrades a resolve failure to the notFound snapshot (page still serves, no 5xx)", async () => {
    fake.recommendations.get.mockRejectedValue(new Error("dynamo down"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await handler({ rawPath: "/p/abc123DEF45" } as never);
    expect(res.statusCode).toBe(200);
    expect(snapshotOf(res.body)).toEqual({ status: "notFound" });
    errSpy.mockRestore();
  });

  it("escapes </script> in stored content so it cannot break out of the snapshot tag", async () => {
    fake.recommendations.get.mockResolvedValue({
      ...ITEM,
      review: { text: "</script><script>alert(1)</script>" },
    });
    const res = await handler({ rawPath: "/p/abc123DEF45" } as never);
    expect(res.body).not.toContain("</script><script>alert(1)");
    expect(res.body).toContain("\\u003c/script"); // escaped inside the JSON payload
  });

  it("fetches the shell from SITE_ORIGIN, never a request-derived host (SSRF guard)", async () => {
    const res = await handler({
      rawPath: "/p/abc123DEF45",
      headers: { host: "attacker.example" },
    } as never);
    expect(res.statusCode).toBe(200);
    const fetchMock = globalThis.fetch as unknown as { mock: { calls: unknown[][] } };
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://dev.wanthat.app/landing.html");
  });

  it("500s when SITE_ORIGIN is unset (fails closed, no header fallback)", async () => {
    vi.stubEnv("SITE_ORIGIN", "");
    const res = await handler({ rawPath: "/p/abc123DEF45" } as never);
    expect(res.statusCode).toBe(500);
  });

  it("404s a non-/p path and 502s when the shell is unavailable", async () => {
    expect((await handler({ rawPath: "/healthz" } as never)).statusCode).toBe(404);
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve({ ok: false, status: 503, text: async () => "" })),
    );
    expect((await handler({ rawPath: "/p/abc123DEF45" } as never)).statusCode).toBe(502);
  });

  it("routes POST /p/{id}/resolve to the resolve endpoint (guest redirect end-to-end)", async () => {
    const res = await handler({
      rawPath: "/p/abc123DEF45/resolve",
      requestContext: { http: { method: "POST" } },
      body: JSON.stringify({ guestId: "g-route" }),
    } as never);
    expect(res.statusCode).toBe(200);
    const parsed = JSON.parse(res.body) as { outcome: string; url: string };
    expect(parsed.outcome).toBe("redirect");
    const u = new URL(parsed.url);
    expect(u.searchParams.get("af")).toBe("dev:user:sub-1:rec:abc123DEF45");
    expect(u.searchParams.get("dp")).toBe("dev:guest:g-route");
  });

  it("405s a GET on the resolve path instead of rendering a page", async () => {
    const res = await handler({
      rawPath: "/p/abc123DEF45/resolve",
      requestContext: { http: { method: "GET" } },
    } as never);
    expect(res.statusCode).toBe(405);
  });
});
