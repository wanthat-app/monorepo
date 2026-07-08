import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import { describe, expect, it } from "vitest";
import { type RecommendationItem, RecommendationRepo } from "./recommendation";

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

describe("RecommendationRepo.create", () => {
  it("creates first-write-wins with a not-exists condition", async () => {
    const { doc, calls } = stub(() => ({}));
    const repo = new RecommendationRepo(doc, "recommendation");
    const res = await repo.create(REC);
    expect(res).toEqual({ item: REC, created: true });
    expect(calls[0]?.name).toBe("PutCommand");
    expect(calls[0]?.input.ConditionExpression).toBe("attribute_not_exists(recommendationId)");
  });

  it("returns the EXISTING item (original snapshot) when the id was already created", async () => {
    const existing = { ...REC, cashback: { referrerBps: 4000, consumerBps: 500 } };
    const { doc } = stub(() => {
      throw new ConditionalCheckFailedException({
        message: "exists",
        $metadata: {},
        Item: marshall(existing) as never,
      });
    });
    const repo = new RecommendationRepo(doc, "recommendation");
    const res = await repo.create(REC);
    expect(res.created).toBe(false);
    expect(res.item.cashback).toEqual({ referrerBps: 4000, consumerBps: 500 });
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
