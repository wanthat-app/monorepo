import { useCallback, useEffect, useRef, useState } from "react";
import { type ActivityItemWire, linksApi, walletApi } from "../../lib/api";
import { readCache, writeCache } from "../../lib/stale-cache";
import {
  type FeedState,
  fillPage,
  hasMoreItems,
  newFeedState,
  recToFeedItem,
  walletToFeedItem,
} from "./feed";

/**
 * React state around the pure client-side activity merge (`./feed`): the member's wallet ledger
 * + recommendations composed into one newest-first stream, one `pageSize` page per `loadMore`.
 * The FIRST page is persisted per user (lib/stale-cache) and replayed as `stale` items on the
 * next mount, so an Aurora cold start shows the last known feed under a "counting" chip instead
 * of skeletons (spec 2026-07-21-cold-start-cache); the real first page replaces it wholesale.
 * While stale items are showing, a failed fetch retries silently with capped backoff — `failed`
 * only ever fires with nothing cached. Pagination state stays in-memory; a refresh restarts it.
 * A failed page rejects without committing, so retry (= `loadMore` again) resumes cleanly from
 * the last committed cursors; already-shown items are never lost.
 */
export function useActivityFeed({
  token,
  sub,
  pageSize,
  enabled,
}: {
  token: string | null;
  /** Cognito sub — the cache key; null (pre-session) disables the cache. */
  sub: string | null;
  pageSize: number;
  enabled: boolean;
}): {
  /** null until cache or first page lands (render skeletons); then the items so far. */
  items: ActivityItemWire[] | null;
  /** True while `items` is the replayed cache — hide pagination, show the counting chip. */
  stale: boolean;
  failed: boolean;
  busy: boolean;
  hasMore: boolean;
  loadMore: () => void;
} {
  const [items, setItems] = useState<ActivityItemWire[] | null>(null);
  const [stale, setStale] = useState(false);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const stateRef = useRef<FeedState>(newFeedState());
  const busyRef = useRef(false); // re-entrancy guard ahead of the async setState
  const startedRef = useRef(false);
  const firstPageDoneRef = useRef(false);
  const staleRef = useRef(false); // mirrors `stale` for the async catch below
  const retryAttemptRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout>>();

  const loadMore = useCallback(() => {
    if (!token || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setFailed(false);
    void (async () => {
      try {
        const result = await fillPage(
          stateRef.current,
          {
            wallet: (cursor, limit) =>
              walletApi.entries(token, { limit, cursor }).then((page) => ({
                items: page.items.map(walletToFeedItem),
                nextCursor: page.nextCursor,
              })),
            recs: (cursor, limit) =>
              linksApi.list(token, { limit, cursor }).then((page) => ({
                items: page.items.map(recToFeedItem),
                nextCursor: page.nextCursor,
              })),
          },
          pageSize,
        );
        stateRef.current = result.state;
        retryAttemptRef.current = 0;
        const firstPage = !firstPageDoneRef.current;
        firstPageDoneRef.current = true;
        staleRef.current = false;
        setStale(false);
        // The first fresh page REPLACES whatever is showing (the replayed cache); later
        // pages append as before.
        setItems((prev) => (firstPage ? result.items : [...(prev ?? []), ...result.items]));
        setHasMore(hasMoreItems(result.state));
        if (firstPage && sub) writeCache("activity", sub, result.items);
      } catch {
        if (staleRef.current) {
          // Cold start with cached rows on screen — retry silently, capped backoff (spec).
          retryAttemptRef.current += 1;
          retryTimerRef.current = setTimeout(
            loadMore,
            Math.min(30_000, 1_000 * 2 ** retryAttemptRef.current),
          );
        } else {
          setFailed(true);
        }
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    })();
  }, [token, sub, pageSize]);

  // First page: once, as soon as the caller enables the feed. Replay the cached page first —
  // it renders instantly while the real fetch races Aurora's resume.
  useEffect(() => {
    if (!enabled || startedRef.current) return;
    startedRef.current = true;
    if (sub) {
      const cached = readCache<ActivityItemWire[]>("activity", sub);
      if (cached && cached.length > 0) {
        staleRef.current = true;
        setStale(true);
        setItems(cached);
      }
    }
    loadMore();
  }, [enabled, sub, loadMore]);

  // A pending silent retry must not fire into an unmounted page.
  useEffect(() => () => clearTimeout(retryTimerRef.current), []);

  return { items, stale, failed, busy, hasMore, loadMore };
}
