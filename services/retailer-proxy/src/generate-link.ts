import type { Logger } from "@aws-lambda-powertools/logger";
import type {
  AliExpressClient,
  AliExpressProductDetail,
  ParsedProductUrl,
} from "@wanthat/aliexpress";
import {
  AliExpressApiError,
  expandAliExpressShortLink,
  extractAliExpressUrl,
} from "@wanthat/aliexpress";
import { GenerateLinkResponse } from "@wanthat/contracts";
import { needsEnrichment, type ProductItem, type ProductRepo } from "@wanthat/dynamo";
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
  /** Injectable for tests; used only by the pinned-host short-link expansion. */
  fetchFn?: typeof fetch;
  /** Injectable for tests; used only by the ApiCallLimit retry backoff. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

/** Best-effort metadata cap (SDD §8.1): the link mint is the path; details must not stall it. */
const PRODUCT_DETAIL_TIMEOUT_MS = 2500;
/** The throttle ban is "1 seconds" (validation, test-mode app) — wait it out once. */
const API_LIMIT_RETRY_MS = 1200;

/** AliExpress image URLs often arrive protocol-relative (`//ae01.alicdn.com/…`). */
function absoluteImageUrl(imageUrl: string | null): string | null {
  if (!imageUrl) return null;
  if (imageUrl.startsWith("//")) return `https:${imageUrl}`;
  return imageUrl;
}

function okResponse(product: ProductItem, deps: GenerateLinkDeps): GenerateLinkWire {
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

/**
 * Mint (or reuse) the **product-level** affiliate URL for pasted text/URL and upsert the shared
 * Product in DynamoDB (ADR-0004: the proxy owns the Product write; the caller writes the
 * Recommendation). Accepts a product URL, a share short-link (`a.aliexpress.com/_x…` — expanded
 * here, the sole egress, via a pinned-host redirect-follow), or whole share-button text. The
 * product identity is resolved first and checked against the table (ADR-0008: ONE link.generate
 * per product); only a miss calls the retailer — `link.generate` required, `productdetail.get`
 * parallel best-effort (SDD §8.1: "persist and return without metadata" on failure).
 */
export async function generateLink(url: string, deps: GenerateLinkDeps): Promise<GenerateLinkWire> {
  const candidate = extractAliExpressUrl(url);
  if (!candidate) return { status: "error", code: "unsupported_url" };

  let parsed: ParsedProductUrl;
  let sourceUrl: string;
  if (candidate.kind === "product") {
    parsed = candidate;
    sourceUrl = candidate.url;
  } else {
    let expanded: Awaited<ReturnType<typeof expandAliExpressShortLink>>;
    try {
      expanded = await expandAliExpressShortLink(candidate.url, deps.fetchFn ?? fetch);
    } catch (err) {
      deps.logger.error("short-link expansion failed", { error: String(err) });
      return { status: "error", code: "upstream_error", message: "short-link expansion failed" };
    }
    if (!expanded) return { status: "error", code: "unsupported_url" };
    parsed = expanded;
    sourceUrl = expanded.canonicalUrl;
  }

  // Reuse before any retailer call (ADR-0008): a paste of an already-minted, fully-enriched
  // product must not re-mint — and must not even need the credential. A row still carrying
  // placeholder metadata (a past productdetail failure) falls through to the enrichment retry.
  const existing = await deps.products.get(parsed.storeId, parsed.storeProductId);
  if (existing && !needsEnrichment(existing)) return okResponse(existing, deps);

  // Building the client reads the credential secret + the tracking-id config — remote calls that
  // can fail transiently. A known op never throws (the invoke contract), so degrade to a typed
  // error the caller maps, exactly like a retailer failure.
  let client: Awaited<ReturnType<GenerateLinkDeps["client"]>>;
  try {
    client = await deps.client();
  } catch (err) {
    deps.logger.error("client setup failed (secret/config read)", { error: String(err) });
    return { status: "error", code: "upstream_error", message: "client setup failed" };
  }
  if (!client) {
    // An unenriched row still carries a valid affiliate link — serve it rather than failing the
    // user over metadata while the credential is unpopulated.
    if (existing) return okResponse(existing, deps);
    return { status: "error", code: "retailer_not_configured" };
  }

  // The affiliate link: reuse the stored one (enrichment retry) or mint it. SEQUENTIAL with the
  // metadata call below, and always FIRST — the test-mode app is throttled to ~1 call/s
  // (validation: "ApiCallLimit ... this ban will last 1 seconds"), and when the calls raced in
  // parallel the throttle could land on the link mint, failing the whole resolve.
  let affiliateUrl = existing?.affiliateUrl;
  if (!affiliateUrl) {
    try {
      affiliateUrl = await client.generatePromotionLink(sourceUrl);
    } catch (err) {
      deps.logger.error("link.generate failed", { error: String(err) });
      return { status: "error", code: "upstream_error", message: String(err) };
    }
  }

  // Metadata, best-effort: one attempt + one retry after the throttle window when the platform
  // answers ApiCallLimit. Any other failure persists placeholders (flagged metadataPending, so
  // the NEXT resolve retries instead of serving junk forever).
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let meta: AliExpressProductDetail | null = null;
  for (let attempt = 0; attempt < 2 && !meta; attempt++) {
    try {
      meta = await client.getProductDetail(parsed.storeProductId, PRODUCT_DETAIL_TIMEOUT_MS);
    } catch (err) {
      const throttled = err instanceof AliExpressApiError && err.code === "ApiCallLimit";
      if (throttled && attempt === 0) {
        await sleep(API_LIMIT_RETRY_MS);
        continue;
      }
      deps.logger.warn("productdetail.get failed; persisting without metadata", {
        error: String(err),
      });
      break;
    }
  }

  const nowIso = (deps.now?.() ?? new Date()).toISOString();
  const product = await deps.products.upsert(
    {
      storeId: parsed.storeId,
      storeProductId: parsed.storeProductId,
      title: meta?.title ?? existing?.title ?? `AliExpress item ${parsed.storeProductId}`,
      imageUrl: absoluteImageUrl(meta?.imageUrl ?? null) ?? existing?.imageUrl ?? null,
      price:
        meta?.priceMinor && meta.priceCurrency
          ? { amountMinor: meta.priceMinor, currency: meta.priceCurrency }
          : (existing?.price ?? null),
      commissionBps: meta?.commissionBps ?? existing?.commissionBps ?? 0,
      affiliateUrl,
      metadataPending: meta === null,
    },
    nowIso,
  );
  return okResponse(product, deps);
}
