import { describe, expect, it, vi } from "vitest";
import type { ActivityItemWire } from "../../lib/api";
import {
  appendPage,
  emitMerged,
  type FeedFetchers,
  type FeedPage,
  type FeedState,
  fillPage,
  hasMoreItems,
  newFeedState,
  recToFeedItem,
  walletToFeedItem,
} from "./feed";

/**
 * The client-side activity merge, tested as pure functions (no React, no network): two
 * newest-first cursor-paginated sources composed into one stream. The correctness-critical
 * invariant — NEVER emit past an empty non-done buffer (it may hide a newer item) — gets its
 * own scenarios, alongside skewed streams, tie ordering, errors, dedup and empty sources.
 */

/** Second `n` of a fixed day — larger n = newer. */
const at = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, 0, 0) + n * 1000).toISOString();

const w = (id: string, atIso: string): ActivityItemWire => ({
  type: "wallet_entry",
  id,
  kind: "referrer_cashback",
  amount: { amountMinor: "62", currency: "USD" },
  status: "pending",
  recommendationId: null,
  at: atIso,
});

const rec = (id: string, atIso: string): ActivityItemWire => ({
  type: "recommendation_created",
  recommendationId: id,
  title: `Product ${id}`,
  imageUrl: null,
  at: atIso,
});

const idOf = (item: ActivityItemWire) =>
  item.type === "wallet_entry" ? item.id : item.recommendationId;

/** A well-behaved server over a fixed newest-first list; the cursor is the next start index. */
const pagedFetcher = (all: ActivityItemWire[]) =>
  vi.fn((cursor: string | undefined, limit: number): Promise<FeedPage> => {
    const start = cursor ? Number(cursor) : 0;
    const items = all.slice(start, start + limit);
    const next = start + items.length;
    return Promise.resolve({ items, nextCursor: next >= all.length ? null : String(next) });
  });

/** A scripted server: answers the given pages in order (repeating the last one if over-asked). */
const scriptedFetcher = (pages: FeedPage[]) => {
  let i = 0;
  return vi.fn((): Promise<FeedPage> => {
    const page = pages[Math.min(i, pages.length - 1)] as FeedPage;
    i += 1;
    return Promise.resolve(page);
  });
};

/** Drain the whole feed through repeated fillPage calls, like successive "load more" clicks. */
async function drain(fetchers: FeedFetchers, pageSize: number): Promise<ActivityItemWire[]> {
  let state: FeedState = newFeedState();
  const out: ActivityItemWire[] = [];
  for (let guard = 0; guard < 100 && hasMoreItems(state); guard += 1) {
    const res = await fillPage(state, fetchers, pageSize);
    state = res.state;
    out.push(...res.items);
    if (res.items.length === 0) break; // no progress — never spin
  }
  return out;
}

describe("emitMerged ordering", () => {
  it("pops the newest head across both buffers, wallet winning exact-timestamp ties", () => {
    let state = newFeedState();
    state = {
      wallet: appendPage(state.wallet, {
        items: [w("w1", at(50)), w("w2", at(10))],
        nextCursor: null,
      }),
      recs: appendPage(state.recs, {
        items: [rec("r1", at(50)), rec("r2", at(20))],
        nextCursor: null,
      }),
    };
    const { items } = emitMerged(state, 10);
    // at(50) tie: the wallet/money item comes first, like the retired server merge.
    expect(items.map(idOf)).toEqual(["w1", "r1", "r2", "w2"]);
  });

  it("never emits past an empty NON-done buffer (the invariant), but ignores a done one", () => {
    let state = newFeedState();
    state = {
      // Wallet: empty buffer, NOT done — it may hide an item newer than any buffered rec.
      wallet: { ...state.wallet, cursor: "5" },
      recs: appendPage(state.recs, { items: [rec("r1", at(90))], nextCursor: null }),
    };
    expect(emitMerged(state, 10).items).toEqual([]);

    // Same shape but the wallet is DRAINED — now the recs may flow.
    const drained = { ...state, wallet: { ...state.wallet, done: true } };
    expect(emitMerged(drained, 10).items.map(idOf)).toEqual(["r1"]);
  });
});

