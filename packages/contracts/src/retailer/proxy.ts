import { z } from "zod";
import { Product, StoreId } from "../recommendations/product";

/**
 * The retailer-linkgen `generateLink` invoke contract (ADR-0002/0004) — the payload the links
 * module sends over the synchronous Lambda invoke, and the shape the linkgen answers. Both
 * sides validate with these schemas, exactly like an HTTP boundary. The wire shape (incl. the
 * `op` discriminator) predates the proxy split (refactor PR-6) and is deliberately KEPT so the
 * caller's move to the split function was an env-var flip, not a payload migration.
 *
 * The linkgen mints (or re-mints) the **product-level** affiliate URL (ADR-0008: one
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
  /**
   * The retailer answered a well-formed, definitive "no such product in the affiliate catalog"
   * (e.g. subsidized promo items excluded from commission). Permanent for this product —
   * retrying cannot help, unlike upstream_error.
   */
  "product_not_supported",
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

/**
 * The retailer-settlement poll summary (ADR-0009). The EventBridge heartbeat fires the
 * settlement function with no payload (refactor PR-6 dropped the `{op}` discriminator — the
 * heartbeat is the function's only entry); the poll computes its own window (runtime config +
 * poller_state watermark) and gates itself on `poller.intervalMinutes`. The summary is
 * observability, not data — money flows through the ledger-writer invoke, never this response.
 */
export const PollOrdersSummary = z.object({
  status: z.literal("ok"),
  /** False = the heartbeat fired before `poller.intervalMinutes` elapsed — nothing ran. */
  ran: z.boolean(),
  window: z.object({ startTime: z.string(), endTime: z.string() }).nullable(),
  fetched: z.number().int(),
  resolved: z.number().int(),
  /** Orders excluded from money: missing/foreign ref, unknown status, no commission. */
  untracked: z.number().int(),
  /** Null in dry mode (no writer configured). */
  written: z.object({ appended: z.number().int(), failed: z.number().int() }).nullable(),
});
export type PollOrdersSummary = z.infer<typeof PollOrdersSummary>;

export const PollOrdersError = z.object({
  status: z.literal("error"),
  code: z.enum(["retailer_not_configured", "upstream_error"]),
  message: z.string().optional(),
});
export type PollOrdersError = z.infer<typeof PollOrdersError>;

export const PollOrdersResponse = z.discriminatedUnion("status", [
  PollOrdersSummary,
  PollOrdersError,
]);
export type PollOrdersResponse = z.infer<typeof PollOrdersResponse>;
