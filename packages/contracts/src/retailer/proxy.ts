import { z } from "zod";
import { Product, StoreId } from "../recommendations/product";

/**
 * The retailer-proxy `generateLink` invoke contract (ADR-0002/0004) — the payload the in-VPC
 * links module sends over the synchronous Lambda invoke, and the shape the proxy returns.
 * Both sides validate with these schemas, exactly like an HTTP boundary.
 *
 * The proxy mints (or re-mints) the **product-level** affiliate URL (ADR-0008: one
 * `link.generate` per product, shared across everyone who recommends it) and upserts the
 * Product in DynamoDB before returning (ADR-0004); the caller then writes the Recommendation.
 */
export const GenerateLinkRequest = z.object({
  op: z.literal("generateLink"),
  retailer: StoreId,
  /** The pasted store URL. Host-allow-listed and parsed only — never fetched by us (SSRF-safe). */
  url: z.string().url(),
});
export type GenerateLinkRequest = z.infer<typeof GenerateLinkRequest>;

/** Why a generateLink invoke could not produce a product. */
export const GenerateLinkErrorCode = z.enum([
  /** The URL is not a parseable product URL of a supported retailer. */
  "unsupported_url",
  /** The retailer credential secret has not been populated yet (admin drop pending). */
  "retailer_not_configured",
  /** The retailer API failed or answered with an error/malformed payload. */
  "upstream_error",
]);
export type GenerateLinkErrorCode = z.infer<typeof GenerateLinkErrorCode>;

/**
 * Discriminated result — the proxy never throws on a known failure (an invoke error would
 * surface as a raw 5xx to the caller); it answers `status: "error"` with a mappable code.
 * The affiliate URL is redirect-internal (ADR-0007): the caller persists it, never serves it.
 */
export const GenerateLinkResponse = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ok"),
    product: Product,
    affiliateUrl: z.string().url(),
  }),
  z.object({
    status: z.literal("error"),
    code: GenerateLinkErrorCode,
    message: z.string().optional(),
  }),
]);
export type GenerateLinkResponse = z.infer<typeof GenerateLinkResponse>;
