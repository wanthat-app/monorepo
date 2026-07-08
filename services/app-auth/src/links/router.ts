import { extractAliExpressUrl } from "@wanthat/aliexpress";
import type {
  CashbackEstimate,
  CashbackSplit,
  DisplayFx as DisplayFxValue,
  GenerateLinkErrorCode,
  Product,
  Recommendation,
} from "@wanthat/contracts";
import {
  Bps,
  CreateRecommendationBody,
  CreateRecommendationResponse,
  GetRecommendationResponse,
  ListRecommendationsQuery,
  ListRecommendationsResponse,
  ResolveProductBody,
  ResolveProductResponse,
  UpdateRecommendationBody,
  UpdateRecommendationResponse,
} from "@wanthat/contracts";
import { splitCommission } from "@wanthat/domain";
import type { ProductItem, RecommendationItem } from "@wanthat/dynamo";
import type { Context } from "hono";
import { Hono } from "hono";
import { type Bindings, subFromClaims } from "../claims";
import { getContext } from "../context";
import { moneyJson } from "../http";
import { recommendationIdFor } from "./rec-id";

/**
 * The links module (ADR-0002): paste URL → shared product with a product-level affiliate URL →
 * the member's shareable recommendation. The whole path is **Aurora-free** (ADR-0004): the owner
 * is the Cognito `sub` straight from the JWT claims, products/recommendations live in DynamoDB,
 * and the only remote hop is the synchronous retailer-proxy invoke on a product-cache miss.
 */

async function parseBody<T>(
  c: Context<{ Bindings: Bindings }>,
  schema: { safeParse: (v: unknown) => { success: boolean; data?: T } },
): Promise<T | null> {
  try {
    const r = schema.safeParse(await c.req.json());
    return r.success ? (r.data as T) : null;
  } catch {
    return null;
  }
}

/** The current CONFIG split policy — snapshotted onto new links, display-only elsewhere. */
async function currentSplit(): Promise<CashbackSplit> {
  const ctx = getContext();
  const [referrerBps, consumerBps] = await Promise.all([
    ctx.config.get("cashback.referrerBps"),
    ctx.config.get("cashback.consumerBps"),
  ]);
  return { referrerBps: Bps.parse(referrerBps), consumerBps: Bps.parse(consumerBps) };
}

/** Display currency for the Israeli MVP; the wallet's ILS estimate uses the same convention. */
const DISPLAY_CURRENCY = "ILS";

/**
 * The cached settlement→ILS rate + the CONFIG conversion-commission margin, for client-side
 * display conversion (contracts `DisplayFx`). Null (→ the SPA shows settlement amounts) when the
 * product is unpriced, already in ILS, or the fx_rate cache has no entry for the pair yet.
 */
async function displayFx(settlementCurrency: string | undefined): Promise<DisplayFxValue | null> {
  if (!settlementCurrency || settlementCurrency === DISPLAY_CURRENCY) return null;
  const ctx = getContext();
  const [rate, commissionBps] = await Promise.all([
    ctx.fx.get(settlementCurrency, DISPLAY_CURRENCY),
    ctx.config.get("fx.conversionCommissionBps"),
  ]);
  if (!rate) return null;
  return { rate, commissionBps: Bps.parse(commissionBps) };
}

/**
 * Derived per-side estimate (display only, never stored): price × network commission × split,
 * exact bigint math in the retailer's settlement currency. Null when the price is unknown.
 */
function buildEstimate(
  price: { amountMinor: string; currency: string } | null,
  commissionBps: number,
  split: CashbackSplit,
): CashbackEstimate {
  if (!price) {
    return {
      referrer: { rateBps: split.referrerBps, estimated: null },
      consumer: { rateBps: split.consumerBps, estimated: null },
    };
  }
  const gross = (BigInt(price.amountMinor) * BigInt(commissionBps)) / 10_000n;
  const parts = splitCommission(gross, split.referrerBps, split.consumerBps);
  return {
    referrer: {
      rateBps: split.referrerBps,
      estimated: { amountMinor: parts.referrerMinor, currency: price.currency },
    },
    consumer: {
      rateBps: split.consumerBps,
      estimated: { amountMinor: parts.consumerRewardMinor, currency: price.currency },
    },
  };
}

