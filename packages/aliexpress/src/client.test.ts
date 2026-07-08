import { describe, expect, it } from "vitest";
import {
  AliExpressApiError,
  AliExpressClient,
  commissionRateToBps,
  decimalToMinor,
} from "./client";
import { signParams } from "./sign";

const PRODUCT_URL = "https://www.aliexpress.com/item/1005006123456789.html";

function fakeFetch(body: unknown, capture?: { params?: URLSearchParams }): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    if (capture) capture.params = new URLSearchParams(String(init?.body));
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

function client(body: unknown, capture?: { params?: URLSearchParams }): AliExpressClient {
  return new AliExpressClient({
    appKey: "512345",
    appSecret: "test-secret",
    trackingId: "wanthat",
    fetchFn: fakeFetch(body, capture),
    now: () => 1700000000000,
  });
}

describe("generatePromotionLink", () => {
  const okBody = {
    aliexpress_affiliate_link_generate_response: {
      resp_result: {
        result: {
          promotion_links: {
            promotion_link: [
              {
                source_value: PRODUCT_URL,
                promotion_link: "https://s.click.aliexpress.com/e/_abc",
              },
            ],
          },
        },
      },
    },
  };

  it("signs the request and returns the promotion link", async () => {
    const capture: { params?: URLSearchParams } = {};
    const link = await client(okBody, capture).generatePromotionLink(PRODUCT_URL);
    expect(link).toBe("https://s.click.aliexpress.com/e/_abc");

    const params = capture.params;
    if (!params) throw new Error("request not captured");
    expect(params.get("method")).toBe("aliexpress.affiliate.link.generate");
    expect(params.get("promotion_link_type")).toBe("0");
    expect(params.get("source_values")).toBe(PRODUCT_URL);
    expect(params.get("tracking_id")).toBe("wanthat");
    expect(params.get("sign_method")).toBe("sha256");
    // The signature covers exactly the sent params (recompute over everything except sign).
    const sent: Record<string, string> = {};
    for (const [k, v] of params.entries()) if (k !== "sign") sent[k] = v;
    expect(params.get("sign")).toBe(signParams(sent, "test-secret"));
  });

  it("throws a typed error on a platform error_response", async () => {
    const err = client({ error_response: { code: "27", msg: "invalid signature" } });
    await expect(err.generatePromotionLink(PRODUCT_URL)).rejects.toThrowError(AliExpressApiError);
  });

  it("throws when the result carries no link", async () => {
    const empty = client({
      aliexpress_affiliate_link_generate_response: { resp_result: { result: {} } },
    });
    await expect(empty.generatePromotionLink(PRODUCT_URL)).rejects.toThrowError(AliExpressApiError);
  });
});

describe("getProductDetail", () => {
  it("maps title/image/price/commission from the nested payload", async () => {
    const detail = await client({
      aliexpress_affiliate_productdetail_get_response: {
        resp_result: {
          result: {
            products: {
              product: [
                {
                  product_title: "Jebao Smart Aquarium Fish Feeder",
                  product_main_image_url: "https://ae01.alicdn.com/kf/feeder.jpg",
                  target_sale_price: "26.12",
                  target_sale_price_currency: "USD",
                  commission_rate: "7.0%",
                },
              ],
            },
          },
        },
      },
    }).getProductDetail("1005006123456789");
    expect(detail).toEqual({
      title: "Jebao Smart Aquarium Fish Feeder",
      imageUrl: "https://ae01.alicdn.com/kf/feeder.jpg",
      priceMinor: "2612",
      priceCurrency: "USD",
      commissionBps: 700,
    });
  });

  it("throws when no product comes back", async () => {
    const empty = client({
      aliexpress_affiliate_productdetail_get_response: { resp_result: { result: {} } },
    });
    await expect(empty.getProductDetail("1")).rejects.toThrowError(AliExpressApiError);
  });

  it("ships to IL (region-scoped items answer empty without a country)", async () => {
    const capture: { params?: URLSearchParams } = {};
    await client(
      {
        aliexpress_affiliate_productdetail_get_response: {
          resp_result: { result: { products: { product: [{ product_title: "x" }] } } },
        },
      },
      capture,
    ).getProductDetail("1005006123456789");
    expect(capture.params?.get("country")).toBe("IL");
  });

  it("surfaces resp_code/resp_msg/record count in the empty-result error", async () => {
    const empty = client({
      aliexpress_affiliate_productdetail_get_response: {
        resp_result: {
          resp_code: 405,
          resp_msg: "product not found",
          result: { current_record_count: 0 },
        },
      },
    });
    await expect(empty.getProductDetail("1")).rejects.toThrowError(
      /resp_code=405.*resp_msg="product not found".*records=0/,
    );
  });
});

describe("commissionRateToBps", () => {
  it.each([
    ["7.0%", 700],
    ["7.5", 750],
    [8, 800],
    ["0", 0],
    ["150", 10_000], // clamped to the Bps ceiling
  ])("maps %s to %d bps", (rate, bps) => {
    expect(commissionRateToBps(rate)).toBe(bps);
  });

  it("returns null for missing or malformed rates", () => {
    expect(commissionRateToBps(undefined)).toBeNull();
    expect(commissionRateToBps("n/a")).toBeNull();
    expect(commissionRateToBps("-3")).toBeNull();
  });
});

describe("decimalToMinor", () => {
  it.each([
    ["26.12", "2612"],
    ["26.1", "2610"],
    ["26", "2600"],
    ["0.05", "5"],
  ])("converts %s to %s minor units", (price, minor) => {
    expect(decimalToMinor(price)).toBe(minor);
  });

  it("returns null for malformed prices", () => {
    expect(decimalToMinor(undefined)).toBeNull();
    expect(decimalToMinor("US $26.12")).toBeNull();
    expect(decimalToMinor("-5")).toBeNull();
  });
});
