import { describe, expect, it } from "vitest";
import { GenerateLinkRequest, GenerateLinkResponse } from "./proxy";

describe("GenerateLinkRequest contract", () => {
  it("accepts a generateLink invoke for a supported retailer", () => {
    expect(
      GenerateLinkRequest.safeParse({
        op: "generateLink",
        retailer: "aliexpress",
        url: "https://www.aliexpress.com/item/1005006123456789.html",
      }).success,
    ).toBe(true);
  });

  it("rejects unknown ops and retailers", () => {
    expect(
      GenerateLinkRequest.safeParse({
        op: "listOrders",
        retailer: "aliexpress",
        url: "https://x.y",
      }).success,
    ).toBe(false);
    expect(
      GenerateLinkRequest.safeParse({ op: "generateLink", retailer: "amazon", url: "https://x.y" })
        .success,
    ).toBe(false);
  });
});

describe("GenerateLinkResponse contract", () => {
  it("parses an ok result with a wire-string price into bigint minor units", () => {
    const parsed = GenerateLinkResponse.parse({
      status: "ok",
      product: {
        storeId: "aliexpress",
        storeProductId: "1005006123456789",
        title: "Jebao Smart Aquarium Fish Feeder",
        imageUrl: "https://ae01.alicdn.com/kf/feeder.jpg",
        price: { amountMinor: "2612", currency: "USD" },
        commissionBps: 700,
        createdAt: "2026-07-08T10:00:00.000Z",
        updatedAt: "2026-07-08T10:00:00.000Z",
      },
      affiliateUrl: "https://s.click.aliexpress.com/e/_abc123",
    });
    if (parsed.status !== "ok") throw new Error("expected ok");
    expect(parsed.product.price?.amountMinor).toBe(2612n);
  });

  it("parses error results and rejects unknown codes", () => {
    expect(
      GenerateLinkResponse.safeParse({ status: "error", code: "retailer_not_configured" }).success,
    ).toBe(true);
    expect(GenerateLinkResponse.safeParse({ status: "error", code: "nope" }).success).toBe(false);
  });
});
