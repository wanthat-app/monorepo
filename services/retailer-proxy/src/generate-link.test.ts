import { Logger } from "@aws-lambda-powertools/logger";
import type { AliExpressClient, AliExpressProductDetail } from "@wanthat/aliexpress";
import { AliExpressApiError } from "@wanthat/aliexpress";
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

function fakeProducts(existing?: ProductItem) {
  const upserts: ProductUpsert[] = [];
  const products = {
    get: async (): Promise<ProductItem | undefined> => existing,
    create: async (product: ProductUpsert, now: string) => {
      upserts.push(product);
      return { item: { ...product, createdAt: now, updatedAt: now }, created: true };
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

  it("answers unsupported_url for a non-AliExpress URL without touching the retailer", async () => {
    const { products } = fakeProducts();
    const res = await generateLink("https://www.amazon.com/dp/B00X", {
      products,
      client: async () => {
        throw new Error("must not be called");
      },
      logger,
    });
    expect(res).toEqual({ status: "error", code: "unsupported_url" });
  });

  it("reuses an already-minted product with NO retailer call (one link.generate per product)", async () => {
    const stored: ProductItem = {
      storeId: "aliexpress",
      storeProductId: "1005006123456789",
      title: "Jebao Smart Aquarium Fish Feeder",
      imageUrl: "https://ae01.alicdn.com/kf/feeder.jpg",
      price: { amountMinor: "2612", currency: "USD" },
      commissionBps: 700,
      affiliateUrl: "https://s.click.aliexpress.com/e/_abc",
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    };
    const { products, upserts } = fakeProducts(stored);
    const res = await generateLink(URL, {
      products,
      client: async () => {
        throw new Error("must not be called");
      },
      logger,
    });
    if (res.status !== "ok") throw new Error("expected ok");
    expect(res.affiliateUrl).toBe(stored.affiliateUrl);
    expect(upserts).toHaveLength(0);
  });

  it("expands the share-button text via the short link and mints from the canonical URL", async () => {
    const shareText =
      "I just found this on AliExpress:  | USB To 5V DC Power Cable\nhttps://a.aliexpress.com/_c3TWMcp5";
    const canonical = "https://www.aliexpress.com/item/1005006123456789.html";
    const sourceUrls: string[] = [];
    const { products, upserts } = fakeProducts();
    const redirectFetch = (async () =>
      new Response(null, { status: 302, headers: { location: canonical } })) as typeof fetch;
    const res = await generateLink(shareText, {
      products,
      client: async () =>
        fakeClient({
          generate: async (url?: unknown) => {
            sourceUrls.push(String(url));
            return "https://s.click.aliexpress.com/e/_abc";
          },
        }),
      logger,
      fetchFn: redirectFetch,
      now: () => NOW,
    });
    if (res.status !== "ok") throw new Error(`expected ok, got ${JSON.stringify(res)}`);
    expect(res.product.storeProductId).toBe("1005006123456789");
    expect(upserts).toHaveLength(1);
    expect(sourceUrls).toEqual([canonical]); // link.generate gets the canonical item URL, not the short link
  });

  it("answers unsupported_url when the short link dead-ends off the allow-list", async () => {
    const { products } = fakeProducts();
    const evilFetch = (async () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://evil.example/item/1005006123456789.html" },
      })) as typeof fetch;
    const res = await generateLink("https://a.aliexpress.com/_c3TWMcp5", {
      products,
      client: async () => fakeClient(),
      logger,
      fetchFn: evilFetch,
    });
    expect(res).toEqual({ status: "error", code: "unsupported_url" });
  });

  it("answers upstream_error when the expansion fetch itself fails", async () => {
    const { products } = fakeProducts();
    const brokenFetch = (async () => {
      throw new Error("network down");
    }) as typeof fetch;
    const res = await generateLink("https://a.aliexpress.com/_c3TWMcp5", {
      products,
      client: async () => fakeClient(),
      logger,
      fetchFn: brokenFetch,
    });
    expect(res.status).toBe("error");
    if (res.status === "error") expect(res.code).toBe("upstream_error");
  });

  it("answers retailer_not_configured while the secret is unpopulated", async () => {
    const { products } = fakeProducts();
    const res = await generateLink(URL, { products, client: async () => null, logger });
    expect(res).toEqual({ status: "error", code: "retailer_not_configured" });
  });

  it("answers upstream_error (never throws) when the client setup itself fails", async () => {
    const { products } = fakeProducts();
    const res = await generateLink(URL, {
      products,
      client: async () => {
        throw new Error("secrets manager throttled");
      },
      logger,
    });
    expect(res.status).toBe("error");
    if (res.status === "error") expect(res.code).toBe("upstream_error");
  });

  it("fails the ENTIRE flow (nothing stored) when productdetail fails — all-or-nothing", async () => {
    const { products, upserts } = fakeProducts();
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
    expect(res.status).toBe("error");
    if (res.status === "error") expect(res.code).toBe("upstream_error");
    expect(upserts).toHaveLength(0);
  });

  it("logs the store product id when productdetail fails (diagnosable failures)", async () => {
    const spyLogger = new Logger({ serviceName: "test", logLevel: "SILENT" });
    const errors: Array<[string, Record<string, unknown> | undefined]> = [];
    spyLogger.error = ((msg: string, extra?: Record<string, unknown>) => {
      errors.push([msg, extra]);
    }) as typeof spyLogger.error;
    const { products } = fakeProducts();
    await generateLink(URL, {
      products,
      client: async () =>
        fakeClient({
          detail: async () => {
            throw new Error("timeout");
          },
        }),
      logger: spyLogger,
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.[1]).toMatchObject({ storeProductId: "1005006123456789" });
  });

  it("fails the flow when metadata comes back without title or commission", async () => {
    const { products, upserts } = fakeProducts();
    const res = await generateLink(URL, {
      products,
      client: async () => fakeClient({ detail: async () => ({ ...DETAIL, commissionBps: null }) }),
      logger,
    });
    expect(res.status).toBe("error");
    expect(upserts).toHaveLength(0);
  });

  it("pulls metadata FIRST and mints the link at the END (sequential, ordered)", async () => {
    const order: string[] = [];
    const { products, upserts } = fakeProducts();
    const res = await generateLink(URL, {
      products,
      client: async () =>
        fakeClient({
          detail: async () => {
            order.push("detail");
            return DETAIL;
          },
          generate: async () => {
            order.push("generate");
            return "https://s.click.aliexpress.com/e/_abc";
          },
        }),
      logger,
      now: () => NOW,
    });
    if (res.status !== "ok") throw new Error("expected ok");
    expect(order).toEqual(["detail", "generate"]);
    expect(upserts).toHaveLength(1);
  });

  it("retries a call ONCE after the throttle window on ApiCallLimit", async () => {
    const { products } = fakeProducts();
    const waits: number[] = [];
    let calls = 0;
    const res = await generateLink(URL, {
      products,
      client: async () =>
        fakeClient({
          detail: async () => {
            calls += 1;
            if (calls === 1)
              throw new AliExpressApiError("ApiCallLimit", "frequency exceeds the limit");
            return DETAIL;
          },
        }),
      logger,
      sleep: async (ms) => {
        waits.push(ms);
      },
      now: () => NOW,
    });
    if (res.status !== "ok") throw new Error("expected ok");
    expect(calls).toBe(2);
    expect(waits).toEqual([1200]);
    expect(res.product.title).toBe(DETAIL.title);
  });

  it("fails the flow (nothing stored) when link.generate fails after good metadata", async () => {
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
});
