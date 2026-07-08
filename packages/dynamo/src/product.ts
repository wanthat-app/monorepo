import { TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import type { StoreId } from "@wanthat/contracts";
import { z } from "zod";

/**
 * Wire form of a Money amount as stored in DynamoDB: integer minor units as a decimal STRING
 * (DynamoDB documents can't carry bigint; the contracts `Money` schema accepts this string and
 * yields bigint at the API boundary).
 */
const MoneyItem = z.object({
  amountMinor: z.string().regex(/^-?\d+$/),
  currency: z.string().regex(/^[A-Z]{3}$/),
});

/**
 * Sentinel sort key of the per-store counter item: `{ storeId, storeProductId: "#counter",
 * itemCount: N }`. `#` sits outside the product-id alphabet (`\d{6,20}`), so it can never
 * collide with a real product, and the item carries no `createdAt` — a future time-ordering GSI
 * excludes it for free (sparse index). Incremented in the SAME transaction as the conditional
 * create, so the count exactly equals the number of stored products at all times.
 */
export const PRODUCT_COUNTER_SK = "#counter";

/**
 * The stored shared product (ADR-0003): the contract `Product` fields plus the product-level
 * `affiliateUrl` (redirect-internal — minted once per product, ADR-0008, never exposed via the
 * API). Keyed `(storeId, storeProductId)`.
 */
export const ProductItem = z.object({
  storeId: z.string(),
  storeProductId: z.string(),
  title: z.string(),
  imageUrl: z.string().nullable(),
  price: MoneyItem.nullable(),
  commissionBps: z.number().int(),
  affiliateUrl: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ProductItem = z.infer<typeof ProductItem>;

/** What a mint writes; timestamps are managed by the repo. */
export type ProductUpsert = Omit<ProductItem, "createdAt" | "updatedAt">;

/**
 * Repository over the `product` table (ADR-0003) — the shared catalog item, minted once and
 * reused across every member who recommends it. Rows are written create-once with everything in
 * hand (all-or-nothing, 2026-07-08 decision) — there is no partial state and no refresh path.
 */
export class ProductRepo {
  constructor(
    private readonly doc: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  async get(storeId: StoreId, storeProductId: string): Promise<ProductItem | undefined> {
    // Strongly consistent: resolve rereads the row the retailer-proxy upserted MILLISECONDS
    // earlier (and create reads it right after resolve) — an eventually-consistent get could
    // miss the fresh mint and surface a spurious failure. Volume is tiny; the 2x RCU is noise.
    const res = await this.doc.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { storeId, storeProductId },
        ConsistentRead: true,
      }),
    );
    return res.Item ? ProductItem.parse(res.Item) : undefined;
  }

  /**
   * First-write-wins create + counter increment, atomically (one TransactWriteItems): the
   * per-store counter moves only when the conditional put succeeds, so a concurrent-mint loser
   * neither overwrites the winner nor double-counts — `created: false` returns the EXISTING row.
   */
  async create(
    product: ProductUpsert,
    now: string,
  ): Promise<{ item: ProductItem; created: boolean }> {
    const validated = ProductItem.parse({ ...product, createdAt: now, updatedAt: now });
    try {
      await this.doc.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.tableName,
                Item: validated,
                ConditionExpression: "attribute_not_exists(storeId)",
                ReturnValuesOnConditionCheckFailure: "ALL_OLD",
              },
            },
            {
              Update: {
                TableName: this.tableName,
                Key: { storeId: validated.storeId, storeProductId: PRODUCT_COUNTER_SK },
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
      if (existing) return { item: ProductItem.parse(existing), created: false };
      throw err;
    }
  }

  /** Exact number of stored products for `storeId` (the transactional counter item). */
  async count(storeId: StoreId): Promise<number> {
    const res = await this.doc.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { storeId, storeProductId: PRODUCT_COUNTER_SK },
      }),
    );
    return Number(res.Item?.itemCount ?? 0);
  }
}

/**
 * The pre-existing row from a transaction cancelled by its conditional put (the doc client
 * leaves CancellationReasons marshalled), or undefined when the failure was something else.
 */
export function existingFromCancellation(err: unknown): Record<string, unknown> | undefined {
  if (!(err instanceof TransactionCanceledException)) return undefined;
  const conditional = err.CancellationReasons?.find((r) => r.Code === "ConditionalCheckFailed");
  return conditional?.Item ? unmarshall(conditional.Item as never) : undefined;
}