/** The stored projection → the API `Recommendation` (the affiliate URL never leaves — ADR-0007). */
function toRecommendation(item: RecommendationItem, appUrl: string): Recommendation {
  const product: Product = {
    storeId: item.storeId as Product["storeId"],
    storeProductId: item.storeProductId,
    title: item.title,
    imageUrl: item.imageUrl,
    // The projection denormalises the product AS OF link creation, so it carries the
    // recommendation's own timestamps rather than the shared catalog row's.
    price: item.price
      ? { amountMinor: BigInt(item.price.amountMinor), currency: item.price.currency }
      : null,
    commissionBps: item.commissionBps,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
  return {
    recommendationId: item.recommendationId,
    shareUrl: `${appUrl}/p/${item.recommendationId}`,
    product,
    cashback: item.cashback,
    estimate: buildEstimate(item.price, item.commissionBps, item.cashback),
    review: item.review ?? null,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

/** HTTP status for each proxy error code (the proxy never throws on a known failure). */
const PROXY_ERROR_STATUS: Record<GenerateLinkErrorCode, 400 | 502 | 503> = {
  unsupported_url: 400,
  retailer_not_configured: 503,
  upstream_error: 502,
};

const cursorOf = (lastKey: Record<string, unknown> | undefined): string | null =>
  lastKey ? Buffer.from(JSON.stringify(lastKey)).toString("base64url") : null;

const keyOf = (cursor: string | undefined): Record<string, unknown> | undefined => {
  if (!cursor) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
};

export function productsRouter(): Hono<{ Bindings: Bindings }> {
  const products = new Hono<{ Bindings: Bindings }>();

  // POST /products/resolve — paste a URL OR the whole share-button text → fetch/upsert the
  // shared product + current-policy estimate. The first supported URL is extracted from the
  // text; a directly-parseable product URL gets a local reuse check first (ADR-0008: one
  // link.generate per product), while a share short-link goes straight to the retailer-proxy,
  // which expands it (the sole egress) and does its own reuse check.
  products.post("/resolve", async (c) => {
    const sub = subFromClaims(c);
    if (!sub) return c.json({ error: "unauthorized" }, 401);
    const body = await parseBody(c, ResolveProductBody);
    if (!body) return c.json({ error: "invalid_request" }, 400);

    const candidate = extractAliExpressUrl(body.url);
    if (!candidate) return c.json({ error: "unsupported_url" }, 400);

    const ctx = getContext();
    let item: ProductItem | undefined =
      candidate.kind === "product"
        ? await ctx.products.get(candidate.storeId, candidate.storeProductId)
        : undefined;
    if (!item) {
      const minted = await ctx.retailerProxy.generateLink(candidate.url);
      if (minted.status === "error") {
        return c.json({ error: minted.code }, PROXY_ERROR_STATUS[minted.code]);
      }
      // The proxy upserted the Product (ADR-0004); reread the stored row so the response and
      // any concurrent resolve agree on one source of truth.
      item = await ctx.products.get(minted.product.storeId, minted.product.storeProductId);
      if (!item) return c.json({ error: "upstream_error" }, 502);
    }

    const split = await currentSplit();
    const product: Product = {
      storeId: item.storeId as Product["storeId"],
      storeProductId: item.storeProductId,
      title: item.title,
      imageUrl: item.imageUrl,
      price: item.price
        ? { amountMinor: BigInt(item.price.amountMinor), currency: item.price.currency }
        : null,
      commissionBps: item.commissionBps,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    };
    return moneyJson(
      c,
      ResolveProductResponse.parse({
        product,
        estimate: buildEstimate(item.price, item.commissionBps, split),
        displayFx: await displayFx(item.price?.currency),
      }),
    );
  });

  return products;
}

export function recommendationsRouter(): Hono<{ Bindings: Bindings }> {
  const recs = new Hono<{ Bindings: Bindings }>();

  // POST /recommendations — the member's shareable link for a resolved product. Idempotent on
  // (owner, product): the id is derived (rec-id.ts), so a replay returns the EXISTING link with
  // its original cashback snapshot (ADR-0008 locks economics at creation) — 200, not 201.
  recs.post("/", async (c) => {
    const sub = subFromClaims(c);
    if (!sub) return c.json({ error: "unauthorized" }, 401);
    const body = await parseBody(c, CreateRecommendationBody);
    if (!body) return c.json({ error: "invalid_request" }, 400);

    const ctx = getContext();
    const product = await ctx.products.get(body.storeId, body.storeProductId);
    // The product must have been resolved first (the contract's precondition).
    if (!product) return c.json({ error: "product_not_resolved" }, 404);

    const split = await currentSplit();
    const now = new Date().toISOString();
    const { item, created } = await ctx.recommendations.create({
      recommendationId: recommendationIdFor(sub, body.storeId, body.storeProductId),
      ownerId: sub,
      storeId: product.storeId,
      storeProductId: product.storeProductId,
      affiliateUrl: product.affiliateUrl,
      title: product.title,
      imageUrl: product.imageUrl,
      price: product.price,
      commissionBps: product.commissionBps,
      cashback: split,
      review: body.review ?? null,
      clicks: 0,
      conversions: 0,
      createdAt: now,
      updatedAt: now,
    });
    // A conditional-write hit must be THIS owner's link for THIS product. With an 11-char
    // (~64-bit) id an accidental birthday collision is negligible but not zero — this guard
    // turns that worst case into a loud 500 instead of ever returning someone else's link.
    if (
      !created &&
      (item.ownerId !== sub ||
        item.storeId !== body.storeId ||
        item.storeProductId !== body.storeProductId)
    ) {
      console.error("recommendation id collision", { recommendationId: item.recommendationId });
      return c.json({ error: "internal_error" }, 500);
    }
    return moneyJson(
      c,
      CreateRecommendationResponse.parse({ recommendation: toRecommendation(item, ctx.appUrl) }),
      created ? 201 : 200,
    );
  });

  // GET /recommendations — list mine, newest first (byOwner GSI), cursor-paginated.
  recs.get("/", async (c) => {
    const sub = subFromClaims(c);
    if (!sub) return c.json({ error: "unauthorized" }, 401);
    const query = ListRecommendationsQuery.safeParse({
      cursor: c.req.query("cursor"),
      limit: c.req.query("limit"),
    });
    if (!query.success) return c.json({ error: "invalid_request" }, 400);

    const ctx = getContext();
    const page = await ctx.recommendations.listByOwner(
      sub,
      query.data.limit,
      keyOf(query.data.cursor),
    );
    return moneyJson(
      c,
      ListRecommendationsResponse.parse({
        items: page.items.map((item) => ({
          recommendationId: item.recommendationId,
          shareUrl: `${ctx.appUrl}/p/${item.recommendationId}`,
          title: item.title,
          imageUrl: item.imageUrl,
          stats: { clicks: item.clicks, conversions: item.conversions },
          createdAt: item.createdAt,
        })),
        nextCursor: cursorOf(page.lastKey),
      }),
    );
  });

  // GET /recommendations/{id} — one of MINE (someone else's id is a plain 404, no existence leak).
  recs.get("/:recommendationId", async (c) => {
    const sub = subFromClaims(c);
    if (!sub) return c.json({ error: "unauthorized" }, 401);
    const ctx = getContext();
    const item = await ctx.recommendations.get(c.req.param("recommendationId"));
    if (!item || item.ownerId !== sub) return c.json({ error: "not_found" }, 404);
    return moneyJson(
      c,
      GetRecommendationResponse.parse({ recommendation: toRecommendation(item, ctx.appUrl) }),
    );
  });

  // PATCH /recommendations/{id} — set or clear my review (the one mutable field; ADR-0008 locks
  // the rest). Owner-conditional in DynamoDB, so a foreign id 404s exactly like a missing one.
  recs.patch("/:recommendationId", async (c) => {
    const sub = subFromClaims(c);
    if (!sub) return c.json({ error: "unauthorized" }, 401);
    const body = await parseBody(c, UpdateRecommendationBody);
    if (!body) return c.json({ error: "invalid_request" }, 400);

    const ctx = getContext();
    const item = await ctx.recommendations.updateReview(
      c.req.param("recommendationId"),
      sub,
      body.review,
      new Date().toISOString(),
    );
    if (!item) return c.json({ error: "not_found" }, 404);
    return moneyJson(
      c,
      UpdateRecommendationResponse.parse({ recommendation: toRecommendation(item, ctx.appUrl) }),
    );
  });

  return recs;
}
