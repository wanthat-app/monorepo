import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMigrator } from "./migrator";
import type { Database } from "./schema";
import { MIGRATIONS_DIR, startTestDb, type TestDb } from "./test-harness";
import { listEntriesForSub, listWalletHistory } from "./wallet";

/**
 * Wallet read-path integration tests (ADR-0013: Testcontainers; Docker-enabled runner). Fixtures
 * share ONE created_at so the history pagination is forced onto the id tiebreak — the worst case
 * for keyset cursors.
 */

const SUB = "sub-wallet-1";
const OTHER_SUB = "sub-wallet-2";
const AT = new Date("2026-07-10T10:00:00.000Z");
// Explicit ids make the `id DESC` tiebreak deterministic under the shared timestamp.
const ID1 = "00000000-0000-4000-8000-000000000001";
const ID2 = "00000000-0000-4000-8000-000000000002";
const ID3 = "00000000-0000-4000-8000-000000000003";

let testDb: TestDb;
let db: Kysely<Database>;

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
  const { error } = await createMigrator(db, MIGRATIONS_DIR).migrateToLatest();
  if (error) throw error;

  await db
    .insertInto("wallet_entry")
    .values([
      {
        id: ID1,
        cognito_sub: SUB,
        kind: "referrer_cashback",
        amount_minor: 400n,
        currency: "USD",
        order_id: "order-a",
        recommendation_id: "rec-1",
        status: "pending",
        created_at: AT,
      },
      {
        id: ID2,
        cognito_sub: SUB,
        kind: "consumer_reward",
        amount_minor: 200n,
        currency: "USD",
        order_id: "order-a",
        recommendation_id: "rec-1",
        status: "pending",
        created_at: AT,
      },
      {
        id: ID3,
        cognito_sub: SUB,
        kind: "referrer_cashback",
        amount_minor: 400n,
        currency: "USD",
        order_id: "order-a",
        recommendation_id: "rec-1",
        status: "confirmed",
        created_at: AT,
      },
      // Someone else's money must never leak into SUB's reads.
      {
        cognito_sub: OTHER_SUB,
        kind: "referrer_cashback",
        amount_minor: 999n,
        currency: "USD",
        order_id: "order-b",
        recommendation_id: "rec-2",
        status: "pending",
        created_at: AT,
      },
    ])
    .execute();
}, 180_000);

afterAll(async () => {
  await testDb?.stop();
});

describe("listEntriesForSub", () => {
  it("returns only the sub's rows, amounts as bigint", async () => {
    const rows = await listEntriesForSub(db, SUB);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => typeof r.amountMinor === "bigint")).toBe(true);
    expect(rows.map((r) => r.status).sort()).toEqual(["confirmed", "pending", "pending"]);
    expect(rows.every((r) => r.orderId === "order-a")).toBe(true);
  });

  it("returns [] for a sub with no entries", async () => {
    expect(await listEntriesForSub(db, "sub-nobody")).toEqual([]);
  });
});

describe("listWalletHistory", () => {
  it("pages newest-first on the id tiebreak and terminates", async () => {
    const first = await listWalletHistory(db, SUB, 2);
    expect(first.items.map((i) => i.id)).toEqual([ID3, ID2]);
    expect(first.items[0]).toMatchObject({
      kind: "referrer_cashback",
      amountMinor: 400n,
      currency: "USD",
      recommendationId: "rec-1",
      status: "confirmed",
    });
    expect(first.items[0]?.createdAt).toEqual(AT);
    expect(first.nextCursor).toEqual({ createdAt: AT, id: ID2 });

    const second = await listWalletHistory(db, SUB, 2, first.nextCursor ?? undefined);
    expect(second.items.map((i) => i.id)).toEqual([ID1]);
    expect(second.nextCursor).toBeNull();
  });

  it("reports no next page when the fixture fits exactly", async () => {
    const page = await listWalletHistory(db, SUB, 3);
    expect(page.items).toHaveLength(3);
    expect(page.nextCursor).toBeNull();
  });
});
