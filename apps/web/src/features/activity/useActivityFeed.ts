import { useCallback, useEffect, useRef, useState } from "react";
import { type ActivityItemWire, linksApi, walletApi } from "../../lib/api";
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
 * In-memory only — no URL/sessionStorage persistence; a browser refresh restarts the feed
 * (accepted). A failed page rejects without committing, so retry (= `loadMore` again) resumes
 * cleanly from the last committed cursors; already-shown items are never lost.
 */
export function useActivityFeed({
  token,
  pageSize,
  enabled,
}: {
  token: string | null;
  pageSize: number;
  enabled: boolean;
}): {
  /** null until the first page lands (render skeletons); then the merged items so far. */
  items: ActivityItemWire[] | null;
  failed: boolean;
  busy: boolean;
  hasMore: boolean;
  loadMore: () => void;
} {
  const [items, setItems] = useState<ActivityItemWire[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const stateRef = useRef<FeedState>(newFeedState());
  const busyRef = useRef(false); // re-entrancy guard ahead of the async setState
  const startedRef = useRef(false);

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
        setItems((prev) => [...(prev ?? []), ...result.items]);
        setHasMore(hasMoreItems(result.state));
      } catch {
        setFailed(true);
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    })();
  }, [token, pageSize]);

  // First page: once, as soon as the caller enables the feed (session + page size resolved).
  useEffect(() => {
    if (!enabled || startedRef.current) return;
    startedRef.current = true;
    loadMore();
  }, [enabled, loadMore]);

  return { items, failed, busy, hasMore, loadMore };
}
