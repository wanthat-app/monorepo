import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted fakes so the vi.mock factories can close over them (vitest hoists vi.mock above imports).
const { fake, dbReads } = vi.hoisted(() => ({
  fake: {
    region: "il-central-1",
    db: {}, // opaque handle — the read functions themselves are mocked below
    fx: { get: vi.fn() },
    config: { get: vi.fn() },
  },
  dbReads: {
    listEntriesForSub: vi.fn(),
    listWalletHistory: vi.fn(),
  },
}));

vi.mock("../context", () => ({ getContext: () => fake }));
// The ledger queries are integration-tested in packages/db (testcontainers); here they are seams.
vi.mock("@wanthat/db", () => dbReads);

import { walletRouter } from "./router";

const app = new Hono();
app.route("/wallet", walletRouter());

const SUB = "11111111-1111-1111-1111-111111111111";
const authed = {
  event: { requestContext: { authorizer: { jwt: { claims: { sub: SUB } } } } },
};

const get = (path: string, env?: object) => app.request(path, { method: "GET" }, env);
const json = async <T>(res: Response) => (await res.json()) as T;

const USD_RATE = { base: "USD", quote: "ILS", rate: "3.5", asOf: "2026-07-10T06:00:00.000Z" };
// One reward advancing pending → confirmed (counts once, confirmed) + one still-pending reward.
const LEDGER_ROWS = [
  {
    kind: "referrer_cashback",
    amountMinor: 400n,
    currency: "USD",
    orderId: "o-1",
    status: "pending",
  },
  {
    kind: "referrer_cashback",
    amountMinor: 400n,
    currency: "USD",
    orderId: "o-1",
    status: "confirmed",
  },
  {
    kind: "consumer_reward",
    amountMinor: 200n,
    currency: "USD",
    orderId: "o-2",
    status: "pending",
  },
];

const ENTRY_AT = "2026-07-10T10:00:00.000Z";
const HISTORY_ITEM = {
  id: "22222222-2222-4222-8222-222222222222",
  kind: "referrer_cashback",
  amountMinor: 400n,
  currency: "USD",
  recommendationId: "AbC123xYz01",
  status: "confirmed",
  createdAt: new Date(ENTRY_AT),
};

beforeEach(() => {
  vi.clearAllMocks();
  fake.config.get.mockResolvedValue(200); // fx.conversionCommissionBps
  fake.fx.get.mockResolvedValue(USD_RATE);
});

