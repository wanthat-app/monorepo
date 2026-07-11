import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted fakes so the vi.mock factories can close over them (vitest hoists vi.mock above imports).
const { fake, dbReads } = vi.hoisted(() => ({
  fake: {
    db: {},
    config: { get: vi.fn() },
    recommendations: { listByOwner: vi.fn() },
  },
  dbReads: {
    listWalletHistory: vi.fn(),
  },
}));

vi.mock("../context", () => ({ getContext: () => fake }));
vi.mock("@wanthat/db", () => dbReads);

import { activityRouter } from "./router";

const app = new Hono();
app.route("/activity", activityRouter());

const SUB = "11111111-1111-1111-1111-111111111111";
const authed = {
  event: { requestContext: { authorizer: { jwt: { claims: { sub: SUB } } } } },
};
const get = (path: string, env?: object) => app.request(path, { method: "GET" }, env);

const rec = (id: string, at: string) => ({
  recommendationId: id,
  ownerId: SUB,
  title: `Product ${id}`,
  imageUrl: null,
  createdAt: at,
});
const entry = (id: string, at: string) => ({
  id,
  kind: "referrer_cashback",
  amountMinor: 62n,
  currency: "USD",
  recommendationId: "abc123DEF45",
  status: "pending",
  createdAt: new Date(at),
});
const E1 = "22222222-2222-4222-8222-222222222221";
const E2 = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  vi.clearAllMocks();
  fake.config.get.mockResolvedValue(10);
  fake.recommendations.listByOwner.mockResolvedValue({ items: [], lastKey: undefined });
  dbReads.listWalletHistory.mockResolvedValue({ items: [], nextCursor: null });
});

describe("GET /activity", () => {
  it("merges both sources newest-first, wallet winning ties, and defaults to the CONFIG limit", async () => {
    fake.recommendations.listByOwner.mockResolvedValue({
      items: [
        rec("recNew0000A", "2026-07-10T12:00:00.000Z"),
        rec("recOld0000B", "2026-07-09T08:00:00.000Z"),
      ],
      lastKey: undefined,
    });
    dbReads.listWalletHistory.mockResolvedValue({
      items: [entry(E1, "2026-07-10T12:00:00.000Z"), entry(E2, "2026-07-10T09:00:00.000Z")],
      nextCursor: null,
    });
    const res = await get("/activity", authed);
    expect(res.status).toBe(200);
    expect(fake.config.get).toHaveBeenCalledWith("home.recentActivityLimit");
    expect(fake.recommendations.listByOwner).toHaveBeenCalledWith(SUB, 10, undefined);
    expect(dbReads.listWalletHistory).toHaveBeenCalledWith(fake.db, SUB, 10, undefined);
    const body = (await res.json()) as {
      items: Array<{ type: string; at: string; amount?: { amountMinor: string } }>;
      nextCursor: unknown;
    };
    expect(body.items.map((i) => [i.type, i.at])).toEqual([
      ["wallet_entry", "2026-07-10T12:00:00.000Z"], // tie -> money on top
      ["recommendation_created", "2026-07-10T12:00:00.000Z"],
      ["wallet_entry", "2026-07-10T09:00:00.000Z"],
      ["recommendation_created", "2026-07-09T08:00:00.000Z"],
    ]);
    expect(body.nextCursor).toBeNull(); // both sources drained
    // Money wire: bigint minor units travel as decimal strings.
    expect(body.items[0]?.amount?.amountMinor).toBe("62");
  });

  it("pages with the composite cursor: each source resumes from its own consumed position", async () => {
    // Page 1 (limit 2): two recs newer than both wallet entries; wallet stays unconsumed.
    fake.recommendations.listByOwner.mockResolvedValueOnce({
      items: [
        rec("recAAAAAAAA", "2026-07-10T12:00:00.000Z"),
        rec("recBBBBBBBB", "2026-07-10T11:00:00.000Z"),
      ],
      lastKey: { recommendationId: "recBBBBBBBB" },
    });
    dbReads.listWalletHistory.mockResolvedValueOnce({
      items: [entry(E1, "2026-07-10T10:00:00.000Z")],
      nextCursor: null,
    });
    const first = await get("/activity?limit=2", authed);
    const page1 = (await first.json()) as { items: Array<{ type: string }>; nextCursor: string };
    expect(page1.items.map((i) => i.type)).toEqual([
      "recommendation_created",
      "recommendation_created",
    ]);
    expect(typeof page1.nextCursor).toBe("string");

    // Page 2: recs resume AFTER recBBBBBBBB; wallet resumes from the top (nothing was consumed).
    fake.recommendations.listByOwner.mockResolvedValueOnce({ items: [], lastKey: undefined });
    dbReads.listWalletHistory.mockResolvedValueOnce({
      items: [entry(E1, "2026-07-10T10:00:00.000Z")],
      nextCursor: null,
    });
    const second = await get(`/activity?limit=2&cursor=${page1.nextCursor}`, authed);
    expect(fake.recommendations.listByOwner).toHaveBeenLastCalledWith(SUB, 2, {
      recommendationId: "recBBBBBBBB",
      ownerId: SUB,
      createdAt: "2026-07-10T11:00:00.000Z",
    });
    expect(dbReads.listWalletHistory).toHaveBeenLastCalledWith(fake.db, SUB, 2, undefined);
    const page2 = (await second.json()) as { items: Array<{ type: string }>; nextCursor: null };
    expect(page2.items.map((i) => i.type)).toEqual(["wallet_entry"]);
    expect(page2.nextCursor).toBeNull();
  });

  it("a drained source is not re-queried on later pages (done flag)", async () => {
    // limit 1: wallet item consumed, wallet has more; recs drained on the first page.
    fake.recommendations.listByOwner.mockResolvedValueOnce({ items: [], lastKey: undefined });
    dbReads.listWalletHistory.mockResolvedValueOnce({
      items: [entry(E1, "2026-07-10T10:00:00.000Z")],
      nextCursor: { createdAt: new Date("2026-07-10T10:00:00.000Z"), id: E1 },
    });
    const first = await get("/activity?limit=1", authed);
    const page1 = (await first.json()) as { nextCursor: string };

    dbReads.listWalletHistory.mockResolvedValueOnce({
      items: [entry(E2, "2026-07-09T10:00:00.000Z")],
      nextCursor: null,
    });
    fake.recommendations.listByOwner.mockClear();
    const second = await get(`/activity?limit=1&cursor=${page1.nextCursor}`, authed);
    expect(fake.recommendations.listByOwner).not.toHaveBeenCalled();
    expect(dbReads.listWalletHistory).toHaveBeenLastCalledWith(fake.db, SUB, 1, {
      createdAt: new Date("2026-07-10T10:00:00.000Z"),
      id: E1,
    });
    const page2 = (await second.json()) as { items: Array<{ id?: string }> };
    expect(page2.items[0]?.id).toBe(E2);
  });

  it("an explicit limit skips the config read; a malformed cursor reads from the top", async () => {
    await get("/activity?limit=5", authed);
    expect(fake.config.get).not.toHaveBeenCalled();
    expect(fake.recommendations.listByOwner).toHaveBeenCalledWith(SUB, 5, undefined);

    const res = await get("/activity?limit=5&cursor=%%%garbage", authed);
    expect(res.status).toBe(200);
    expect(fake.recommendations.listByOwner).toHaveBeenLastCalledWith(SUB, 5, undefined);
  });

  it("400s an out-of-range limit and 401s without claims", async () => {
    expect((await get("/activity?limit=999", authed)).status).toBe(400);
    expect((await get("/activity")).status).toBe(401);
  });
});
