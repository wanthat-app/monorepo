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
import type { ProductItem, ProductRepo } from "@wanthat/dynamo";
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

/** Metadata is REQUIRED (all-or-nothing, 2026-07-08 decision) — load-bearing, so a real budget. */
const PRODUCT_DETAIL_TIMEOUT_MS = 5000;
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
 * per product); only a miss calls the retailer.
 *
 * ALL-OR-NOTHING (2026-07-08 decision): pull the metadata first, mint the link at the END, and
 * write the Product ONCE with everything in hand. Any failure fails the whole flow — nothing is
 * stored, no placeholders exist, and every stored row is a full product. Both retailer calls get
 * one retry after the throttle window on ApiCallLimit (test-mode apps are capped ~1 call/s; a
 * real throttling mechanism is future work).
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

  // Reuse before any retailer call (ADR-0008): every stored row is a FULL product
  // (all-or-nothing writes below), so a hit is always servable — even without the credential.
  const existing = await deps.products.get(parsed.storeId, parsed.storeProductId);
  if (existing) return okResponse(existing, deps);

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
  if (!client) return { status: "error", code: "retailer_not_configured" };

  // One retry after the throttle window when the platform answers ApiCallLimit — the calls run
  // sequentially, so on a ~1 call/s test-mode app the SECOND call is the likely victim.
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const withThrottleRetry = async <T>(call: () => Promise<T>): Promise<T> => {
    try {
      return await call();
    } catch (err) {
      if (!(err instanceof AliExpressApiError) || err.code !== "ApiCallLimit") throw err;
      await sleep(API_LIMIT_RETRY_MS);
      return await call();
    }
  };

  // 1) Metadata FIRST — required. A product we cannot describe is not stored at all.
  let meta: AliExpressProductDetail;
  try {
    meta = await withThrottleRetry(() =>
      client.getProductDetail(parsed.storeProductId, PRODUCT_DETAIL_TIMEOUT_MS),
    );
  } catch (err) {
    // A well-formed empty answer is a DEFINITIVE miss — the product is not in the affiliate
    // catalog (e.g. subsidized promo items). Permanent, so a typed code, not upstream_error.
    if (err instanceof AliExpressApiError && err.code === "empty_result") {
      deps.logger.warn("productdetail.get answered empty; product not in the affiliate catalog", {
        storeProductId: parsed.storeProductId,
        error: String(err),
      });
      return {
        status: "error",
        code: "product_not_supported",
        message: "product is not in the affiliate catalog",
      };
    }
    deps.logger.error("productdetail.get failed; failing the flow (all-or-nothing)", {
      storeProductId: parsed.storeProductId,
      error: String(err),
    });
    return { status: "error", code: "upstream_error", message: "product metadata unavailable" };
  }
  if (!meta.title || meta.commissionBps === null) {
    deps.logger.error("productdetail.get answered without title/commission; failing the flow", {
      storeProductId: parsed.storeProductId,
      hasTitle: meta.title !== null,
      hasCommission: meta.commissionBps !== null,
    });
    return { status: "error", code: "upstream_error", message: "product metadata incomplete" };
  }

  // 2) The affiliate link at the END.
  let affiliateUrl: string;
  try {
    affiliateUrl = await withThrottleRetry(() => client.generatePromotionLink(sourceUrl));
  } catch (err) {
    deps.logger.error("link.generate failed", {
      storeProductId: parsed.storeProductId,
      error: String(err),
    });
    return { status: "error", code: "upstream_error", message: String(err) };
  }

  // 3) ONE write, with everything in hand — create-once + counter, atomic. A concurrent resolve
  // losing the race gets the winner's stored row back (created: false), never an overwrite.
  const nowIso = (deps.now?.() ?? new Date()).toISOString();
  const { item: product } = await deps.products.create(
    {
      storeId: parsed.storeId,
      storeProductId: parsed.storeProductId,
      title: meta.title,
      imageUrl: absoluteImageUrl(meta.imageUrl),
      price:
        meta.priceMinor && meta.priceCurrency
          ? { amountMinor: meta.priceMinor, currency: meta.priceCurrency }
          : null,
      commissionBps: meta.commissionBps,
      affiliateUrl,
    },
    nowIso,
  );
  return okResponse(product, deps);
}
