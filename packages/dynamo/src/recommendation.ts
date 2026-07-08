import {
  ConditionalCheckFailedException,
  TransactionCanceledException,
} from "@aws-sdk/client-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { existingFromCancellation } from "./product";

const MoneyItem = z.object({
  amountMinor: z.string().regex(/^-?\d+$/),
  currency: z.string().regex(/^[A-Z]{3}$/),
});

const ReviewItem = z.object({
  rating: z.number().int().min(1).max(5).optional(),
  text: z.string().min(1),
});

/**
 * The stored recommendation projection (ADR-0003/0007): a member's shareable rec of a product,
 * PK `recommendationId`, GSI `byOwner` (`ownerId`, `createdAt`). `ownerId` is the member's
 * canonical id — the Cognito sub (ADR-0020) — so the create path stays Aurora-free (ADR-0004).
 * The product fields (+ `affiliateUrl`) are denormalised so the landing redirect resolves in
 * ONE lookup (ADR-0007), and `cashback` is the split snapshot that LOCKS the link's economics
 * at creation (ADR-0008). `clicks`/`conversions` are fed by the funnel (later slice).
 *
 * FUTURE (agreed 2026-07-09): two DynamoDB reads per resolve are acceptable, so the duplicated
 * product metadata (`title`/`imageUrl`/`price`/`commissionBps`) may be normalised into a second
 * Product-table read when a real need appears (metadata refresh, moderation). `affiliateUrl` and
 * the `cashback` snapshot stay HERE either way — they are point-in-time state of the link, not
 * catalog data. No rework now.
 */