describe("fillPage", () => {
  it("interleaves the two sources newest-first across page boundaries", async () => {
    const wallets = [w("w1", at(95)), w("w2", at(40))];
    const recs = [rec("r1", at(90)), rec("r2", at(60)), rec("r3", at(30))];
    const items = await drain({ wallet: pagedFetcher(wallets), recs: pagedFetcher(recs) }, 2);
    expect(items.map(idOf)).toEqual(["w1", "r1", "r2", "w2", "r3"]);
  });

  it("refills an emptied buffer mid-page instead of emitting older items (invariant end-to-end)", async () => {
    // Wallet answers SHORT pages: [t90] then [t80] then done. A naive merge that emits past the
    // empty wallet buffer would produce 100, 90, 10, 80 — the t80 wallet item out of order.
    const walletFetcher = scriptedFetcher([
      { items: [w("w1", at(90))], nextCursor: "c1" },
      { items: [w("w2", at(80))], nextCursor: null },
    ]);
    const recsFetcher = pagedFetcher([rec("r1", at(100)), rec("r2", at(10))]);
    const { items, state } = await fillPage(
      newFeedState(),
      { wallet: walletFetcher, recs: recsFetcher },
      10,
    );
    expect(items.map(idOf)).toEqual(["r1", "w1", "w2", "r2"]);
    expect(hasMoreItems(state)).toBe(false);
    expect(walletFetcher).toHaveBeenCalledTimes(2);
  });

  it("merges heavily skewed streams correctly (200 recs, 3 wallet events)", async () => {
    // Recs at seconds 1..200 (newest first); wallet events dropped at 150.5, 77.5 and 0.5.
    const allRecs = Array.from({ length: 200 }, (_, i) => rec(`r${200 - i}`, at(200 - i)));
    const allWallets = [w("wA", at(150.5)), w("wB", at(77.5)), w("wC", at(0.5))];
    const expected = [...allRecs, ...allWallets]
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
      .map(idOf);

    const items = await drain(
      { wallet: pagedFetcher(allWallets), recs: pagedFetcher(allRecs) },
      20,
    );
    expect(items).toHaveLength(203);
    expect(items.map(idOf)).toEqual(expected);
  });

  it("answers an empty feed when both sources are empty", async () => {
    const { items, state } = await fillPage(
      newFeedState(),
      { wallet: pagedFetcher([]), recs: pagedFetcher([]) },
      10,
    );
    expect(items).toEqual([]);
    expect(hasMoreItems(state)).toBe(false);
  });

  it("rejects WITHOUT committing when one source errors, so a retry resumes cleanly", async () => {
    const wallets = [w("w1", at(95)), w("w2", at(40))];
    const recs = [rec("r1", at(90)), rec("r2", at(60)), rec("r3", at(30))];
    let failNext = true;
    const flakyWallet = (cursor: string | undefined, limit: number): Promise<FeedPage> => {
      if (failNext) {
        failNext = false;
        return Promise.reject(new Error("boom"));
      }
      return pagedFetcher(wallets)(cursor, limit);
    };
    const fetchers = { wallet: flakyWallet, recs: pagedFetcher(recs) };

    const state = newFeedState();
    await expect(fillPage(state, fetchers, 2)).rejects.toThrow("boom");
    // The caller keeps its previous state — the retry replays the SAME page, in order, no gaps.
    const retry = await fillPage(state, fetchers, 2);
    expect(retry.items.map(idOf)).toEqual(["w1", "r1"]);
    const rest = await fillPage(retry.state, fetchers, 10);
    expect(rest.items.map(idOf)).toEqual(["r2", "w2", "r3"]);
  });

  it("dedups overlapping pages by (source, id)", async () => {
    // The second wallet page re-answers w2 (an at-least-once server) plus the genuinely next w3.
    const walletFetcher = scriptedFetcher([
      { items: [w("w1", at(90)), w("w2", at(80))], nextCursor: "c1" },
      { items: [w("w2", at(80)), w("w3", at(70))], nextCursor: null },
    ]);
    const fetchers = { wallet: walletFetcher, recs: pagedFetcher([]) };
    const first = await fillPage(newFeedState(), fetchers, 2);
    const more = await fillPage(first.state, fetchers, 10);
    expect(first.items.map(idOf)).toEqual(["w1", "w2"]);
    expect(more.items.map(idOf)).toEqual(["w3"]);
  });

  it("stops (instead of spinning) on a misbehaving server that repeats a page", async () => {
    // Same items, same cursor, never done — the progress guard must end the page.
    const stuckPage: FeedPage = { items: [w("w1", at(90))], nextCursor: "same" };
    const walletFetcher = scriptedFetcher([stuckPage, stuckPage, stuckPage]);
    const { items } = await fillPage(
      newFeedState(),
      { wallet: walletFetcher, recs: pagedFetcher([]) },
      5,
    );
    expect(items.map(idOf)).toEqual(["w1"]);
    expect(walletFetcher.mock.calls.length).toBeLessThanOrEqual(3);
  });
});

describe("wire mapping", () => {
  it("maps a wallet ledger row onto the display item", () => {
    expect(
      walletToFeedItem({
        id: "e-1",
        kind: "referrer_cashback",
        amount: { amountMinor: "62", currency: "USD" },
        status: "pending",
        recommendationId: "abc123DEF45",
        createdAt: at(5),
      }),
    ).toEqual({
      type: "wallet_entry",
      id: "e-1",
      kind: "referrer_cashback",
      amount: { amountMinor: "62", currency: "USD" },
      status: "pending",
      recommendationId: "abc123DEF45",
      at: at(5),
    });
  });

  it("maps a recommendation summary onto the display item", () => {
    expect(
      recToFeedItem({
        recommendationId: "abc123DEF45",
        shareUrl: "https://app.example/p/abc123DEF45",
        title: "A very nice thing",
        imageUrl: null,
        stats: { clicks: 3, conversions: 1 },
        createdAt: at(6),
      }),
    ).toEqual({
      type: "recommendation_created",
      recommendationId: "abc123DEF45",
      title: "A very nice thing",
      imageUrl: null,
      at: at(6),
    });
  });
});
