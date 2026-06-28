import { z } from "zod";
import { IsoDateTime, RecommendationId } from "../common";
import { Product } from "./product";
import { Review } from "./review";

/**
 * A member's shareable recommendation of a `Product` (with an optional review). Identified
 * by `recommendationId`; the public URL is `/p/{recommendationId}`. The retailer affiliate
 * URL is redirect-internal (ADR-0007) and is **never** exposed — the member shares `shareUrl`.
 */
export const Recommendation = z.object({
  recommendationId: RecommendationId,
  shareUrl: z.string().url(),
  product: Product,
  review: Review.nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Recommendation = z.infer<typeof Recommendation>;

/** Denormalised per-recommendation counters (fed by the funnel; ADR-0007/0009). */
export const RecommendationStats = z.object({
  clicks: z.number().int().nonnegative(),
  conversions: z.number().int().nonnegative(),
});
export type RecommendationStats = z.infer<typeof RecommendationStats>;

/** List-row view of a recommendation. */
export const RecommendationSummary = z.object({
  recommendationId: RecommendationId,
  shareUrl: z.string().url(),
  title: z.string(),
  imageUrl: z.string().url().nullable(),
  stats: RecommendationStats,
  createdAt: IsoDateTime,
});
export type RecommendationSummary = z.infer<typeof RecommendationSummary>;
