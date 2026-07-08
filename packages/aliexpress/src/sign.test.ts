import { describe, expect, it } from "vitest";
import { signParams } from "./sign";

describe("signParams", () => {
  const params = {
    app_key: "512345",
    format: "json",
    method: "aliexpress.affiliate.link.generate",
    promotion_link_type: "0",
    sign_method: "sha256",
    source_values: "https://www.aliexpress.com/item/1005006123456789.html",
    timestamp: "1700000000000",
    tracking_id: "wanthat",
    v: "2.0",
  };

  it("matches the Appendix-A fixed vector (sorted key+value concat, HMAC-SHA256, hex uppercase)", () => {
    expect(signParams(params, "test-secret")).toBe(
      "5C442DF4968A603D83D688D5E1C2FC1F9B2E5498A66E419433F215C971C67B66",
    );
  });

  it("is insertion-order independent", () => {
    const shuffled = Object.fromEntries(Object.entries(params).reverse());
    expect(signParams(shuffled, "test-secret")).toBe(signParams(params, "test-secret"));
  });

  it("excludes an existing sign param from the base string", () => {
    expect(signParams({ ...params, sign: "GARBAGE" }, "test-secret")).toBe(
      signParams(params, "test-secret"),
    );
  });
});
