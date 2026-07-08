import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted fakes so the vi.mock factories can close over them (vitest hoists vi.mock above imports).
const { fake } = vi.hoisted(() => ({
  fake: {
    region: "il-central-1",
    products: { get: vi.fn(), upsert: vi.fn() },
    recommendations: {
      create: vi.fn(),
      get: vi.fn(),
      updateReview: vi.fn(),
      listByOwner: vi.fn(),
    },
    config: { get: vi.fn() },
    retailerProxy: { generateLink: vi.fn() },
    appUrl: "https://dev.wanthat.app",
  },
}));

vi.mock("../context", () => ({ getContext: () => fake }));

import { productsRouter, recommendationsRouter } from "./router";
import { RECOMMENDATION_NAMESPACE, uuidV5 } from "./uuid";

const app = new Hono();
app.route("/products", productsRouter());
app.route("/recommendations", recommendationsRouter());

const SUB = "11111111-1111-1111-1111-111111111111";
const authed = {
  event: { requestContext: { authorizer: { jwt: { claims: { sub: SUB } } } } },
};
const NOW = "2026-07-08T10:00:00.000Z";
const URL_OK = "https://he.aliexpress.com/item/1005006123456789.html";

const PRODUCT_ITEM = {
  storeId: "aliexpress",
  storeProductId: "1005006123456789",
  title: "Jebao Smart Aquarium Fish Feeder",
  imageUrl: "https://ae01.alicdn.com/kf/feeder.jpg",
  price: { amountMinor: "2612", currency: "USD" },
  commissionBps: 700,
  affiliateUrl: "https://s.click.aliexpress.com/e/_abc",
  createdAt: NOW,
  updatedAt: NOW,
};

const REC_ID = uuidV5(`${SUB}#aliexpress#1005006123456789`, RECOMMENDATION_NAMESPACE);
const REC_ITEM = {
  recommendationId: REC_ID,
  ownerId: SUB,
  storeId: "aliexpress",
  storeProductId: "1005006123456789",
  affiliateUrl: PRODUCT_ITEM.affiliateUrl,
  title: PRODUCT_ITEM.title,
  imageUrl: PRODUCT_ITEM.imageUrl,
  price: PRODUCT_ITEM.price,
  commissionBps: 700,
  cashback: { referrerBps: 5000, consumerBps: 0 },
  review: null,
  clicks: 0,
  conversions: 0,
  createdAt: NOW,
  updatedAt: NOW,
};

function reqAs(env: object | undefined, path: string, method: string, body?: unknown) {
  return app.request(
    path,
    {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    env,
  );
}
const req = (path: string, method: string, body?: unknown) => reqAs(authed, path, method, body);

interface WireShare {
  rateBps: number;
  estimated: { amountMinor: string; currency: string } | null;
}
interface WireRecommendation {
  recommendationId: string;
  shareUrl: string;
  cashback: { referrerBps: number; consumerBps: number };
  review: { text: string; rating?: number } | null;
}
const json = async <T>(res: Response) => (await res.json()) as T;

beforeEach(() => {
  vi.clearAllMocks();
  fake.config.get.mockImplementation(async (key: string) =>
    key === "cashback.referrerBps" ? 5000 : 0,
  );
});

describe("POST /products/resolve", () => {
  it("answers a cached product from DynamoDB without a retailer call", async () => {
    fake.products.get.mockResolvedValue(PRODUCT_ITEM);
    const res = await req("/products/resolve", "POST", { url: URL_OK });
    expect(res.status).toBe(200);
    const data = await json<{
      product: { title: string };
      estimate: { referrer: WireShare; consumer: WireShare };
    }>(res);
    expect(data.product.title).toBe(PRODUCT_ITEM.title);
    // price × commission (7%) = 182 minor gross; referrer 50% → 91, consumer 0% → 0.
    expect(data.estimate.referrer.estimated).toEqual({ amountMinor: "91", currency: "USD" });
    expect(data.estimate.consumer.estimated).toEqual({ amountMinor: "0", currency: "USD" });
    expect(fake.retailerProxy.generateLink).not.toHaveBeenCalled();
  });

  it("mints via the retailer-proxy on a cache miss, then rereads the stored product", async () => {
    fake.products.get.mockResolvedValueOnce(undefined).mockResolvedValueOnce(PRODUCT_ITEM);
    fake.retailerProxy.generateLink.mockResolvedValue({
      status: "ok",
      product: PRODUCT_ITEM,
      affiliateUrl: PRODUCT_ITEM.affiliateUrl,
    });
    const res = await req("/products/resolve", "POST", { url: URL_OK });
    expect(res.status).toBe(200);
    expect(fake.retailerProxy.generateLink).toHaveBeenCalledWith(URL_OK);
  });

  it("rejects a non-AliExpress URL locally (400, no proxy invoke)", async () => {
    const res = await req("/products/resolve", "POST", { url: "https://www.amazon.com/dp/B0X" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "unsupported_url" });
    expect(fake.products.get).not.toHaveBeenCalled();
  });

  it.each([
    ["retailer_not_configured", 503],
    ["upstream_error", 502],
  ] as const)("maps the proxy error %s to %d", async (code, status) => {
    fake.products.get.mockResolvedValue(undefined);
    fake.retailerProxy.generateLink.mockResolvedValue({ status: "error", code });
    const res = await req("/products/resolve", "POST", { url: URL_OK });
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error: code });
  });

  it("401s without claims", async () => {
    expect((await reqAs(undefined, "/products/resolve", "POST", { url: URL_OK })).status).toBe(401);
  });
});

