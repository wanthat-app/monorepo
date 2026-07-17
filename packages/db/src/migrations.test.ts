import { type Kysely, sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMigrator } from "./migrator";
import type { Database } from "./schema";
import { MIGRATIONS_DIR, startTestDb, type TestDb } from "./test-harness";

/**
 * Migration integration tests (ADR-0013: Testcontainers for packages/db) — apply every plain-SQL
 * migration, in order, to a real PostgreSQL 16 and verify the money-only end state of 0006
 * (ADR-0006 decision 4): customer gone, the ledger keyed by `cognito_sub`, append-only grants
 * intact, and the audit chain appendable by the poller role — plus the 0008 service-role grant
 * surface (wallet_reader / ledger_reader / ledger_writer / audit_writer; the roles themselves
 * are created out-of-band by runbook R1, mirrored in the test harness).
 *
 * Requires Docker (ADR-0013 accepts this: integration tests run on a Docker-enabled runner).
 * Container startup lives in the shared harness (test-harness.ts).
 */

const MIGRATION_COUNT = 8;

let testDb: TestDb;
let db: Kysely<Database>;

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
}, 180_000);

afterAll(async () => {
  await testDb?.stop();
});

/** Run `fn` on one connection with the given role — grants apply, superuser powers do not. */
async function asRole<T>(role: string, fn: (trx: Kysely<Database>) => Promise<T>): Promise<T> {
  return db.transaction().execute(async (trx) => {
    await sql.raw(`SET LOCAL ROLE ${role}`).execute(trx);
    return fn(trx);
  });
}

