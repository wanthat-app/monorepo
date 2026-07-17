import { type Kysely, sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appendAudit } from "./audit";
import {
  appendWalletEntry,
  conversionTotalsFor,
  type WalletEntryInsert,
} from "./conversion-writer";
import { createMigrator } from "./migrator";
import type { Database } from "./schema";
import { MIGRATIONS_DIR, startTestDb, type TestDb } from "./test-harness";

/**
 * Writer-primitive integration tests on a real PostgreSQL 16 (ADR-0013; Docker-enabled runner —
 * CI is the gate). Verifies the idempotency the whole poll design leans on: the unique
 * `(order_id, kind, status)` index makes overlapping window re-reads no-op, while status
 * advances append new rows; audit_append chains hashes.
 */

let testDb: TestDb;
let db: Kysely<Database>;

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
  const { error } = await createMigrator(db, MIGRATIONS_DIR).migrateToLatest();
  if (error) throw error;
}, 180_000);

afterAll(async () => {
  await testDb?.stop();
});

const ENTRY: WalletEntryInsert = {
  cognitoSub: "22222222-2222-2222-2222-222222222222",
  kind: "referrer_cashback",
  amountMinor: 62n,
  currency: "USD",
  orderId: "8123456789",
  recommendationId: "abc123DEF45",
  status: "pending",
};

describe("appendWalletEntry", () => {
  it("inserts once, no-ops the duplicate, appends a status advance as a new row", async () => {
    expect(await appendWalletEntry(db, ENTRY)).toBe(true);
    expect(await appendWalletEntry(db, ENTRY)).toBe(false); // idempotent re-read

    expect(await appendWalletEntry(db, { ...ENTRY, status: "confirmed" })).toBe(true);
    expect(
      await appendWalletEntry(db, { ...ENTRY, kind: "consumer_reward", amountMinor: 31n }),
    ).toBe(true);

    const rows = await db
      .selectFrom("wallet_entry")
      .select(["kind", "status", "amount_minor"])
      .where("order_id", "=", ENTRY.orderId)
      .execute();
    expect(rows).toHaveLength(3);
    const referrerRows = rows.filter((r) => r.kind === "referrer_cashback");
    expect(referrerRows.map((r) => r.status).sort()).toEqual(["confirmed", "pending"]);
  });
});

describe("conversionTotalsFor", () => {
  it("counts distinct orders per recommendation: multi-status once, clawback still counted", async () => {
    const REC = "recTotalsAA1";
    const OTHER = "recTotalsBB2";
    // Order A walks the whole lifecycle — three rows, ONE converted order.
    for (const status of ["pending", "confirmed", "clawback"] as const) {
      await appendWalletEntry(db, { ...ENTRY, recommendationId: REC, orderId: "tot-A", status });
    }
    // Order B converts once; its consumer_reward row must NOT count toward the stat.
    await appendWalletEntry(db, { ...ENTRY, recommendationId: REC, orderId: "tot-B" });
    await appendWalletEntry(db, {
      ...ENTRY,
      recommendationId: REC,
      orderId: "tot-B",
      kind: "consumer_reward",
      amountMinor: 31n,
    });
    // A different recommendation's order stays out of REC's total.
    await appendWalletEntry(db, { ...ENTRY, recommendationId: OTHER, orderId: "tot-C" });

    const totals = await conversionTotalsFor(db, [REC, OTHER, "recNoRows999"]);
    expect(totals).toEqual({ [REC]: 2, [OTHER]: 1, recNoRows999: 0 });
  });

  it("answers an empty record for an empty id list", async () => {
    expect(await conversionTotalsFor(db, [])).toEqual({});
  });
});

describe("appendAudit", () => {
  it("chains entry hashes through audit_append", async () => {
    await appendAudit(db, { type: "wallet_entry", orderId: "8123456789", n: 1 });
    await appendAudit(db, { type: "wallet_entry", orderId: "8123456789", n: 2 });
    const { rows } = await sql<{ prev_hash: string | null; entry_hash: string }>`
      SELECT prev_hash, entry_hash FROM audit_log ORDER BY id ASC
    `.execute(db);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const last = rows[rows.length - 1];
    const beforeLast = rows[rows.length - 2];
    expect(last?.prev_hash).toBe(beforeLast?.entry_hash);
    expect(last?.entry_hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