describe("POST /recommendations", () => {
  const body = { storeId: "aliexpress", storeProductId: "1005006123456789" };

  it("creates the link with a deterministic id and the current split snapshot (201)", async () => {
    fake.products.get.mockResolvedValue(PRODUCT_ITEM);
    fake.recommendations.create.mockImplementation(async (item: unknown) => ({
      item,
      created: true,
    }));
    const res = await req("/recommendations", "POST", body);
    expect(res.status).toBe(201);
    const data = await json<{ recommendation: WireRecommendation }>(res);
    expect(data.recommendation.recommendationId).toBe(REC_ID);
    expect(data.recommendation.shareUrl).toBe(`https://dev.wanthat.app/p/${REC_ID}`);
    expect(data.recommendation.cashback).toEqual({ referrerBps: 5000, consumerBps: 0 });
    // The affiliate URL is redirect-internal (ADR-0007) — never in the API response.
    expect(JSON.stringify(data)).not.toContain("s.click.aliexpress.com");
  });

  it("returns the existing link on replay (200, original snapshot kept)", async () => {
    fake.products.get.mockResolvedValue(PRODUCT_ITEM);
    fake.recommendations.create.mockResolvedValue({
      item: { ...REC_ITEM, cashback: { referrerBps: 4000, consumerBps: 500 } },
      created: false,
    });
    const res = await req("/recommendations", "POST", body);
    expect(res.status).toBe(200);
    const data = await json<{ recommendation: WireRecommendation }>(res);
    expect(data.recommendation.cashback).toEqual({ referrerBps: 4000, consumerBps: 500 });
  });

  it("404s when the product was never resolved", async () => {
    fake.products.get.mockResolvedValue(undefined);
    const res = await req("/recommendations", "POST", body);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "product_not_resolved" });
  });
});

describe("GET /recommendations", () => {
  it("lists mine newest-first with an opaque cursor", async () => {
    fake.recommendations.listByOwner.mockResolvedValue({
      items: [REC_ITEM],
      lastKey: { recommendationId: REC_ID },
    });
    const res = await req("/recommendations?limit=5", "GET");
    expect(res.status).toBe(200);
    const data = await json<{ items: unknown[]; nextCursor: string | null }>(res);
    expect(data.items[0]).toMatchObject({
      recommendationId: REC_ID,
      title: REC_ITEM.title,
      stats: { clicks: 0, conversions: 0 },
    });
    expect(typeof data.nextCursor).toBe("string");
    expect(fake.recommendations.listByOwner).toHaveBeenCalledWith(SUB, 5, undefined);
  });
});

describe("GET /recommendations/{id}", () => {
  it("returns my recommendation", async () => {
    fake.recommendations.get.mockResolvedValue(REC_ITEM);
    const res = await req(`/recommendations/${REC_ID}`, "GET");
    expect(res.status).toBe(200);
  });

  it("404s on someone else's recommendation", async () => {
    fake.recommendations.get.mockResolvedValue({ ...REC_ITEM, ownerId: "sub-other" });
    expect((await req(`/recommendations/${REC_ID}`, "GET")).status).toBe(404);
  });
});

describe("PATCH /recommendations/{id}", () => {
  it("updates the review through the owner-conditional write", async () => {
    const review = { text: "so good", rating: 5 };
    fake.recommendations.updateReview.mockResolvedValue({ ...REC_ITEM, review });
    const res = await req(`/recommendations/${REC_ID}`, "PATCH", { review });
    expect(res.status).toBe(200);
    expect((await json<{ recommendation: WireRecommendation }>(res)).recommendation.review).toEqual(
      review,
    );
    expect(fake.recommendations.updateReview).toHaveBeenCalledWith(
      REC_ID,
      SUB,
      review,
      expect.any(String),
    );
  });

  it("404s when the conditional write is denied", async () => {
    fake.recommendations.updateReview.mockResolvedValue(undefined);
    expect((await req(`/recommendations/${REC_ID}`, "PATCH", { review: null })).status).toBe(404);
  });

  it("400s on a malformed body", async () => {
    expect((await req(`/recommendations/${REC_ID}`, "PATCH", {})).status).toBe(400);
  });
});
