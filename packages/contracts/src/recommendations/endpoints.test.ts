import { describe, expect, it } from "vitest";
import {
  CreateRecommendationBody,
  ResolveProductBody,
  UpdateRecommendationBody,
} from "./endpoints";

describe("ResolveProductBody contract", () => {
  it("accepts a product URL and whole share-button text (the URL is extracted server-side)", () => {
    expect(
      ResolveProductBody.safeParse({ url: "https://he.aliexpress.com/item/1005006123456789.html" })
        .success,
    ).toBe(true);
    expect(
      ResolveProductBody.safeParse({
        url: "I just found this on AliExpress: … https://a.aliexpress.com/_c3TWMcp5",
      }).success,
    ).toBe(true);
  });

  it("rejects an empty/oversized paste", () => {
    expect(ResolveProductBody.safeParse({ url: "  " }).success).toBe(false);
    expect(ResolveProductBody.safeParse({ url: "x".repeat(4001) }).success).toBe(false);
    expect(ResolveProductBody.safeParse({}).success).toBe(false);
  });
});

describe("CreateRecommendationBody contract", () => {
  it("accepts the product key with and without a review", () => {
    const key = { storeId: "aliexpress", storeProductId: "1005006123456789" };
    expect(CreateRecommendationBody.safeParse(key).success).toBe(true);
    expect(
      CreateRecommendationBody.safeParse({ ...key, review: { text: "great feeder" } }).success,
    ).toBe(true);
  });

  it("rejects an unknown store", () => {
    expect(
      CreateRecommendationBody.safeParse({ storeId: "amazon", storeProductId: "B00X" }).success,
    ).toBe(false);
  });
});

describe("UpdateRecommendationBody contract", () => {
  it("accepts setting and clearing the review", () => {
    expect(
      UpdateRecommendationBody.safeParse({ review: { text: "so good", rating: 5 } }).success,
    ).toBe(true);
    expect(UpdateRecommendationBody.safeParse({ review: null }).success).toBe(true);
  });

  it("rejects an empty review text and a missing review field", () => {
    expect(UpdateRecommendationBody.safeParse({ review: { text: "" } }).success).toBe(false);
    expect(UpdateRecommendationBody.safeParse({}).success).toBe(false);
  });
});
