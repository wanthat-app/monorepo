import { describe, expect, it } from "vitest";
import {
  CreateRecommendationBody,
  ResolveProductBody,
  UpdateRecommendationBody,
} from "./endpoints";

describe("ResolveProductBody contract", () => {
  it("accepts a product URL", () => {
    expect(
      ResolveProductBody.safeParse({ url: "https://he.aliexpress.com/item/1005006123456789.html" })
        .success,
    ).toBe(true);
  });

  it("rejects a non-URL", () => {
    expect(ResolveProductBody.safeParse({ url: "not a url" }).success).toBe(false);
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
