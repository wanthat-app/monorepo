import { z } from "zod";
import { RecommendationId } from "../common";
import { Product, Review } from "../recommendations";

/**
 * Public landing view for `GET /p/{recommendationId}` (ADR-0007) — the data the OG-tagged
 * landing page and its bootstrap JS render. Cookieless and identity-free: it carries the product
 * and the recommender's review, but **never** the affiliate URL (that is assembled later by the
 * resolve step). Resolved from the immutable DynamoDB redirect projection in one lookup.
 */
export const LandingView = z.object({
  recommendationId: RecommendationId,
  product: Product,
  review: Review.nullable(),
});
export type LandingView = z.infer<typeof LandingView>;

export const GetLandingParams = z.object({ recommendationId: RecommendationId });
export type GetLandingParams = z.infer<typeof GetLandingParams>;

export const GetLandingResponse = z.object({ landing: LandingView });
export type GetLandingResponse = z.infer<typeof GetLandingResponse>;
