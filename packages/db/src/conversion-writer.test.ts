import path from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appendAudit, appendWalletEntry, type WalletEntryInsert } from "./conversion-writer";
import { createMigrator } from "./migrator";
import type { Database } from "./schema";

/**
 * Writer-primitive integration tests on a real PostgreSQL 16 (ADR-0013; Docker-enabled runner —
 * CI is the gate). Verifies the idempotency the whole poll design leans on: the unique
 * `(order_id, kind, status)` index makes overlapping window re-reads no-op, while status
 * advances append new rows; audit_append chains hashes.
 */

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");

let container: StartedPostgreSqlContainer;
let db: Kysely<Database>;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  const pool = new pg.Pool({ connectionString: container.getConnectionUri() });
  await pool.query("CREATE ROLE rds_iam NOLOGIN"); // RDS-ism stand-in (see migrations.test.ts)
  db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
  const { error } = await createMigrator(db, MIGRATIONS_DIR).migrateToLatest();
  if (error) throw error;
}, 180_000);

afterAll(async () => {
  await db?.destroy();
  await container?.stop();
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
