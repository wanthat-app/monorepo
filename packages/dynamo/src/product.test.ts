import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import { ProductRepo } from "./product";

const NOW = "2026-07-08T10:00:00.000Z";
const STORED = {
  storeId: "aliexpress",
  storeProductId: "1005006123456789",
  title: "Jebao Smart Aquarium Fish Feeder",
  imageUrl: "https://ae01.alicdn.com/kf/feeder.jpg",
  price: { amountMinor: "2612", currency: "USD" },
  commissionBps: 700,
  affiliateUrl: "https://s.click.aliexpress.com/e/_abc",
  createdAt: NOW,
  updatedAt: NOW,
};

function stub(respond: (name: string, input: Record<string, unknown>) => unknown) {
  const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
  const doc = {
    send: async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
      calls.push({ name: cmd.constructor.name, input: cmd.input });
      return respond(cmd.constructor.name, cmd.input);
    },
  } as unknown as DynamoDBDocumentClient;
  return { doc, calls };
}

describe("ProductRepo.get", () => {
  it("reads by the (storeId, storeProductId) composite key", async () => {
    const { doc, calls } = stub(() => ({ Item: STORED }));
    const repo = new ProductRepo(doc, "product");
    expect(await repo.get("aliexpress", "1005006123456789")).toEqual(STORED);
    expect(calls[0]?.input.Key).toEqual({
      storeId: "aliexpress",
      storeProductId: "1005006123456789",
    });
  });

  it("returns undefined when the product is unknown", async () => {
    const { doc } = stub(() => ({}));
    expect(await new ProductRepo(doc, "product").get("aliexpress", "42")).toBeUndefined();
  });
});

describe("ProductRepo.upsert", () => {
  it("writes metadata + affiliateUrl and preserves createdAt via if_not_exists", async () => {
    const { doc, calls } = stub(() => ({ Attributes: STORED }));
    const repo = new ProductRepo(doc, "product");
    const { createdAt: _c, updatedAt: _u, ...upsert } = STORED;
    const stored = await repo.upsert(upsert, NOW);
    expect(stored).toEqual(STORED);
    expect(calls[0]?.name).toBe("UpdateCommand");
    expect(calls[0]?.input.UpdateExpression).toContain("if_not_exists(createdAt, :now)");
    expect(calls[0]?.input.ExpressionAttributeValues).toMatchObject({
      ":affiliateUrl": STORED.affiliateUrl,
      ":now": NOW,
    });
  });

  it("rejects a malformed price before writing", async () => {
    const { doc, calls } = stub(() => ({}));
    const repo = new ProductRepo(doc, "product");
    await expect(
      repo.upsert({ ...STORED, price: { amountMinor: "26.12", currency: "USD" } } as never, NOW),
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});