describe("migrations 0001-0008 on real PostgreSQL", () => {
  it("apply cleanly, in order, from an empty database (fresh-env bootstrap path)", async () => {
    const { error, results } = await createMigrator(db, MIGRATIONS_DIR).migrateToLatest();
    if (error) throw error;
    expect(results).toHaveLength(MIGRATION_COUNT);
    expect(results?.every((r) => r.status === "Success")).toBe(true);
  });

  it("leave Aurora money-only: customer is gone, wallet_entry + audit_log remain", async () => {
    const { rows } = await sql<{ table_name: string }>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    `.execute(db);
    const tables = rows.map((r) => r.table_name);
    expect(tables).not.toContain("customer");
    expect(tables).toContain("wallet_entry");
    expect(tables).toContain("audit_log");
  });

  it("key the ledger by cognito_sub, not customer_id (ADR-0020 as amended)", async () => {
    const { rows } = await sql<{ column_name: string }>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'wallet_entry'
    `.execute(db);
    const columns = rows.map((r) => r.column_name);
    expect(columns).toContain("cognito_sub");
    expect(columns).not.toContain("customer_id");
  });

  it("drop both admin_delete_customer overloads (they served only the customer table)", async () => {
    const { rows } = await sql<{ n: string }>`
      SELECT count(*) AS n FROM pg_proc WHERE proname = 'admin_delete_customer'
    `.execute(db);
    expect(Number(rows[0]?.n)).toBe(0);
  });

  it("let poller_writer append ledger rows but never mutate them", async () => {
    await asRole("poller_writer", async (trx) => {
      await sql`
        INSERT INTO wallet_entry (cognito_sub, kind, amount_minor, currency, order_id, status)
        VALUES ('sub-test-1', 'referrer_cashback', 1000, 'USD', 'order-1', 'pending')
      `.execute(trx);
    });
    await expect(
      asRole("poller_writer", (trx) =>
        sql`UPDATE wallet_entry SET amount_minor = 0 WHERE cognito_sub = 'sub-test-1'`.execute(trx),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asRole("poller_writer", (trx) =>
        sql`DELETE FROM wallet_entry WHERE cognito_sub = 'sub-test-1'`.execute(trx),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it("keep app_rw and app_ro read-only on the ledger", async () => {
    for (const role of ["app_rw", "app_ro"]) {
      const rows = await asRole(role, (trx) =>
        trx.selectFrom("wallet_entry").select("cognito_sub").execute(),
      );
      expect(rows.length).toBeGreaterThan(0);
      await expect(
        asRole(role, (trx) =>
          sql`
            INSERT INTO wallet_entry (cognito_sub, kind, amount_minor, currency, status)
            VALUES ('sub-test-2', 'adjustment', 1, 'USD', 'confirmed')
          `.execute(trx),
        ),
      ).rejects.toThrow(/permission denied/);
    }
  });

  it("enforce poller idempotency: one row per (order_id, kind, status), lifecycle rows append", async () => {
    await expect(
      asRole("poller_writer", (trx) =>
        sql`
          INSERT INTO wallet_entry (cognito_sub, kind, amount_minor, currency, order_id, status)
          VALUES ('sub-test-1', 'referrer_cashback', 1000, 'USD', 'order-1', 'pending')
        `.execute(trx),
      ),
    ).rejects.toThrow(/duplicate key/);
    // The same reward advancing to 'confirmed' is a NEW row — the lifecycle is append-only.
    await asRole("poller_writer", (trx) =>
      sql`
        INSERT INTO wallet_entry (cognito_sub, kind, amount_minor, currency, order_id, status)
        VALUES ('sub-test-1', 'referrer_cashback', 1000, 'USD', 'order-1', 'confirmed')
      `.execute(trx),
    );
  });

  it("chain audit_append for poller_writer; app_rw lost its EXECUTE with the customer table", async () => {
    const first = await asRole("poller_writer", (trx) =>
      sql<{ audit_append: string }>`
        SELECT audit_append('{"type":"conversion_recorded","sub":"sub-test-1"}'::jsonb)
      `.execute(trx),
    );
    expect(first.rows).toHaveLength(1);
    await asRole("poller_writer", (trx) =>
      sql`SELECT audit_append('{"type":"conversion_confirmed","sub":"sub-test-1"}'::jsonb)`.execute(
        trx,
      ),
    );
    const { rows } = await sql<{ prev_hash: string | null; entry_hash: string }>`
      SELECT prev_hash, entry_hash FROM audit_log ORDER BY id DESC LIMIT 2
    `.execute(db);
    // Newest row's prev_hash is the previous row's entry_hash — the chain holds.
    expect(rows[0]?.prev_hash).toBe(rows[1]?.entry_hash);

    await expect(
      asRole("app_rw", (trx) => sql`SELECT audit_append('{"type":"x"}'::jsonb)`.execute(trx)),
    ).rejects.toThrow(/permission denied/);
  });

  it("lets app_ro chain a config_changed audit event, but never call audit_append directly", async () => {
    // The narrow SECURITY DEFINER wrapper (0007) is app_ro's ONLY append path: the payload
    // shape is fixed server-side, and the row must chain onto the existing audit trail.
    const appended = await asRole("app_ro", (trx) =>
      sql<{ admin_audit_config_change: string }>`
        SELECT admin_audit_config_change(
          'auth.smsEnabled', 'false'::jsonb, 'true'::jsonb, 'admin@wanthat.co.il'
        )
      `.execute(trx),
    );
    expect(appended.rows).toHaveLength(1);

    const { rows } = await sql<{
      prev_hash: string | null;
      entry_hash: string;
      payload: Record<string, unknown>;
    }>`SELECT prev_hash, entry_hash, payload FROM audit_log ORDER BY id DESC LIMIT 2`.execute(db);
    expect(rows[0]?.payload).toEqual({
      type: "config_changed",
      key: "auth.smsEnabled",
      value: false,
      previous: true,
      actor: "admin@wanthat.co.il",
    });
    // The new row chains onto the previous one - the hash chain holds across writer roles.
    expect(rows[0]?.prev_hash).toBe(rows[1]?.entry_hash);

    // Raw audit_append stays out of reach: app_ro cannot append arbitrary payloads.
    await expect(
      asRole("app_ro", (trx) => sql`SELECT audit_append('{"type":"x"}'::jsonb)`.execute(trx)),
    ).rejects.toThrow(/permission denied/);
  });

  // --- 0008 service-role grants (roles pre-exist via runbook R1, infra/lib/README.md) ---

  it("lets audit_writer chain via audit_append, and nothing else", async () => {
    await asRole("audit_writer", (trx) =>
      sql`SELECT audit_append('{"type":"config_changed","key":"k","actor":"a@wanthat.app"}'::jsonb)`.execute(
        trx,
      ),
    );
    const { rows } = await sql<{ prev_hash: string | null; entry_hash: string }>`
      SELECT prev_hash, entry_hash FROM audit_log ORDER BY id DESC LIMIT 2
    `.execute(db);
    // The appended row chains onto the previous writer's tail — one unforked chain across roles.
    expect(rows[0]?.prev_hash).toBe(rows[1]?.entry_hash);

    // No direct table access: audit_append (definer context) is audit_writer's ONLY capability.
    for (const stmt of [
      sql`INSERT INTO audit_log (prev_hash, entry_hash, payload) VALUES (NULL, 'x', '{}'::jsonb)`,
      sql`UPDATE audit_log SET payload = '{}'::jsonb`,
      sql`DELETE FROM audit_log`,
      sql`INSERT INTO wallet_entry (cognito_sub, kind, amount_minor, currency, status)
          VALUES ('sub-aw', 'adjustment', 1, 'USD', 'confirmed')`,
      sql`UPDATE wallet_entry SET amount_minor = 0`,
      sql`DELETE FROM wallet_entry`,
      sql`SELECT count(*) FROM wallet_entry`,
    ]) {
      await expect(asRole("audit_writer", (trx) => stmt.execute(trx))).rejects.toThrow(
        /permission denied/,
      );
    }
  });

  it("keeps ledger_reader read-only over the ledger AND the audit log", async () => {
    const entries = await asRole("ledger_reader", (trx) =>
      trx.selectFrom("wallet_entry").select("cognito_sub").execute(),
    );
    expect(entries.length).toBeGreaterThan(0);
    const audits = await asRole("ledger_reader", (trx) =>
      sql<{ n: string }>`SELECT count(*) AS n FROM audit_log`.execute(trx),
    );
    expect(Number(audits.rows[0]?.n)).toBeGreaterThan(0);

    for (const stmt of [
      sql`INSERT INTO wallet_entry (cognito_sub, kind, amount_minor, currency, status)
          VALUES ('sub-lr', 'adjustment', 1, 'USD', 'confirmed')`,
      sql`UPDATE wallet_entry SET amount_minor = 0`,
      sql`DELETE FROM wallet_entry`,
      sql`INSERT INTO audit_log (prev_hash, entry_hash, payload) VALUES (NULL, 'x', '{}'::jsonb)`,
      sql`UPDATE audit_log SET payload = '{}'::jsonb`,
      sql`DELETE FROM audit_log`,
      sql`SELECT audit_append('{"type":"x"}'::jsonb)`,
    ]) {
      await expect(asRole("ledger_reader", (trx) => stmt.execute(trx))).rejects.toThrow(
        /permission denied/,
      );
    }
  });

  it("scopes wallet_reader to the ledger: SELECT wallet_entry, no audit_log at all", async () => {
    const rows = await asRole("wallet_reader", (trx) =>
      trx.selectFrom("wallet_entry").select("cognito_sub").execute(),
    );
    expect(rows.length).toBeGreaterThan(0);

    for (const stmt of [
      sql`SELECT count(*) FROM audit_log`,
      sql`INSERT INTO wallet_entry (cognito_sub, kind, amount_minor, currency, status)
          VALUES ('sub-wr', 'adjustment', 1, 'USD', 'confirmed')`,
      sql`UPDATE wallet_entry SET amount_minor = 0`,
      sql`DELETE FROM wallet_entry`,
      sql`SELECT audit_append('{"type":"x"}'::jsonb)`,
    ]) {
      await expect(asRole("wallet_reader", (trx) => stmt.execute(trx))).rejects.toThrow(
        /permission denied/,
      );
    }
  });

  it("makes ledger_writer append-only: INSERT + audit_append yes, mutation never", async () => {
    await asRole("ledger_writer", (trx) =>
      sql`
        INSERT INTO wallet_entry (cognito_sub, kind, amount_minor, currency, order_id, status)
        VALUES ('sub-lw', 'referrer_cashback', 500, 'USD', 'order-lw-1', 'pending')
      `.execute(trx),
    );
    await asRole("ledger_writer", (trx) =>
      sql`SELECT audit_append('{"type":"wallet_entry","orderId":"order-lw-1"}'::jsonb)`.execute(
        trx,
      ),
    );

    for (const stmt of [
      sql`UPDATE wallet_entry SET amount_minor = 0 WHERE order_id = 'order-lw-1'`,
      sql`DELETE FROM wallet_entry WHERE order_id = 'order-lw-1'`,
      sql`INSERT INTO audit_log (prev_hash, entry_hash, payload) VALUES (NULL, 'x', '{}'::jsonb)`,
      sql`UPDATE audit_log SET payload = '{}'::jsonb`,
      sql`DELETE FROM audit_log`,
    ]) {
      await expect(asRole("ledger_writer", (trx) => stmt.execute(trx))).rejects.toThrow(
        /permission denied/,
      );
    }
  });
});
