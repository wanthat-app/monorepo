import { z } from "zod";
import { IsoDateTime, Money } from "../common";
import { CashbackDetails } from "./cashback";

/** Store / retailer a product belongs to (ADR-0003 `store_id`); extended as adapters are added. */
export const StoreId = z.enum(["aliexpress"]);
export type StoreId = z.infer<typeof StoreId>;

/** A store's native product id (the second half of the product key). */
export const StoreProductId = z.string().min(1);
export type StoreProductId = z.infer<typeof StoreProductId>;

/**
 * A retailer product — a **shared** entity, fetched once and reused across every member
 * who recommends it (cashback derives from the product's commission, so it is
 * product-level). Lives in DynamoDB (ADR-0003), keyed by `(storeId, storeProductId)` —
 * the store and its native product id; there is no separate surrogate id. The product-level
 * affiliate URL is minted once at resolve (ADR-0008) and is redirect-internal, never exposed.
 */
export const Product = z.object({
  storeId: StoreId,
  storeProductId: StoreProductId,
  title: z.string(),
  imageUrl: z.string().url().nullable(),
  price: Money.nullable(),
  cashback: CashbackDetails,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Product = z.infer<typeof Product>;
