import { z } from "zod";
import { Bps, IsoDateTime, Money } from "../common";

/** Store / retailer a product belongs to (ADR-0003 `store_id`); extended as adapters are added. */
export const StoreId = z.enum(["aliexpress"]);
export type StoreId = z.infer<typeof StoreId>;

/** A store's native product id (the second half of the product key). */
export const StoreProductId = z.string().min(1);
export type StoreProductId = z.infer<typeof StoreProductId>;

/**
 * A retailer product — a **shared** entity, fetched once and reused across every member
 * who recommends it. Lives in DynamoDB (ADR-0003), keyed by `(storeId, storeProductId)` —
 * the store and its native product id; there is no separate surrogate id. The product-level
 * affiliate URL is minted once at resolve (ADR-0008) and is redirect-internal, never exposed.
 *
 * The product carries only what the **retailer** offers: the `price` and `commissionBps` (the
 * network commission rate — what the retailer pays us), both the basis for estimating cashback.
 * Our split of that commission is policy, not a product property: it lives in CONFIG and is
 * snapshotted onto each Recommendation (`CashbackSplit`). `price` is in the retailer's settlement
 * (origin) currency — the currency the wallet is held in.
 */
export const Product = z.object({
  storeId: StoreId,
  storeProductId: StoreProductId,
  title: z.string(),
  imageUrl: z.string().url().nullable(),
  price: Money.nullable(),
  commissionBps: Bps,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Product = z.infer<typeof Product>;
