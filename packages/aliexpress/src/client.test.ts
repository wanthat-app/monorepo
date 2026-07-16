import { describe, expect, it } from "vitest";
import {
  AliExpressApiError,
  AliExpressClient,
  commissionRateToBps,
  decimalToMinor,
  integerMinor,
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

function client(
  body: unknown,
  capture?: { params?: URLSearchParams },
  options?: { debugPayloads?: boolean },
): AliExpressClient {
  return new AliExpressClient({
    appKey: "512345",
    appSecret: "test-secret",
    trackingId: "wanthat",
    fetchFn: fakeFetch(body, capture),
    now: () => 1700000000000,
    ...options,
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

  it("answers empty_result ONLY for a well-formed empty response (a definitive miss)", async () => {
    const empty = client({
      aliexpress_affiliate_productdetail_get_response: { resp_result: { result: {} } },
    });
    await expect(empty.getProductDetail("1")).rejects.toMatchObject({ code: "empty_result" });
  });

  it("reads a zero-record answer with an EMPTY products object as a definitive miss", async () => {
    // Verbatim prod answer for a not-in-catalog product (2026-07-16, id 1005008735450412):
    // zero records serialize as `products: {}` — no `product` array. Must be empty_result
    // (-> the SPA's "not in the affiliate catalog"), not malformed_result.
    const notInCatalog = client({
      aliexpress_affiliate_productdetail_get_response: {
        resp_result: { result: { current_record_count: 0, products: {} }, resp_code: 200 },
        request_id: "2151e4fa17841966686116244",
      },
    });
    await expect(notInCatalog.getProductDetail("1005008735450412")).rejects.toMatchObject({
      code: "empty_result",
    });
    const err = await notInCatalog
      .getProductDetail("1005008735450412")
      .catch((e: Error) => e as AliExpressApiError);
    expect((err as Error).message).toMatch(/resp_code=200.*records=0/);
  });

  it("answers malformed_result for an unrecognized payload (NOT a definitive miss)", async () => {
    const garbage = client({ something: "else entirely" });
    await expect(garbage.getProductDetail("1")).rejects.toMatchObject({
      code: "malformed_result",
    });
  });

  it("carries the unrecognized payload in the malformed_result message when debug is ON", async () => {
    const garbage = client({ something: "else entirely" }, undefined, { debugPayloads: true });
    await expect(garbage.getProductDetail("1")).rejects.toThrowError(/"something":"else entirely"/);
  });

  it("omits the payload by default (third-party data stays out of logs unless investigating)", async () => {
    const garbage = client({ something: "else entirely" });
    const err = await garbage.getProductDetail("1").catch((e: Error) => e);
    expect(err).toMatchObject({ code: "malformed_result" });
    expect((err as Error).message).not.toContain("else entirely");
  });

  it("truncates a huge unrecognized payload instead of blowing up the log line", async () => {
    const huge = client({ blob: "x".repeat(10_000) }, undefined, { debugPayloads: true });
    const err = await huge.getProductDetail("1").catch((e: Error) => e);
    expect(err).toBeInstanceOf(AliExpressApiError);
    expect((err as Error).message.length).toBeLessThan(3_000);
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

describe("integerMinor", () => {
  it("passes integer cent values through (numbers and strings)", () => {
    expect(integerMinor(37)).toBe("37");
    expect(integerMinor("93")).toBe("93");
    expect(integerMinor(0)).toBe("0");
  });

  it("nulls anything that is not a plain integer - money never guesses a scale", () => {
    expect(integerMinor(undefined)).toBeNull();
    expect(integerMinor("1.24")).toBeNull();
    expect(integerMinor(1.24)).toBeNull();
    expect(integerMinor("-5")).toBeNull();
    expect(integerMinor("US $26")).toBeNull();
  });
});

describe("listOrdersByIndex", () => {
  const order = (over: Record<string, unknown> = {}) => ({
    order_id: 8123456789,
    order_status: "Payment Completed",
    custom_parameters: '{"ref":"abc123DEF45","c":"11111111-1111-1111-1111-111111111111"}',
    estimated_paid_commission: 124,
    order_commission_currency: "USD",
    paid_time: "2026-07-10 12:00:00",
    unknown_extra_field: true,
    ...over,
  });
  const productOrder = () =>
    order({
      product_id: 1005004280800180,
      product_title: "8K HDMI Cable",
      product_main_image_url: "https://ae-pic-a1.aliexpress-media.com/kf/img.jpg",
      product_detail_url: "https://www.aliexpress.com/item/1005004280800180.html",
      product_count: 1,
      paid_amount: 535,
      commission_rate: "7.00%",
      sub_order_id: 1121635427136421,
    });
  const okBody = (orders: unknown[], nextId?: string) => ({
    aliexpress_affiliate_order_listbyindex_response: {
      resp_result: {
        result: {
          orders: { order: orders },
          ...(nextId ? { next_query_index_id: nextId } : {}),
          current_record_count: orders.length,
        },
      },
    },
  });

  it("signs the request with the window, status, tracking id and cursor", async () => {
    const capture: { params?: URLSearchParams } = {};
    await client(okBody([order()]), capture).listOrdersByIndex({
      startTime: "2026-07-07 08:00:00",
      endTime: "2026-07-10 08:00:00",
      status: "Payment Completed",
      startQueryIndexId: "cursor-1",
      pageSize: 50,
    });
    const params = capture.params;
    if (!params) throw new Error("request not captured");
    expect(params.get("method")).toBe("aliexpress.affiliate.order.listbyindex");
    expect(params.get("start_time")).toBe("2026-07-07 08:00:00");
    expect(params.get("end_time")).toBe("2026-07-10 08:00:00");
    expect(params.get("status")).toBe("Payment Completed");
    expect(params.get("start_query_index_id")).toBe("cursor-1");
    expect(params.get("page_size")).toBe("50");
    expect(params.get("tracking_id")).toBe("wanthat");
    expect(params.get("sign")).toBeTruthy();
  });

  it("parses orders: commission is ALREADY integer minor units, raw custom params, cursor", async () => {
    const page = await client(okBody([order()], "cursor-2")).listOrdersByIndex({
      startTime: "a",
      endTime: "b",
      status: "Payment Completed",
    });
    expect(page.orders).toEqual([
      {
        orderId: "8123456789",
        status: "Payment Completed",
        customParameters: '{"ref":"abc123DEF45","c":"11111111-1111-1111-1111-111111111111"}',
        commissionMinor: "124",
        commissionCurrency: "USD",
        orderTimeGmt8: "2026-07-10 12:00:00",
        productId: null,
        productTitle: null,
        productImageUrl: null,
        productDetailUrl: null,
        productCount: null,
        paidAmountMinor: null,
        commissionRate: null,
        subOrderId: null,
      },
    ]);
    expect(page.nextQueryIndexId).toBe("cursor-2");
  });

  it("tolerates alternate field names and missing custom parameters", async () => {
    const page = await client(
      okBody([
        order({
          order_id: undefined,
          order_number: "9000000001",
          custom_parameters: undefined,
          estimated_paid_commission: undefined,
          paid_commission: "50",
          paid_time: undefined,
        }),
      ]),
    ).listOrdersByIndex({ startTime: "a", endTime: "b", status: "x" });
    expect(page.orders[0]).toMatchObject({
      orderId: "9000000001",
      customParameters: null,
      commissionMinor: "50",
      orderTimeGmt8: null,
    });
  });

  it("carries the product context for the admin cross-reference (paid amount = integer cents)", async () => {
    const page = await client(okBody([productOrder()])).listOrdersByIndex({
      startTime: "a",
      endTime: "b",
      status: "x",
    });
    expect(page.orders[0]).toMatchObject({
      productId: "1005004280800180",
      productTitle: "8K HDMI Cable",
      productImageUrl: "https://ae-pic-a1.aliexpress-media.com/kf/img.jpg",
      productDetailUrl: "https://www.aliexpress.com/item/1005004280800180.html",
      productCount: 1,
      paidAmountMinor: "535",
      commissionRate: "7.00%",
      subOrderId: "1121635427136421",
    });
  });

  it("returns an empty page (not a throw) for an empty window, and null cursor when done", async () => {
    const page = await client(okBody([])).listOrdersByIndex({
      startTime: "a",
      endTime: "b",
      status: "x",
    });
    expect(page).toEqual({ orders: [], nextQueryIndexId: null });
  });

  it("throws the typed platform error on error_response", async () => {
    await expect(
      client({ error_response: { code: "ApiCallLimit", msg: "too fast" } }).listOrdersByIndex({
        startTime: "a",
        endTime: "b",
        status: "x",
      }),
    ).rejects.toMatchObject({ code: "ApiCallLimit" });
  });
});
