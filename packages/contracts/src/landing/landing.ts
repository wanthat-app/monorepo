import { z } from "zod";
import { RecommendationId } from "../common";
import { LandingCountdownSeconds } from "../config";
import { CashbackEstimate, DisplayFx, Product, Review } from "../recommendations";

/**
 * Public landing view for `GET /p/{recommendationId}` (ADR-0007) — the data the OG-tagged
 * landing page and its bootstrap JS render. Cookieless and identity-free: it carries the product
 * and the recommender's review, but **never** the affiliate URL (that is assembled later by the
 * resolve step). Resolved from the immutable DynamoDB landing projection in one lookup.
 */
export const LandingView = z.object({
  recommendationId: RecommendationId,
  product: Product,
  review: Review.nullable(),
  estimate: CashbackEstimate, // derived from the recommendation's snapshot split, in origin currency
  // Denormalized at link creation for landing display; null on links created before the field existed.
  referrerFirstName: z.string().nullable(),
});
export type LandingView = z.infer<typeof LandingView>;

export const GetLandingParams = z.object({ recommendationId: RecommendationId });
export type GetLandingParams = z.infer<typeof GetLandingParams>;

/**
 * The landing payload plus the current admin-tunable countdown (RuntimeConfig, ADR-0003): the
 * server reads the config value and bundles it here so the branded landing knows how long to
 * count down before the auto-redirect — no extra round-trip on the hot path.
 */
export const GetLandingResponse = z.object({
  landing: LandingView,
  countdownSeconds: LandingCountdownSeconds,
});
export type GetLandingResponse = z.infer<typeof GetLandingResponse>;

/**
 * The payload the landing service embeds into the HTML shell as `window.__WANTHAT_LANDING__` —
 * the HTML-embedded form of `GetLandingResponse` (ADR-0007), so the SPA renders the identical
 * card with zero extra round trips. The server ALWAYS injects one (even on not-found or a read
 * failure); a missing snapshot therefore means client-side navigation and the SPA must
 * hard-reload `/p/{id}`. `displayFx` mirrors the create flow's client-side ILS display
 * conversion. Money travels in wire form (decimal-string minor units) and parses back through
 * `Money`.
 */
export const LandingSnapshot = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ok"),
    landing: LandingView,
    countdownSeconds: LandingCountdownSeconds,
    displayFx: DisplayFx.nullable(),
  }),
  z.object({ status: z.literal("notFound") }),
]);
export type LandingSnapshot = z.infer<typeof LandingSnapshot>;
