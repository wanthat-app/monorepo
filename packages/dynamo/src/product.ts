import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
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

/** What a mint/re-mint writes; timestamps are managed by the repo. */
export type ProductUpsert = Omit<ProductItem, "createdAt" | "updatedAt">;

/**
 * Repository over the `product` table (ADR-0003) — the shared catalog item, fetched once and
 * reused across every member who recommends it. Upsert preserves `createdAt` on re-mint so the
 * first-seen time survives metadata refreshes.
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

  async upsert(product: ProductUpsert, now: string): Promise<ProductItem> {
    const validated = ProductItem.omit({ createdAt: true, updatedAt: true }).parse(product);
    const res = await this.doc.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { storeId: validated.storeId, storeProductId: validated.storeProductId },
        UpdateExpression:
          "SET title = :title, imageUrl = :imageUrl, price = :price, commissionBps = :commissionBps, " +
          "affiliateUrl = :affiliateUrl, updatedAt = :now, createdAt = if_not_exists(createdAt, :now)",
        ExpressionAttributeValues: {
          ":title": validated.title,
          ":imageUrl": validated.imageUrl,
          ":price": validated.price,
          ":commissionBps": validated.commissionBps,
          ":affiliateUrl": validated.affiliateUrl,
          ":now": now,
        },
        ReturnValues: "ALL_NEW",
      }),
    );
    return ProductItem.parse(res.Attributes);
  }
}
