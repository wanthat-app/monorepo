import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted fakes so the vi.mock factories can close over them (vitest hoists vi.mock above imports).
const { fake, dbReads } = vi.hoisted(() => ({
  fake: {
    db: {}, // opaque handle — the read functions themselves are mocked below
    recommendations: { listByOwner: vi.fn() },
  },
  dbReads: {
    listEntriesForSub: vi.fn(),
    listWalletHistory: vi.fn(),
  },
}));

vi.mock("./context", () => ({ getContext: () => fake }));
// The ledger queries are integration-tested in packages/db (testcontainers); here they are seams.
vi.mock("@wanthat/db", () => dbReads);

import { userDetailRouter } from "./user-detail";

const app = new Hono();
app.route("/admin/users", userDetailRouter());

const SUB = "11111111-1111-1111-1111-111111111111";
const NOW = "2026-07-10T10:00:00.000Z";

const STORED_REC = {
  recommendationId: "abc123DEF45",
  ownerId: SUB,
  storeId: "aliexpress",
  storeProductId: "1005006123456789",
  affiliateUrl: "https://s.click.aliexpress.com/e/_secret", // must NEVER reach the wire
  title: "Feeder",
  imageUrl: "https://img/x.jpg",
  price: { amountMinor: "125", currency: "USD" },
  commissionBps: 300,
  cashback: { referrerBps: 6000, consumerBps: 2000 },
  review: null,
  referrerFirstName: "דניס",
  clicks: 3,
  conversions: 1,
  createdAt: NOW,
  updatedAt: NOW,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /admin/users/:sub/recommendations", () => {
  it("lists the member's recommendations WITHOUT the affiliate URL", async () => {
    fake.recommendations.listByOwner.mockResolvedValue({ items: [STORED_REC], lastKey: undefined });
    const res = await app.request(`/admin/users/${SUB}/recommendations`);
    expect(res.status).toBe(200);
    expect(fake.recommendations.listByOwner).toHaveBeenCalledWith(SUB, 20, undefined);
    const body = (await res.json()) as { items: Array<Record<string, unknown>> };
    expect(body.items).toEqual([
      {
        recommendationId: "abc123DEF45",
        storeId: "aliexpress",
        storeProductId: "1005006123456789",
        title: "Feeder",
        imageUrl: "https://img/x.jpg",
        price: { amountMinor: "125", currency: "USD" },
        commissionBps: 300,
        cashback: { referrerBps: 6000, consumerBps: 2000 },
        review: null,
        clicks: 3,
        conversions: 1,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ]);
    // The standing rule, asserted explicitly: no affiliate URL (and no owner echo) on any wire.
    expect(JSON.stringify(body)).not.toContain("affiliateUrl");
    expect(JSON.stringify(body)).not.toContain("s.click.aliexpress.com");
  });

  it("round-trips the cursor and 404s a malformed sub", async () => {
    fake.recommendations.listByOwner.mockResolvedValue({
      items: [],
      lastKey: { recommendationId: "x", ownerId: SUB, createdAt: NOW },
    });
    const first = await app.request(`/admin/users/${SUB}/recommendations`);
    const { nextCursor } = (await first.json()) as { nextCursor: string };
    expect(typeof nextCursor).toBe("string");

    await app.request(`/admin/users/${SUB}/recommendations?cursor=${nextCursor}`);
    expect(fake.recommendations.listByOwner).toHaveBeenLastCalledWith(SUB, 20, {
      recommendationId: "x",
      ownerId: SUB,
      createdAt: NOW,
    });

    expect((await app.request("/admin/users/not-a-uuid/recommendations")).status).toBe(404);
  });
});

describe("GET /admin/users/:sub/wallet", () => {
  it("derives balances from the ledger slice and maps the history page to the wallet wire", async () => {
    dbReads.listEntriesForSub.mockResolvedValue([
      {
        kind: "referrer_cashback",
        amountMinor: 400n,
        currency: "USD",
        orderId: "o-1",
        status: "confirmed",
      },
    ]);
    dbReads.listWalletHistory.mockResolvedValue({
      items: [
        {
          id: "22222222-2222-4222-8222-222222222222",
          kind: "referrer_cashback",
          amountMinor: 400n,
          currency: "USD",
          recommendationId: "abc123DEF45",
          status: "confirmed",
          createdAt: new Date(NOW),
        },
      ],
      nextCursor: { createdAt: new Date(NOW), id: "22222222-2222-4222-8222-222222222222" },
    });

    const res = await app.request(`/admin/users/${SUB}/wallet`);
    expect(res.status).toBe(200);
    expect(dbReads.listEntriesForSub).toHaveBeenCalledWith(fake.db, SUB);
    expect(dbReads.listWalletHistory).toHaveBeenCalledWith(fake.db, SUB, 20);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      balances: [
        {
          available: { amountMinor: "400", currency: "USD" },
          asRecommender: { confirmed: { amountMinor: "400", currency: "USD" } },
        },
      ],
      entries: {
        items: [
          {
            id: "22222222-2222-4222-8222-222222222222",
            kind: "referrer_cashback",
            amount: { amountMinor: "400", currency: "USD" },
            status: "confirmed",
            recommendationId: "abc123DEF45",
            createdAt: NOW,
          },
        ],
      },
    });
    expect(typeof (body.entries as { nextCursor: unknown }).nextCursor).toBe("string");
  });

  it("an empty ledger answers empty balances and entries", async () => {
    dbReads.listEntriesForSub.mockResolvedValue([]);
    dbReads.listWalletHistory.mockResolvedValue({ items: [], nextCursor: null });
    const res = await app.request(`/admin/users/${SUB}/wallet`);
    expect(await res.json()).toEqual({
      balances: [],
      entries: { items: [], nextCursor: null },
    });
  });

  it("404s a malformed sub without touching the db", async () => {
    expect((await app.request("/admin/users/oops/wallet")).status).toBe(404);
    expect(dbReads.listEntriesForSub).not.toHaveBeenCalled();
  });
});
