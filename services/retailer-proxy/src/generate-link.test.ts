import { Logger } from "@aws-lambda-powertools/logger";
import type { AliExpressClient, AliExpressProductDetail } from "@wanthat/aliexpress";
import type { ProductItem, ProductRepo, ProductUpsert } from "@wanthat/dynamo";
import { describe, expect, it } from "vitest";
import { generateLink } from "./generate-link";

const URL = "https://he.aliexpress.com/item/1005006123456789.html";
const NOW = new Date("2026-07-08T10:00:00.000Z");
const logger = new Logger({ serviceName: "test", logLevel: "SILENT" });

const DETAIL: AliExpressProductDetail = {
  title: "Jebao Smart Aquarium Fish Feeder",
  imageUrl: "//ae01.alicdn.com/kf/feeder.jpg",
  priceMinor: "2612",
  priceCurrency: "USD",
  commissionBps: 700,
};

function fakeProducts() {
  const upserts: ProductUpsert[] = [];
  const products = {
    upsert: async (product: ProductUpsert, now: string): Promise<ProductItem> => {
      upserts.push(product);
      return { ...product, createdAt: now, updatedAt: now };
    },
  } as unknown as ProductRepo;
  return { products, upserts };
}

function fakeClient(overrides?: {
  generate?: () => Promise<string>;
  detail?: () => Promise<AliExpressProductDetail>;
}): AliExpressClient {
  return {
    generatePromotionLink:
      overrides?.generate ?? (async () => "https://s.click.aliexpress.com/e/_abc"),
    getProductDetail: overrides?.detail ?? (async () => DETAIL),
  } as unknown as AliExpressClient;
}

describe("generateLink", () => {
  it("mints the link, enriches metadata and upserts the shared product", async () => {
    const { products, upserts } = fakeProducts();
    const res = await generateLink(URL, {
      products,
      client: async () => fakeClient(),
      logger,
      now: () => NOW,
    });
    if (res.status !== "ok") throw new Error(`expected ok, got ${JSON.stringify(res)}`);
    expect(res.affiliateUrl).toBe("https://s.click.aliexpress.com/e/_abc");
    expect(res.product.title).toBe("Jebao Smart Aquarium Fish Feeder");
    // Protocol-relative image URLs are absolutised so they satisfy the contract's url().
    expect(res.product.imageUrl).toBe("https://ae01.alicdn.com/kf/feeder.jpg");
    expect(res.product.price).toEqual({ amountMinor: "2612", currency: "USD" });
    expect(upserts[0]?.affiliateUrl).toBe("https://s.click.aliexpress.com/e/_abc");
  });

  it("answers unsupported_url for a non-product URL without touching the retailer", async () => {
    const { products } = fakeProducts();
    const res = await generateLink("https://a.aliexpress.com/_mShort", {
      products,
      client: async () => {
        throw new Error("must not be called");
      },
      logger,
    });
    expect(res).toEqual({ status: "error", code: "unsupported_url" });
  });

  it("answers retailer_not_configured while the secret is unpopulated", async () => {
    const { products } = fakeProducts();
    const res = await generateLink(URL, { products, client: async () => null, logger });
    expect(res).toEqual({ status: "error", code: "retailer_not_configured" });
  });

  it("answers upstream_error when the link mint fails", async () => {
    const { products, upserts } = fakeProducts();
    const res = await generateLink(URL, {
      products,
      client: async () =>
        fakeClient({
          generate: async () => {
            throw new Error("gateway down");
          },
        }),
      logger,
    });
    expect(res.status).toBe("error");
    if (res.status === "error") expect(res.code).toBe("upstream_error");
    expect(upserts).toHaveLength(0);
  });

  it("persists placeholder metadata when productdetail fails (best-effort)", async () => {
    const { products } = fakeProducts();
    const res = await generateLink(URL, {
      products,
      client: async () =>
        fakeClient({
          detail: async () => {
            throw new Error("timeout");
          },
        }),
      logger,
      now: () => NOW,
    });
    if (res.status !== "ok") throw new Error("expected ok");
    expect(res.product.title).toBe("AliExpress item 1005006123456789");
    expect(res.product.imageUrl).toBeNull();
    expect(res.product.price).toBeNull();
    expect(res.product.commissionBps).toBe(0);
  });
});