export const RecommendationItem = z.object({
  recommendationId: z.string(),
  ownerId: z.string(),
  storeId: z.string(),
  storeProductId: z.string(),
  affiliateUrl: z.string(),
  title: z.string(),
  imageUrl: z.string().nullable(),
  price: MoneyItem.nullable(),
  commissionBps: z.number().int(),
  cashback: z.object({
    referrerBps: z.number().int(),
    consumerBps: z.number().int(),
  }),
  review: ReviewItem.nullable(),
  clicks: z.number().int(),
  conversions: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type RecommendationItem = z.infer<typeof RecommendationItem>;

export interface RecommendationPage {
  items: RecommendationItem[];
  /** Raw DynamoDB LastEvaluatedKey — the caller encodes it into an opaque cursor. */
  lastKey: Record<string, unknown> | undefined;
}

/**
 * Sentinel PK of the counter item: `{ recommendationId: "#counter", itemCount: N }`. `#` sits
 * outside the recommendation-id alphabet (base62 / legacy uuid), and the item carries no
 * `ownerId`/`createdAt`, so the `byOwner` GSI (and any future time GSI) excludes it — sparse
 * index. Incremented in the SAME transaction as the conditional create: exact by construction.
 */
export const RECOMMENDATION_COUNTER_PK = "#counter";

/** Repository over the `recommendation` table (ADR-0003). */
export class RecommendationRepo {
  constructor(
    private readonly doc: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  /**
   * First-write-wins create + counter increment, atomically (one TransactWriteItems). The caller
   * derives `recommendationId` deterministically from (owner, product), so a replay lands on the
   * same key: the whole transaction cancels — no double-count — and `created: false` returns the
   * EXISTING item (with its original cashback snapshot — ADR-0008 locks economics at creation).
   */
  async create(item: RecommendationItem): Promise<{ item: RecommendationItem; created: boolean }> {
    const validated = RecommendationItem.parse(item);
    try {
      await this.doc.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.tableName,
                Item: validated,
                ConditionExpression: "attribute_not_exists(recommendationId)",
                ReturnValuesOnConditionCheckFailure: "ALL_OLD",
              },
            },
            {
              Update: {
                TableName: this.tableName,
                Key: { recommendationId: RECOMMENDATION_COUNTER_PK },
                UpdateExpression: "ADD itemCount :one",
                ExpressionAttributeValues: { ":one": 1 },
              },
            },
          ],
        }),
      );
      return { item: validated, created: true };
    } catch (err) {
      const existing = existingFromCancellation(err);
      if (existing) return { item: RecommendationItem.parse(existing), created: false };
      throw err;
    }
  }

  /** Exact number of stored recommendations (the transactional counter item). */
  async count(): Promise<number> {
    const res = await this.doc.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { recommendationId: RECOMMENDATION_COUNTER_PK },
      }),
    );
    return Number(res.Item?.itemCount ?? 0);
  }

  async get(recommendationId: string): Promise<RecommendationItem | undefined> {
    const res = await this.doc.send(
      new GetCommand({ TableName: this.tableName, Key: { recommendationId } }),
    );
    return res.Item ? RecommendationItem.parse(res.Item) : undefined;
  }

  /**
   * Set or clear the owner's review. Owner-conditional: a mismatching caller (or a missing item)
   * gets `undefined`, indistinguishable from not-found by design.
   */
  async updateReview(
    recommendationId: string,
    ownerId: string,
    review: z.infer<typeof ReviewItem> | null,
    updatedAt: string,
  ): Promise<RecommendationItem | undefined> {
    try {
      const res = await this.doc.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { recommendationId },
          UpdateExpression: "SET review = :review, updatedAt = :updatedAt",
          ConditionExpression: "attribute_exists(recommendationId) AND ownerId = :ownerId",
          ExpressionAttributeValues: {
            ":review": review === null ? null : ReviewItem.parse(review),
            ":updatedAt": updatedAt,
            ":ownerId": ownerId,
          },
          ReturnValues: "ALL_NEW",
        }),
      );
      return RecommendationItem.parse(res.Attributes);
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) return undefined;
      throw err;
    }
  }

  /** "List my recommendations" (ADR-0003): the `byOwner` GSI read newest-first. */
  async listByOwner(
    ownerId: string,
    limit: number,
    startKey?: Record<string, unknown>,
  ): Promise<RecommendationPage> {
    const res = await this.doc.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: "byOwner",
        KeyConditionExpression: "ownerId = :ownerId",
        ExpressionAttributeValues: { ":ownerId": ownerId },
        ScanIndexForward: false,
        Limit: limit,
        ExclusiveStartKey: startKey,
      }),
    );
    return {
      items: (res.Items ?? []).map((item) => RecommendationItem.parse(item)),
      lastKey: res.LastEvaluatedKey,
    };
  }

  /**
   * Delete EVERY recommendation of `ownerId` (user erasure — ADR-0006 §8). Pages through the
   * `byOwner` GSI (keys only), then deletes each item in a per-item TransactWriteItems that pairs
   * the existence-conditional Delete with a counter `ADD itemCount -1` — the exact mirror of
   * `create`'s conditional Put + `ADD itemCount 1`, so the sentinel counter stays exact by
   * construction: a concurrently-vanished item cancels the WHOLE transaction (no decrement, not
   * counted). Returns the number actually deleted.
   */
  async deleteByOwner(ownerId: string): Promise<number> {
    let deleted = 0;
    let startKey: Record<string, unknown> | undefined;
    do {
      const res = await this.doc.send(
        new QueryCommand({
          TableName: this.tableName,
          IndexName: "byOwner",
          KeyConditionExpression: "ownerId = :ownerId",
          ExpressionAttributeValues: { ":ownerId": ownerId },
          ProjectionExpression: "recommendationId",
          ExclusiveStartKey: startKey,
        }),
      );
      for (const item of res.Items ?? []) {
        const { recommendationId } = z.object({ recommendationId: z.string() }).parse(item);
        try {
          await this.doc.send(
            new TransactWriteCommand({
              TransactItems: [
                {
                  Delete: {
                    TableName: this.tableName,
                    Key: { recommendationId },
                    ConditionExpression: "attribute_exists(recommendationId)",
                  },
                },
                {
                  Update: {
                    TableName: this.tableName,
                    Key: { recommendationId: RECOMMENDATION_COUNTER_PK },
                    UpdateExpression: "ADD itemCount :minusOne",
                    ExpressionAttributeValues: { ":minusOne": -1 },
                  },
                },
              ],
            }),
          );
          deleted += 1;
        } catch (err) {
          // The item vanished between the GSI read and the delete: the conditional cancels the
          // whole transaction (counter untouched). Anything else is a real failure.
          if (!isConditionalCancellation(err)) throw err;
        }
      }
      startKey = res.LastEvaluatedKey;
    } while (startKey);
    return deleted;
  }
}

/** True when a TransactWriteItems was cancelled by one of its ConditionExpressions. */
function isConditionalCancellation(err: unknown): boolean {
  return (
    err instanceof TransactionCanceledException &&
    (err.CancellationReasons ?? []).some((r) => r.Code === "ConditionalCheckFailed")
  );
}
