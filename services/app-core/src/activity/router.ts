import {
  HomeRecentActivityLimit,
  ListMemberActivityQuery,
  ListMemberActivityResponse,
  type MemberActivityItem,
} from "@wanthat/contracts";
import { listWalletHistory } from "@wanthat/db";
import { Hono } from "hono";
import { type Bindings, subFromClaims } from "../claims";
import { getContext } from "../context";
import { moneyJson } from "../http";

/**
 * The member activity feed (GET /activity): recommendation creations (DynamoDB `byOwner`) and
 * wallet movements (the Aurora ledger) merged into ONE newest-first stream. Each source is
 * already newest-first cursor-paged, so a page is a two-pointer merge of one fetch from each;
 * the opaque cursor carries each source's independent position (the last CONSUMED item — both
 * sources can resume from an arbitrary boundary), plus a done flag once a source is drained.
 * Without an explicit `limit` the CONFIG `home.recentActivityLimit` applies — the home strip's
 * size, admin-tunable without a redeploy.
 */

/** Per-source resume position; `done` = the source was fully drained on an earlier page. */
interface FeedCursor {
  r?: { id: string; at: string };
  rDone?: true;
  w?: { id: string; at: string };
  wDone?: true;
}

const encodeCursor = (c: FeedCursor): string =>
  Buffer.from(JSON.stringify(c)).toString("base64url");

const decodeCursor = (raw: string | undefined): FeedCursor => {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (typeof parsed !== "object" || parsed === null) return {};
    const rec = parsed as Record<string, unknown>;
    const pos = (v: unknown): { id: string; at: string } | undefined => {
      if (typeof v !== "object" || v === null) return undefined;
      const { id, at } = v as { id?: unknown; at?: unknown };
      return typeof id === "string" && typeof at === "string" ? { id, at } : undefined;
    };
    return {
      r: pos(rec.r),
      ...(rec.rDone === true ? { rDone: true as const } : {}),
      w: pos(rec.w),
      ...(rec.wDone === true ? { wDone: true as const } : {}),
    };
  } catch {
    return {}; // a malformed cursor reads from the top, same convention as the wallet history
  }
};

export function activityRouter(): Hono<{ Bindings: Bindings }> {
  const activity = new Hono<{ Bindings: Bindings }>();

  activity.get("/", async (c) => {
    const sub = subFromClaims(c);
    if (!sub) return c.json({ error: "unauthorized" }, 401);
    const query = ListMemberActivityQuery.safeParse({
      limit: c.req.query("limit"),
      cursor: c.req.query("cursor"),
    });
    if (!query.success) return c.json({ error: "invalid_request" }, 400);

    const ctx = getContext();
    const limit =
      query.data.limit ??
      HomeRecentActivityLimit.parse(await ctx.config.get("home.recentActivityLimit"));
    const cursor = decodeCursor(query.data.cursor);

    // One newest-first fetch per non-drained source; `limit` from each suffices to fill `limit`.
    const [recPage, walletPage] = await Promise.all([
      cursor.rDone
        ? Promise.resolve(null)
        : ctx.recommendations.listByOwner(
            sub,
            limit,
            cursor.r
              ? { recommendationId: cursor.r.id, ownerId: sub, createdAt: cursor.r.at }
              : undefined,
          ),
      cursor.wDone
        ? Promise.resolve(null)
        : listWalletHistory(
            ctx.db,
            sub,
            limit,
            cursor.w ? { createdAt: new Date(cursor.w.at), id: cursor.w.id } : undefined,
          ),
    ]);

    const recs = recPage?.items ?? [];
    const entries = walletPage?.items ?? [];

    // Two-pointer merge, newest first. Ties break toward the wallet movement (money on top).
    const items: MemberActivityItem[] = [];
    let ri = 0;
    let wi = 0;
    while (items.length < limit && (ri < recs.length || wi < entries.length)) {
      const rec = recs[ri];
      const entry = entries[wi];
      const takeWallet =
        entry !== undefined &&
        (rec === undefined || entry.createdAt.getTime() >= Date.parse(rec.createdAt));
      if (takeWallet && entry !== undefined) {
        wi += 1;
        items.push({
          type: "wallet_entry",
          id: entry.id,
          kind: entry.kind,
          amount: { amountMinor: entry.amountMinor, currency: entry.currency },
          status: entry.status,
          recommendationId: entry.recommendationId,
          at: entry.createdAt.toISOString(),
        });
      } else if (rec !== undefined) {
        ri += 1;
        items.push({
          type: "recommendation_created",
          recommendationId: rec.recommendationId,
          title: rec.title,
          imageUrl: rec.imageUrl,
          at: rec.createdAt,
        });
      }
    }

    // A source is drained when everything fetched was consumed AND its own paging says no more.
    const recDrained =
      cursor.rDone === true || (ri === recs.length && (recPage === null || !recPage.lastKey));
    const walletDrained =
      cursor.wDone === true ||
      (wi === entries.length && (walletPage === null || walletPage.nextCursor === null));

    let nextCursor: string | null = null;
    if (!recDrained || !walletDrained) {
      const lastRec = ri > 0 ? recs[ri - 1] : undefined;
      const lastEntry = wi > 0 ? entries[wi - 1] : undefined;
      const rPart: FeedCursor = recDrained
        ? { rDone: true }
        : { r: lastRec ? { id: lastRec.recommendationId, at: lastRec.createdAt } : cursor.r };
      const wPart: FeedCursor = walletDrained
        ? { wDone: true }
        : { w: lastEntry ? { id: lastEntry.id, at: lastEntry.createdAt.toISOString() } : cursor.w };
      nextCursor = encodeCursor({ ...rPart, ...wPart });
    }

    return moneyJson(c, ListMemberActivityResponse.parse({ items, nextCursor }));
  });

  return activity;
}
