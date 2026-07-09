import {
  ConditionalCheckFailedException,
  TransactionCanceledException,
} from "@aws-sdk/client-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import { describe, expect, it } from "vitest";
import {
  RECOMMENDATION_COUNTER_PK,
  type RecommendationItem,
  RecommendationRepo,
} from "./recommendation";

const NOW = "2026-07-08T10:00:00.000Z";
const REC: RecommendationItem = {
  recommendationId: "7f1f9705-9101-5e64-a6f8-6c1f0a15b8be",
  ownerId: "sub-1234",
  storeId: "aliexpress",
  storeProductId: "1005006123456789",
  affiliateUrl: "https://s.click.aliexpress.com/e/_abc",
  title: "Jebao Smart Aquarium Fish Feeder",
  imageUrl: "https://ae01.alicdn.com/kf/feeder.jpg",
  price: { amountMinor: "2612", currency: "USD" },
  commissionBps: 700,
  cashback: { referrerBps: 5000, consumerBps: 0 },
  review: null,
  referrerFirstName: null,
  clicks: 0,
  conversions: 0,
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

describe("RecommendationItem", () => {
  it("parses a pre-referrerFirstName stored item to null (backward compat)", async () => {
    const { referrerFirstName: _drop, ...legacy } = REC;
    const { doc } = stub(() => ({ Item: legacy }));
    const item = await new RecommendationRepo(doc, "recommendation").get(REC.recommendationId);
    expect(item?.referrerFirstName).toBeNull();
  });

  it("round-trips an explicit referrerFirstName", async () => {
    const { doc } = stub(() => ({ Item: { ...REC, referrerFirstName: "Dana" } }));
    const item = await new RecommendationRepo(doc, "recommendation").get(REC.recommendationId);
    expect(item?.referrerFirstName).toBe("Dana");
  });
});

describe("RecommendationRepo.create", () => {
  it("creates first-write-wins AND increments the counter in ONE transaction", async () => {
    const { doc, calls } = stub(() => ({}));
    const repo = new RecommendationRepo(doc, "recommendation");
    const res = await repo.create(REC);
    expect(res).toEqual({ item: REC, created: true });
    expect(calls[0]?.name).toBe("TransactWriteCommand");
    const tx = calls[0]?.input.TransactItems as Array<Record<string, never>>;
    expect(tx).toHaveLength(2);
    expect(tx[0]?.Put).toMatchObject({
      ConditionExpression: "attribute_not_exists(recommendationId)",
      Item: REC,
    });
    expect(tx[1]?.Update).toMatchObject({
      Key: { recommendationId: RECOMMENDATION_COUNTER_PK },
      UpdateExpression: "ADD itemCount :one",
    });
  });

  it("returns the EXISTING item (original snapshot, no double-count) on replay", async () => {
    const existing = { ...REC, cashback: { referrerBps: 4000, consumerBps: 500 } };
    const { doc } = stub(() => {
      throw new TransactionCanceledException({
        message: "cancelled",
        $metadata: {},
        CancellationReasons: [
          { Code: "ConditionalCheckFailed", Item: marshall(existing) as never },
          { Code: "None" },
        ],
      });
    });
    const repo = new RecommendationRepo(doc, "recommendation");
    const res = await repo.create(REC);
    expect(res.created).toBe(false);
    expect(res.item.cashback).toEqual({ referrerBps: 4000, consumerBps: 500 });
  });
});

describe("RecommendationRepo.count", () => {
  it("reads the sentinel counter item (0 before the first link)", async () => {
    const { doc, calls } = stub(() => ({
      Item: { recommendationId: RECOMMENDATION_COUNTER_PK, itemCount: 7 },
    }));
    expect(await new RecommendationRepo(doc, "recommendation").count()).toBe(7);
    expect(calls[0]?.input.Key).toEqual({ recommendationId: RECOMMENDATION_COUNTER_PK });

    const empty = stub(() => ({}));
    expect(await new RecommendationRepo(empty.doc, "recommendation").count()).toBe(0);
  });
});

describe("RecommendationRepo.updateReview", () => {
  it("sets the review owner-conditionally", async () => {
    const review = { text: "so good", rating: 5 };
    const updated = { ...REC, review, updatedAt: "2026-07-08T11:00:00.000Z" };
    const { doc, calls } = stub(() => ({ Attributes: updated }));
    const repo = new RecommendationRepo(doc, "recommendation");
    const res = await repo.updateReview(
      REC.recommendationId,
      "sub-1234",
      review,
      updated.updatedAt,
    );
    expect(res?.review).toEqual(review);
    expect(calls[0]?.input.ConditionExpression).toContain("ownerId = :ownerId");
  });

  it("returns undefined when the caller is not the owner (condition fails)", async () => {
    const { doc } = stub(() => {
      throw new ConditionalCheckFailedException({ message: "denied", $metadata: {} });
    });
    const repo = new RecommendationRepo(doc, "recommendation");
    expect(await repo.updateReview(REC.recommendationId, "sub-other", null, NOW)).toBeUndefined();
  });
});

describe("RecommendationRepo.deleteByOwner", () => {
  it("deletes each item in a Delete+counter-decrement transaction (mirror of create)", async () => {
    const { doc, calls } = stub((name) =>
      name === "QueryCommand"
        ? { Items: [{ recommendationId: "rec-a" }, { recommendationId: "rec-b" }] }
        : {},
    );
    const repo = new RecommendationRepo(doc, "recommendation");
    expect(await repo.deleteByOwner("sub-1234")).toBe(2);

    expect(calls.map((c) => c.name)).toEqual([
      "QueryCommand",
      "TransactWriteCommand",
      "TransactWriteCommand",
    ]);
    expect(calls[0]?.input).toMatchObject({
      IndexName: "byOwner",
      KeyConditionExpression: "ownerId = :ownerId",
      ExpressionAttributeValues: { ":ownerId": "sub-1234" },
      ProjectionExpression: "recommendationId",
    });
    const tx = calls[1]?.input.TransactItems as Array<Record<string, never>>;
    expect(tx).toHaveLength(2);
    expect(tx[0]?.Delete).toMatchObject({
      Key: { recommendationId: "rec-a" },
      ConditionExpression: "attribute_exists(recommendationId)",
    });
    expect(tx[1]?.Update).toMatchObject({
      Key: { recommendationId: RECOMMENDATION_COUNTER_PK },
      UpdateExpression: "ADD itemCount :minusOne",
      ExpressionAttributeValues: { ":minusOne": -1 },
    });
    const tx2 = calls[2]?.input.TransactItems as Array<Record<string, never>>;
    expect(tx2[0]?.Delete).toMatchObject({ Key: { recommendationId: "rec-b" } });
  });

  it("pages through the GSI until LastEvaluatedKey is exhausted", async () => {
    let queries = 0;
    const { doc, calls } = stub((name) => {
      if (name !== "QueryCommand") return {};
      queries += 1;
      return queries === 1
        ? {
            Items: [{ recommendationId: "rec-1" }],
            LastEvaluatedKey: { recommendationId: "rec-1", ownerId: "sub-1234", createdAt: NOW },
          }
        : { Items: [{ recommendationId: "rec-2" }] };
    });
    const repo = new RecommendationRepo(doc, "recommendation");
    expect(await repo.deleteByOwner("sub-1234")).toBe(2);

    const queryCalls = calls.filter((c) => c.name === "QueryCommand");
    expect(queryCalls).toHaveLength(2);
    expect(queryCalls[0]?.input.ExclusiveStartKey).toBeUndefined();
    expect(queryCalls[1]?.input.ExclusiveStartKey).toEqual({
      recommendationId: "rec-1",
      ownerId: "sub-1234",
      createdAt: NOW,
    });
    expect(calls.filter((c) => c.name === "TransactWriteCommand")).toHaveLength(2);
  });

  it("returns 0 and writes nothing for an owner with no recommendations", async () => {
    const { doc, calls } = stub(() => ({ Items: [] }));
    const repo = new RecommendationRepo(doc, "recommendation");
    expect(await repo.deleteByOwner("sub-nobody")).toBe(0);
    expect(calls.map((c) => c.name)).toEqual(["QueryCommand"]);
  });

  it("does not count an item that vanished concurrently (transaction cancelled, counter exact)", async () => {
    const { doc, calls } = stub((name, input) => {
      if (name === "QueryCommand") {
        return { Items: [{ recommendationId: "rec-gone" }, { recommendationId: "rec-there" }] };
      }
      const tx = input.TransactItems as Array<{ Delete?: { Key: { recommendationId: string } } }>;
      if (tx[0]?.Delete?.Key.recommendationId === "rec-gone") {
        throw new TransactionCanceledException({
          message: "cancelled",
          $metadata: {},
          CancellationReasons: [{ Code: "ConditionalCheckFailed" }, { Code: "None" }],
        });
      }
      return {};
    });
    const repo = new RecommendationRepo(doc, "recommendation");
    expect(await repo.deleteByOwner("sub-1234")).toBe(1);
    expect(calls.filter((c) => c.name === "TransactWriteCommand")).toHaveLength(2);
  });

  it("rethrows a transaction failure that is NOT a conditional cancellation", async () => {
    const { doc } = stub((name) => {
      if (name === "QueryCommand") return { Items: [{ recommendationId: "rec-a" }] };
      throw new TransactionCanceledException({
        message: "cancelled",
        $metadata: {},
        CancellationReasons: [{ Code: "TransactionConflict" }, { Code: "None" }],
      });
    });
    const repo = new RecommendationRepo(doc, "recommendation");
    await expect(repo.deleteByOwner("sub-1234")).rejects.toBeInstanceOf(
      TransactionCanceledException,
    );
  });
});

describe("RecommendationRepo.listByOwner", () => {
  it("queries the byOwner GSI newest-first and passes the cursor through", async () => {
    const { doc, calls } = stub(() => ({
      Items: [REC],
      LastEvaluatedKey: { recommendationId: REC.recommendationId },
    }));
    const repo = new RecommendationRepo(doc, "recommendation");
    const page = await repo.listByOwner("sub-1234", 20, { recommendationId: "prev" });
    expect(page.items).toEqual([REC]);
    expect(page.lastKey).toEqual({ recommendationId: REC.recommendationId });
    expect(calls[0]?.input).toMatchObject({
      IndexName: "byOwner",
      ScanIndexForward: false,
      Limit: 20,
      ExclusiveStartKey: { recommendationId: "prev" },
    });
  });
});