describe("GET /wallet", () => {
  it("derives balances from the ledger and estimates ILS off the cached USD rate", async () => {
    dbReads.listEntriesForSub.mockResolvedValue(LEDGER_ROWS);
    const res = await get("/wallet", authed);
    expect(res.status).toBe(200);
    expect(dbReads.listEntriesForSub).toHaveBeenCalledWith(fake.db, SUB);
    expect(fake.fx.get).toHaveBeenCalledWith("USD", "ILS");
    expect(await res.json()).toEqual({
      balances: [
        {
          asRecommender: {
            confirmed: { amountMinor: "400", currency: "USD" },
            pending: { amountMinor: "0", currency: "USD" },
          },
          asBuyer: {
            confirmed: { amountMinor: "0", currency: "USD" },
            pending: { amountMinor: "200", currency: "USD" },
          },
          available: { amountMinor: "400", currency: "USD" },
        },
      ],
      estimated: {
        // convertMinor at rate 3.5 minus 200 bps: 400 → 1400 → 1372; pending 0+200 → 700 → 686.
        available: { amountMinor: "1372", currency: "ILS" },
        pending: { amountMinor: "686", currency: "ILS" },
      },
    });
  });

  it("returns estimated null when no USD→ILS rate is cached", async () => {
    dbReads.listEntriesForSub.mockResolvedValue(LEDGER_ROWS);
    fake.fx.get.mockResolvedValue(undefined);
    const body = await json<{ balances: unknown[]; estimated: unknown }>(
      await get("/wallet", authed),
    );
    expect(body.estimated).toBeNull();
    expect(body.balances).toHaveLength(1);
  });

  it("estimates a hard zero when no USD balance is held (rate never consulted)", async () => {
    dbReads.listEntriesForSub.mockResolvedValue([
      {
        kind: "adjustment",
        amountMinor: 100n,
        currency: "ILS",
        orderId: null,
        status: "confirmed",
      },
    ]);
    const body = await json<{ balances: unknown[]; estimated: unknown }>(
      await get("/wallet", authed),
    );
    expect(body.balances).toEqual([
      expect.objectContaining({ available: { amountMinor: "100", currency: "ILS" } }),
    ]);
    expect(body.estimated).toEqual({
      available: { amountMinor: "0", currency: "ILS" },
      pending: { amountMinor: "0", currency: "ILS" },
    });
    expect(fake.fx.get).not.toHaveBeenCalled();
  });

  it("serves an empty ledger as empty balances with a zero estimate", async () => {
    dbReads.listEntriesForSub.mockResolvedValue([]);
    expect(await (await get("/wallet", authed)).json()).toEqual({
      balances: [],
      estimated: {
        available: { amountMinor: "0", currency: "ILS" },
        pending: { amountMinor: "0", currency: "ILS" },
      },
    });
    expect(fake.fx.get).not.toHaveBeenCalled();
  });

  it("401s without authorizer claims", async () => {
    expect((await get("/wallet")).status).toBe(401);
  });
});

describe("GET /wallet/entries", () => {
  it("maps the history page to the wire and round-trips the keyset cursor", async () => {
    dbReads.listWalletHistory.mockResolvedValueOnce({
      items: [HISTORY_ITEM],
      nextCursor: { createdAt: new Date(ENTRY_AT), id: HISTORY_ITEM.id },
    });
    const res = await get("/wallet/entries?limit=1", authed);
    expect(res.status).toBe(200);
    expect(dbReads.listWalletHistory).toHaveBeenCalledWith(fake.db, SUB, 1, undefined);
    const body = await json<{ items: unknown[]; nextCursor: string }>(res);
    expect(body.items).toEqual([
      {
        id: HISTORY_ITEM.id,
        kind: "referrer_cashback",
        amount: { amountMinor: "400", currency: "USD" },
        status: "confirmed",
        recommendationId: "AbC123xYz01",
        createdAt: ENTRY_AT,
      },
    ]);
    expect(typeof body.nextCursor).toBe("string");

    // Feeding the cursor back resumes from the same (createdAt, id) key, then terminates.
    dbReads.listWalletHistory.mockResolvedValueOnce({ items: [], nextCursor: null });
    const res2 = await get(`/wallet/entries?limit=1&cursor=${body.nextCursor}`, authed);
    expect(dbReads.listWalletHistory).toHaveBeenLastCalledWith(fake.db, SUB, 1, {
      createdAt: new Date(ENTRY_AT),
      id: HISTORY_ITEM.id,
    });
    expect(await res2.json()).toEqual({ items: [], nextCursor: null });
  });

  it("ignores a malformed cursor and reads from the top", async () => {
    dbReads.listWalletHistory.mockResolvedValue({ items: [], nextCursor: null });
    const res = await get("/wallet/entries?cursor=%%%not-base64url", authed);
    expect(res.status).toBe(200);
    expect(dbReads.listWalletHistory).toHaveBeenCalledWith(fake.db, SUB, 20, undefined);
  });

  it("400s on an invalid limit", async () => {
    expect((await get("/wallet/entries?limit=oops", authed)).status).toBe(400);
    expect((await get("/wallet/entries?limit=200", authed)).status).toBe(400);
  });

  it("401s without authorizer claims", async () => {
    expect((await get("/wallet/entries")).status).toBe(401);
  });
});
