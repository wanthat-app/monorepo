import { z } from "zod";
import { Bps, PageQuery, page, RecommendationId } from "../common";
import { ExchangeRate } from "../fx/rate";
import { CashbackEstimate } from "./cashback";
import { Product, StoreId, StoreProductId } from "./product";
import { Recommendation, RecommendationSummary } from "./recommendation";
import { Review } from "./review";

// POST /products/resolve — paste a store URL → fetch/upsert the shared product + cashback.
// Shared across members (no re-fetch if already known); idempotent on the product identity.
export const ResolveProductBody = z.object({ url: z.string().url() });
export type ResolveProductBody = z.infer<typeof ResolveProductBody>;

// `estimate` is computed from the **current** CONFIG split policy (no recommendation exists yet);
// CreateRecommendation then snapshots that policy onto the link.
//
// `displayFx` lets the SPA render amounts in the member's currency (the CashbackEstimate contract:
// "the SPA converts ... for display convenience"): the cached settlement→display rate plus the
// CONFIG conversion-commission margin, applied client-side via @wanthat/domain `convertMinor`.
// Null when the cache has no rate — the SPA then shows settlement-currency amounts.
export const DisplayFx = z.object({ rate: ExchangeRate, commissionBps: Bps });
export type DisplayFx = z.infer<typeof DisplayFx>;

export const ResolveProductResponse = z.object({
  product: Product,
  estimate: CashbackEstimate,
  displayFx: DisplayFx.nullable(),
});
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

// PATCH /recommendations/{recommendationId} — set or clear the caller's review on an existing
// recommendation. The link is created (and shareable) the moment the summary screen opens; the
// review is edited in place afterwards (design: Wallet flow, summary screen), so it needs its
// own write. Only the review is mutable — the cashback snapshot and product are locked (ADR-0008).
export const UpdateRecommendationBody = z.object({ review: Review.nullable() });
export type UpdateRecommendationBody = z.infer<typeof UpdateRecommendationBody>;

export const UpdateRecommendationResponse = z.object({ recommendation: Recommendation });
export type UpdateRecommendationResponse = z.infer<typeof UpdateRecommendationResponse>;

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
