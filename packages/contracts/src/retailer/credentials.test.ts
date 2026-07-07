import { describe, expect, it } from "vitest";
import { PutRetailerCredentialsBody, RetailerCredentialsStatus } from "./credentials";

describe("PutRetailerCredentialsBody contract", () => {
  it("accepts an app key + secret pair and trims surrounding whitespace", () => {
    const ok = PutRetailerCredentialsBody.safeParse({
      appKey: " 512345 ",
      appSecret: " a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4 ",
    });
    expect(ok.success).toBe(true);
    if (ok.success) {
      expect(ok.data.appKey).toBe("512345");
      expect(ok.data.appSecret).toBe("a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4");
    }
  });

  it("rejects when either field is missing or blank", () => {
    expect(PutRetailerCredentialsBody.safeParse({ appKey: "512345" }).success).toBe(false);
    expect(PutRetailerCredentialsBody.safeParse({ appSecret: "s" }).success).toBe(false);
    expect(PutRetailerCredentialsBody.safeParse({ appKey: "   ", appSecret: "s" }).success).toBe(
      false,
    );
    expect(PutRetailerCredentialsBody.safeParse({ appKey: "k", appSecret: "" }).success).toBe(
      false,
    );
  });

  it("rejects oversized values", () => {
    expect(
      PutRetailerCredentialsBody.safeParse({ appKey: "k".repeat(201), appSecret: "s" }).success,
    ).toBe(false);
    expect(
      PutRetailerCredentialsBody.safeParse({ appKey: "k", appSecret: "s".repeat(501) }).success,
    ).toBe(false);
  });
});

describe("RetailerCredentialsStatus contract", () => {
  it("accepts configured-with-timestamp and not-configured shapes", () => {
    expect(
      RetailerCredentialsStatus.safeParse({
        configured: true,
        lastUpdatedAt: "2026-07-07T12:00:00.000Z",
      }).success,
    ).toBe(true);
    expect(
      RetailerCredentialsStatus.safeParse({ configured: false, lastUpdatedAt: null }).success,
    ).toBe(true);
  });

  it("has no field that could carry a credential value", () => {
    const parsed = RetailerCredentialsStatus.safeParse({
      configured: true,
      lastUpdatedAt: null,
      appKey: "leak",
      appSecret: "leak",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(Object.keys(parsed.data).sort()).toEqual(["configured", "lastUpdatedAt"]);
    }
  });
});
