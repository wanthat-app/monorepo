import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { z } from "zod";

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
 * Cognito sub — the create path must stay Aurora-free (ADR-0004), so no customer-row lookup.
 * The product fields (+ `affiliateUrl`) are denormalised so the landing redirect resolves in
 * ONE lookup (ADR-0007), and `cashback` is the split snapshot that LOCKS the link's economics
 * at creation (ADR-0008). `clicks`/`conversions` are fed by the funnel (later slice).
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

/** Repository over the `recommendation` table (ADR-0003). */
export class RecommendationRepo {
  constructor(
    private readonly doc: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  /**
   * First-write-wins create. The caller derives `recommendationId` deterministically from
   * (owner, product), so a replay lands on the same key: `created: false` returns the EXISTING
   * item (with its original cashback snapshot — ADR-0008 locks economics at first creation).
   */
  async create(item: RecommendationItem): Promise<{ item: RecommendationItem; created: boolean }> {
    const validated = RecommendationItem.parse(item);
    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.tableName,
          Item: validated,
          ConditionExpression: "attribute_not_exists(recommendationId)",
          ReturnValuesOnConditionCheckFailure: "ALL_OLD",
        }),
      );
      return { item: validated, created: true };
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException && err.Item) {
        // The doc client leaves the failure payload marshalled — unwrap it before parsing.
        return {
          item: RecommendationItem.parse(unmarshall(err.Item as never)),
          created: false,
        };
      }
      throw err;
    }
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
}
