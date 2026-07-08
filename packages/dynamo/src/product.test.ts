import { TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import { describe, expect, it } from "vitest";
import { PRODUCT_COUNTER_SK, ProductRepo } from "./product";

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
const { createdAt: _c, updatedAt: _u, ...UPSERT } = STORED;

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
  it("reads by the (storeId, storeProductId) composite key, strongly consistent", async () => {
    const { doc, calls } = stub(() => ({ Item: STORED }));
    const repo = new ProductRepo(doc, "product");
    expect(await repo.get("aliexpress", "1005006123456789")).toEqual(STORED);
    expect(calls[0]?.input.Key).toEqual({
      storeId: "aliexpress",
      storeProductId: "1005006123456789",
    });
    expect(calls[0]?.input.ConsistentRead).toBe(true);
  });

  it("returns undefined when the product is unknown", async () => {
    const { doc } = stub(() => ({}));
    expect(await new ProductRepo(doc, "product").get("aliexpress", "42")).toBeUndefined();
  });
});

describe("ProductRepo.create", () => {
  it("creates conditionally AND increments the counter in ONE transaction", async () => {
    const { doc, calls } = stub(() => ({}));
    const repo = new ProductRepo(doc, "product");
    const res = await repo.create(UPSERT, NOW);
    expect(res).toEqual({ item: STORED, created: true });
    expect(calls[0]?.name).toBe("TransactWriteCommand");
    const tx = calls[0]?.input.TransactItems as Array<Record<string, never>>;
    expect(tx).toHaveLength(2);
    expect(tx[0]?.Put).toMatchObject({
      ConditionExpression: "attribute_not_exists(storeId)",
      Item: STORED,
    });
    expect(tx[1]?.Update).toMatchObject({
      Key: { storeId: "aliexpress", storeProductId: PRODUCT_COUNTER_SK },
      UpdateExpression: "ADD itemCount :one",
    });
  });

  it("returns the WINNER's row without counting when a concurrent mint got there first", async () => {
    const winner = { ...STORED, title: "The winner's copy" };
    const { doc } = stub(() => {
      throw new TransactionCanceledException({
        message: "cancelled",
        $metadata: {},
        CancellationReasons: [
          { Code: "ConditionalCheckFailed", Item: marshall(winner) as never },
          { Code: "None" },
        ],
      });
    });
    const repo = new ProductRepo(doc, "product");
    const res = await repo.create(UPSERT, NOW);
    expect(res.created).toBe(false);
    expect(res.item.title).toBe("The winner's copy");
  });

  it("rejects a malformed price before writing", async () => {
    const { doc, calls } = stub(() => ({}));
    const repo = new ProductRepo(doc, "product");
    await expect(
      repo.create({ ...UPSERT, price: { amountMinor: "26.12", currency: "USD" } } as never, NOW),
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});

describe("ProductRepo.count", () => {
  it("reads the sentinel counter item", async () => {
    const { doc, calls } = stub(() => ({
      Item: { storeId: "aliexpress", storeProductId: PRODUCT_COUNTER_SK, itemCount: 41 },
    }));
    expect(await new ProductRepo(doc, "product").count("aliexpress")).toBe(41);
    expect(calls[0]?.input.Key).toEqual({
      storeId: "aliexpress",
      storeProductId: PRODUCT_COUNTER_SK,
    });
  });

  it("answers 0 before the first product ever minted", async () => {
    const { doc } = stub(() => ({}));
    expect(await new ProductRepo(doc, "product").count("aliexpress")).toBe(0);
  });
});
