/**
 * Admin user detail — a member's recommendations (DynamoDB `byOwner`) and wallet (Aurora as
 * `app_ro`: balances DERIVED from the ledger exactly like the member's own GET /wallet, plus
 * the newest history page). Read-only by construction — the admin role cannot mutate money.
 * The identity itself (GET /admin/users/{sub}) is served by the non-VPC admin-credentials
 * function; only these sub-resources live here. `affiliateUrl` NEVER leaves the backend: the
 * recommendation view strips it (standing rule).
 */
import {
  type AdminUserRecommendationItem,
  AdminUserWalletResponse,
  ListAdminUserRecommendationsResponse,
  Uuid,
} from "@wanthat/contracts";
import { listEntriesForSub, listWalletHistory } from "@wanthat/db";
import { deriveBalances } from "@wanthat/domain";
import type { RecommendationItem } from "@wanthat/dynamo";
import type { Context } from "hono";
import { Hono } from "hono";
import { getContext } from "./context";
import type { Bindings } from "./guard";

const RECOMMENDATIONS_PAGE = 20;
const WALLET_ENTRIES_PAGE = 20;

/** Money's wire rule (bigint minor units → decimal string); `c.json` throws on bigint. */
function moneyJson(c: Context<{ Bindings: Bindings }>, value: unknown): Response {
  return c.body(
    JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
    200,
    { "content-type": "application/json" },
  );
}

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

export function userDetailRouter(): Hono<{ Bindings: Bindings }> {
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

  // GET /:sub/wallet — balances derived from the member's ledger slice + the newest history page.
  router.get("/:sub/wallet", async (c) => {
    const sub = Uuid.safeParse(c.req.param("sub"));
    if (!sub.success) return c.json({ error: "not_found" }, 404);
    const ctx = getContext();
    const [rows, history] = await Promise.all([
      listEntriesForSub(ctx.db, sub.data),
      listWalletHistory(ctx.db, sub.data, WALLET_ENTRIES_PAGE),
    ]);
    return moneyJson(
      c,
      AdminUserWalletResponse.parse({
        balances: deriveBalances(rows),
        entries: {
          items: history.items.map((e) => ({
            id: e.id,
            kind: e.kind,
            amount: { amountMinor: e.amountMinor, currency: e.currency },
            status: e.status,
            recommendationId: e.recommendationId,
            createdAt: e.createdAt.toISOString(),
          })),
          nextCursor: history.nextCursor
            ? Buffer.from(
                JSON.stringify({
                  createdAt: history.nextCursor.createdAt.toISOString(),
                  id: history.nextCursor.id,
                }),
              ).toString("base64url")
            : null,
        },
      }),
    );
  });

  return router;
}
