/**
 * The unattributed-order claim queue (Phase 2, 2026-07-10). List / claim / dismiss over the
 * `unattributed_order` projection the poller feeds. Claiming only writes INTENT — the
 * retailer-proxy heartbeat settles it through the conversion writer (money enters through one
 * door only, ADR-0002; the admin surface never invokes the money writer). Claims are
 * validated against a live recommendation so a typo surfaces here, not as a stuck queue.
 */
import {
  ClaimUnattributedOrderBody,
  GetUnattributedOrderResponse,
  ListUnattributedOrdersQuery,
  ListUnattributedOrdersResponse,
  UnattributedOrderActionResponse,
  type UnattributedOrderView,
} from "@wanthat/contracts";
import type { UnattributedOrderItem } from "@wanthat/dynamo";
import { Hono } from "hono";
import { getContext } from "./context";
import { actorFrom, type Bindings } from "./guard";

const toView = (item: UnattributedOrderItem): UnattributedOrderView => ({
  orderId: item.orderId,
  reason: item.reason as UnattributedOrderView["reason"],
  orderStatus: item.orderStatus,
  amount:
    item.commissionMinor !== null
      ? { amountMinor: item.commissionMinor, currency: item.currency ?? "USD" }
      : null,
  product:
    item.productId !== null || item.productTitle !== null
      ? {
          productId: item.productId,
          title: item.productTitle,
          imageUrl: item.productImageUrl,
          detailUrl: item.productDetailUrl,
          count: item.productCount,
        }
      : null,
  paidAmount:
    item.paidAmountMinor !== null
      ? { amountMinor: item.paidAmountMinor, currency: item.currency ?? "USD" }
      : null,
  commissionRate: item.commissionRate,
  subOrderId: item.subOrderId,
  occurredAt: item.occurredAt,
  firstSeenAt: item.firstSeenAt,
  lastSeenAt: item.lastSeenAt,
  state: item.state,
  claim: item.claim,
  settledAt: item.settledAt,
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

export function unattributedRouter(): Hono<{ Bindings: Bindings }> {
  const router = new Hono<{ Bindings: Bindings }>();

  // GET / — the queue, one state at a time (default: open), newest first.
  router.get("/", async (c) => {
    const query = ListUnattributedOrdersQuery.safeParse({
      state: c.req.query("state") ?? undefined,
      cursor: c.req.query("cursor"),
      limit: c.req.query("limit") ?? undefined,
    });
    if (!query.success) return c.json({ error: "invalid_request" }, 400);
    const page = await getContext().unattributedOrders.listByState(
      query.data.state,
      query.data.limit,
      keyOf(query.data.cursor),
    );
    return c.json(
      ListUnattributedOrdersResponse.parse({
        items: page.items.map(toView),
        nextCursor: cursorOf(page.lastKey),
      }),
    );
  });

  // GET /:orderId — the admin order detail page (portal cross-reference).
  router.get("/:orderId", async (c) => {
    const item = await getContext().unattributedOrders.get(c.req.param("orderId"));
    if (!item) return c.json({ error: "not_found" }, 404);
    return c.json(GetUnattributedOrderResponse.parse({ item: toView(item) }));
  });

  // POST /:orderId/claim — bind the order to a recommendation (the proxy heartbeat settles it).
  router.post("/:orderId/claim", async (c) => {
    const body = ClaimUnattributedOrderBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid_request" }, 400);
    const ctx = getContext();
    const rec = await ctx.recommendations.get(body.data.recommendationId);
    if (!rec) return c.json({ error: "unknown_recommendation" }, 404);
    const item = await ctx.unattributedOrders.claim(
      c.req.param("orderId"),
      { recommendationId: rec.recommendationId, claimedBy: actorFrom(c) },
      new Date().toISOString(),
    );
    // Missing order, already settled/dismissed, or no commission to split — nothing to claim.
    if (!item) return c.json({ error: "conflict" }, 409);
    return c.json(UnattributedOrderActionResponse.parse({ item: toView(item) }));
  });

  // POST /:orderId/dismiss — reviewed house revenue; allowed from open and claimed.
  router.post("/:orderId/dismiss", async (c) => {
    const item = await getContext().unattributedOrders.dismiss(c.req.param("orderId"));
    if (!item) return c.json({ error: "conflict" }, 409);
    return c.json(UnattributedOrderActionResponse.parse({ item: toView(item) }));
  });

  return router;
}
