/**
 * Admin user detail — the RECOMMENDATIONS tab (DynamoDB `byOwner`), read-only. The identity
 * route (GET /admin/users/{sub}) lives on this same function (Cognito); the wallet tab is the
 * in-VPC admin-ledger-view's one user route (Aurora). `affiliateUrl` NEVER leaves the backend:
 * the recommendation view strips it (standing rule).
 */
import {
  type AdminUserRecommendationItem,
  ListAdminUserRecommendationsResponse,
  Uuid,
} from "@wanthat/contracts";
import type { RecommendationItem } from "@wanthat/dynamo";
import { Hono } from "hono";
import { getContext } from "./context";
import type { Bindings } from "./guard";

const RECOMMENDATIONS_PAGE = 20;

/** The admin view of a stored recommendation — everything EXCEPT the affiliate URL and owner. */
const toRecommendationView = (item: RecommendationItem): AdminUserRecommendationItem => ({
  recommendationId: item.recommendationId,
  storeId: item.storeId,
  storeProductId: item.storeProductId,
  title: item.title,
  imageUrl: item.imageUrl,
  price: item.price,
  commissionBps: item.commissionBps,
  cashback: item.cashback,
  review: item.review,
  clicks: item.clicks,
  conversions: item.conversions,
  createdAt: item.createdAt,
  updatedAt: item.updatedAt,
});

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

export function userRecommendationsRouter(): Hono<{ Bindings: Bindings }> {
  const router = new Hono<{ Bindings: Bindings }>();

  // GET /:sub/recommendations — the member's links, newest first (byOwner GSI).
  router.get("/:sub/recommendations", async (c) => {
    const sub = Uuid.safeParse(c.req.param("sub"));
    if (!sub.success) return c.json({ error: "not_found" }, 404);
    const page = await getContext().recommendations.listByOwner(
      sub.data,
      RECOMMENDATIONS_PAGE,
      keyOf(c.req.query("cursor")),
    );
    return c.json(
      ListAdminUserRecommendationsResponse.parse({
        items: page.items.map(toRecommendationView),
        nextCursor: cursorOf(page.lastKey),
      }),
    );
  });

  return router;
}
