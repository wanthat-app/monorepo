import type { ActivityItemWire, RecommendationSummaryWire, WalletEntryWire } from "../../lib/api";

/**
 * The client-side activity merge (refactor PR 2b — the server's merged GET /activity is gone).
 * Two independently cursor-paginated, newest-first sources — the member's wallet ledger
 * (GET /wallet/entries) and their recommendations (GET /recommendations) — are composed into one
 * newest-first stream, page by page:
 *
 *  1. PRIME — every non-done source with an empty buffer is fetched (its next page).
 *  2. EMIT — only while EVERY non-done source has a buffered head (or is done) may an item be
 *     emitted: pop the newest head by `at`; ties break toward the wallet/money item (as the old
 *     server merge did). This invariant is correctness-critical — an empty, non-drained buffer
 *     may hide a newer item than the other source's head.
 *  3. REFILL — when a buffer empties mid-page, fetch again and continue.
 *
 * Everything here is pure (state in, state out) so the merge is unit-testable without React;
 * `useActivityFeed` owns the React state. In-memory only by design — a refresh restarts the feed.
 */

/** One paginated source: its unemitted buffer (newest first), server cursor, and drain flag. */
export interface SourceState {
  buffer: readonly ActivityItemWire[];
  /** Opaque server cursor for the NEXT page; undefined before the first fetch. */
  cursor: string | undefined;
  /** True once the server answered `nextCursor: null` — nothing left to fetch. */
  done: boolean;
  /** Every item id ever buffered — the (source, id) dedup guard across page appends. */
  seen: ReadonlySet<string>;
}

export interface FeedState {
  wallet: SourceState;
  recs: SourceState;
}

/** One fetched page, already mapped to the feed's display item type. */
export interface FeedPage {
  items: ActivityItemWire[];
  nextCursor: string | null;
}

/** The two page fetchers, keyed like FeedState. `cursor` undefined = first page. */
export interface FeedFetchers {
  wallet: (cursor: string | undefined, limit: number) => Promise<FeedPage>;
  recs: (cursor: string | undefined, limit: number) => Promise<FeedPage>;
}

const newSource = (): SourceState => ({
  buffer: [],
  cursor: undefined,
  done: false,
  seen: new Set(),
});

export const newFeedState = (): FeedState => ({ wallet: newSource(), recs: newSource() });

/** GET /wallet/entries row → feed display item. */
export const walletToFeedItem = (e: WalletEntryWire): ActivityItemWire => ({
  type: "wallet_entry",
  id: e.id,
  kind: e.kind,
  amount: e.amount,
  status: e.status,
  recommendationId: e.recommendationId,
  at: e.createdAt,
});

/** GET /recommendations row → feed display item. */
export const recToFeedItem = (r: RecommendationSummaryWire): ActivityItemWire => ({
  type: "recommendation_created",
  recommendationId: r.recommendationId,
  title: r.title,
  imageUrl: r.imageUrl,
  at: r.createdAt,
});

/** The per-source dedup id (the sets are per source, so no cross-source prefix is needed). */
const idOf = (item: ActivityItemWire): string =>
  item.type === "wallet_entry" ? item.id : item.recommendationId;

/**
 * A source BLOCKS emission when it might still hide a newer item: not drained, nothing buffered.
 * (Emitting past it could interleave out of order — the correctness invariant above.)
 */
const blocked = (s: SourceState): boolean => !s.done && s.buffer.length === 0;

/** Append a fetched page: drop already-seen ids, advance the cursor, latch `done`. */
export function appendPage(source: SourceState, page: FeedPage): SourceState {
  const fresh = page.items.filter((item) => !source.seen.has(idOf(item)));
  const seen = new Set(source.seen);
  for (const item of fresh) seen.add(idOf(item));
  return {
    buffer: [...source.buffer, ...fresh],
    cursor: page.nextCursor ?? source.cursor,
    done: page.nextCursor === null,
    seen,
  };
}

/**
 * Pop up to `max` items, newest first, WITHOUT emitting past an empty non-done buffer. Ties
 * (equal `at`) break toward the wallet item — money on top, matching the retired server merge.
 */
export function emitMerged(
  state: FeedState,
  max: number,
): { state: FeedState; items: ActivityItemWire[] } {
  const wallet = [...state.wallet.buffer];
  const recs = [...state.recs.buffer];
  const items: ActivityItemWire[] = [];
  while (items.length < max) {
    if ((!state.wallet.done && wallet.length === 0) || (!state.recs.done && recs.length === 0)) {
      break; // a non-drained source has nothing buffered — it may hide a newer item
    }
    const w = wallet[0];
    const r = recs[0];
    if (w !== undefined && (r === undefined || Date.parse(w.at) >= Date.parse(r.at))) {
      wallet.shift();
      items.push(w);
    } else if (r !== undefined) {
      recs.shift();
      items.push(r);
    } else {
      break; // both fully drained
    }
  }
  return {
    state: {
      wallet: { ...state.wallet, buffer: wallet },
      recs: { ...state.recs, buffer: recs },
    },
    items,
  };
}

/** More to show? — anything still buffered, or any source the server has not drained yet. */
export const hasMoreItems = (state: FeedState): boolean =>
  state.wallet.buffer.length > 0 ||
  state.recs.buffer.length > 0 ||
  !state.wallet.done ||
  !state.recs.done;

/**
 * Fill one page of `pageSize` items: prime/refill every blocking source (in parallel), emit, and
 * repeat until the page is full or both sources are drained. Rejects WITHOUT committing anything
 * if any fetch fails — the caller retries from its last committed state (server cursors are
 * stable, and the dedup guard absorbs any overlap).
 */
export async function fillPage(
  state: FeedState,
  fetchers: FeedFetchers,
  pageSize: number,
): Promise<{ state: FeedState; items: ActivityItemWire[] }> {
  let cur = state;
  const out: ActivityItemWire[] = [];
  while (out.length < pageSize) {
    const emitted = emitMerged(cur, pageSize - out.length);
    cur = emitted.state;
    out.push(...emitted.items);
    if (out.length >= pageSize) break;

    const needWallet = blocked(cur.wallet);
    const needRecs = blocked(cur.recs);
    if (!needWallet && !needRecs) break; // nothing blocks and nothing emitted — fully drained

    const before = cur;
    const [walletPage, recsPage] = await Promise.all([
      needWallet ? fetchers.wallet(cur.wallet.cursor, pageSize) : Promise.resolve(null),
      needRecs ? fetchers.recs(cur.recs.cursor, pageSize) : Promise.resolve(null),
    ]);
    if (walletPage) cur = { ...cur, wallet: appendPage(cur.wallet, walletPage) };
    if (recsPage) cur = { ...cur, recs: appendPage(cur.recs, recsPage) };

    // Progress guard: a misbehaving server (all-duplicate page, unchanged cursor, not done)
    // must never spin this loop — stop the page early instead.
    const stuck = (was: SourceState, now: SourceState): boolean =>
      blocked(now) && now.cursor === was.cursor && !now.done;
    if (
      (walletPage && stuck(before.wallet, cur.wallet)) ||
      (recsPage && stuck(before.recs, cur.recs))
    ) {
      break;
    }
  }
  return { state: cur, items: out };
}
