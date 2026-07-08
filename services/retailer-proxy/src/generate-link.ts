import type { Logger } from "@aws-lambda-powertools/logger";
import type { AliExpressClient } from "@wanthat/aliexpress";
import { parseAliExpressProductUrl } from "@wanthat/aliexpress";
import { GenerateLinkResponse } from "@wanthat/contracts";
import type { ProductRepo } from "@wanthat/dynamo";
import type { z } from "zod";

/**
 * The JSON-safe wire form of the invoke response (`Money.amountMinor` stays a decimal string;
 * the caller's contract parse turns it into bigint).
 */
export type GenerateLinkWire = z.input<typeof GenerateLinkResponse>;

export interface GenerateLinkDeps {
  products: ProductRepo;
  /** Resolves to a signed client, or null while the credential secret is unpopulated. */
  client: () => Promise<AliExpressClient | null>;
  logger: Logger;
  now?: () => Date;
}

/** Best-effort metadata cap (SDD §8.1): the link mint is the path; details must not stall it. */
const PRODUCT_DETAIL_TIMEOUT_MS = 2500;

/** AliExpress image URLs often arrive protocol-relative (`//ae01.alicdn.com/…`). */
function absoluteImageUrl(imageUrl: string | null): string | null {
  if (!imageUrl) return null;
  if (imageUrl.startsWith("//")) return `https:${imageUrl}`;
  return imageUrl;
}

/**
 * Mint (or re-mint) the **product-level** affiliate URL for a pasted product URL and upsert the
 * shared Product in DynamoDB (ADR-0004: the proxy owns the Product write; the caller writes the
 * Recommendation). `link.generate` is required; `productdetail.get` runs in parallel and is
 * best-effort — on failure the product is persisted with placeholder metadata rather than
 * failing the user's flow (SDD §8.1: "persist and return without metadata").
 */
export async function generateLink(url: string, deps: GenerateLinkDeps): Promise<GenerateLinkWire> {
  const parsed = parseAliExpressProductUrl(url);
  if (!parsed) return { status: "error", code: "unsupported_url" };

  const client = await deps.client();
  if (!client) return { status: "error", code: "retailer_not_configured" };

  const [link, detail] = await Promise.allSettled([
    client.generatePromotionLink(url),
    client.getProductDetail(parsed.storeProductId, PRODUCT_DETAIL_TIMEOUT_MS),
  ]);

  if (link.status === "rejected") {
    deps.logger.error("link.generate failed", { error: String(link.reason) });
    return { status: "error", code: "upstream_error", message: String(link.reason) };
  }
  if (detail.status === "rejected") {
    // Metadata is best-effort — record why, keep going with placeholders.
    deps.logger.warn("productdetail.get failed; persisting without metadata", {
      error: String(detail.reason),
    });
  }
  const meta = detail.status === "fulfilled" ? detail.value : null;

  const nowIso = (deps.now?.() ?? new Date()).toISOString();
  const product = await deps.products.upsert(
    {
      storeId: parsed.storeId,
      storeProductId: parsed.storeProductId,
      title: meta?.title ?? `AliExpress item ${parsed.storeProductId}`,
      imageUrl: absoluteImageUrl(meta?.imageUrl ?? null),
      price:
        meta?.priceMinor && meta.priceCurrency
          ? { amountMinor: meta.priceMinor, currency: meta.priceCurrency }
          : null,
      commissionBps: meta?.commissionBps ?? 0,
      affiliateUrl: link.value,
    },
    nowIso,
  );

  const response: GenerateLinkWire = {
    status: "ok",
    product: {
      storeId: "aliexpress",
      storeProductId: product.storeProductId,
      title: product.title,
      imageUrl: product.imageUrl,
      price: product.price,
      commissionBps: product.commissionBps,
      createdAt: product.createdAt,
      updatedAt: product.updatedAt,
    },
    affiliateUrl: product.affiliateUrl,
  };
  // Self-check against the invoke contract so a drift fails HERE (typed, logged), not in the caller.
  const valid = GenerateLinkResponse.safeParse(response);
  if (!valid.success) {
    deps.logger.error("generateLink response failed contract validation", {
      issues: valid.error.issues,
    });
    return { status: "error", code: "upstream_error", message: "malformed retailer payload" };
  }
  return response;
}
