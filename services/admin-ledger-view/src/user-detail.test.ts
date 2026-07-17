import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted fakes so the vi.mock factories can close over them (vitest hoists vi.mock above imports).
const { fake, dbReads } = vi.hoisted(() => ({
  fake: {
    db: {}, // opaque handle — the read functions themselves are mocked below
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

beforeEach(() => {
  vi.clearAllMocks();
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
