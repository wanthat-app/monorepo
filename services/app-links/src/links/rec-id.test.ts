import { describe, expect, it } from "vitest";
import { recommendationIdFor } from "./rec-id";

describe("recommendationIdFor", () => {
  it("is deterministic on (owner, product) — the idempotency key", () => {
    const a = recommendationIdFor("sub-1", "aliexpress", "1005006123456789");
    const b = recommendationIdFor("sub-1", "aliexpress", "1005006123456789");
    expect(a).toBe(b);
  });

  it("differs across owners and across products", () => {
    const base = recommendationIdFor("sub-1", "aliexpress", "1005006123456789");
    expect(recommendationIdFor("sub-2", "aliexpress", "1005006123456789")).not.toBe(base);
    expect(recommendationIdFor("sub-1", "aliexpress", "42")).not.toBe(base);
  });

  it("is always 11 URL-safe base62 chars (the contract's RecommendationId shape)", () => {
    for (const owner of ["sub-1", "sub-2", "11111111-1111-1111-1111-111111111111"]) {
      expect(recommendationIdFor(owner, "aliexpress", "1")).toMatch(/^[0-9A-Za-z]{11}$/);
    }
  });
});
