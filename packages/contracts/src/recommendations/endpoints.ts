import { z } from "zod";
import { PageQuery, page, RecommendationId } from "../common";
import { Product, StoreId, StoreProductId } from "./product";
import { Recommendation, RecommendationSummary } from "./recommendation";
import { Review } from "./review";

// POST /products/resolve — paste a store URL → fetch/upsert the shared product + cashback.
// Shared across members (no re-fetch if already known); idempotent on the product identity.
export const ResolveProductBody = z.object({ url: z.string().url() });
export type ResolveProductBody = z.infer<typeof ResolveProductBody>;

export const ResolveProductResponse = z.object({ product: Product });
export type ResolveProductResponse = z.infer<typeof ResolveProductResponse>;

// POST /recommendations — generate this member's shareable recommendation (+ optional review).
// The product is named by its key `(storeId, storeProductId)` (ADR-0003); must already be
// resolved. Idempotent on (owner, product); honors an `Idempotency-Key` header.
export const CreateRecommendationBody = z.object({
  storeId: StoreId,
  storeProductId: StoreProductId,
  review: Review.optional(),
});
export type CreateRecommendationBody = z.infer<typeof CreateRecommendationBody>;

export const CreateRecommendationResponse = z.object({ recommendation: Recommendation });
export type CreateRecommendationResponse = z.infer<typeof CreateRecommendationResponse>;

// GET /recommendations — list mine (cursor-paginated).
export const ListRecommendationsQuery = PageQuery;
export type ListRecommendationsQuery = z.infer<typeof ListRecommendationsQuery>;

export const ListRecommendationsResponse = page(RecommendationSummary);
export type ListRecommendationsResponse = z.infer<typeof ListRecommendationsResponse>;

// GET /recommendations/{recommendationId} — get one of mine.
export const GetRecommendationParams = z.object({ recommendationId: RecommendationId });
export type GetRecommendationParams = z.infer<typeof GetRecommendationParams>;

export const GetRecommendationResponse = z.object({ recommendation: Recommendation });
export type GetRecommendationResponse = z.infer<typeof GetRecommendationResponse>;
