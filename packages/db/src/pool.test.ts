import {
  type DatabaseConnection,
  type Driver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from "kysely";
import { describe, expect, it, vi } from "vitest";
import { waitForDb } from "./pool";
import type { Database } from "./schema";

/**
 * A Kysely whose driver fails `acquireConnection` the first `failTimes` times (simulating a paused
 * Aurora refusing the connection) then succeeds — lets us exercise waitForDb's retry without a real DB.
 */
function fakeDb(failTimes: number): { db: Kysely<Database>; attempts: () => number } {
  let attempts = 0;
  const connection: DatabaseConnection = {
    executeQuery: async () => ({ rows: [] }),
    // waitForDb only ever runs `select 1` (executeQuery); this stream stub is never invoked, but it
    // yields once to satisfy the interface without an empty generator.
    streamQuery: async function* () {
      yield { rows: [] };
    },
  };
  const driver: Driver = {
    init: async () => {},
    acquireConnection: async () => {
      attempts++;
      if (attempts <= failTimes) throw new Error("connect ETIMEDOUT 10.0.1.222:5432");
      return connection;
    },
    beginTransaction: async () => {},
    commitTransaction: async () => {},
    rollbackTransaction: async () => {},
    releaseConnection: async () => {},
    destroy: async () => {},
  };
  const db = new Kysely<Database>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (d) => new PostgresIntrospector(d),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  return { db, attempts: () => attempts };
}

/**
 * A Kysely whose connection is acquired fine but whose `executeQuery` (the `select 1`) HANGS the
 * first `hangTimes` times, then resolves — simulating a resuming Aurora that accepts the TCP
 * connection but is not yet serving queries (the observed prod ledger-writer 90s hang).
 */
function hangingDb(hangTimes: number): { db: Kysely<Database>; calls: () => number } {
  let calls = 0;
  const connection: DatabaseConnection = {
    executeQuery: () => {
      calls++;
      if (calls <= hangTimes) return new Promise(() => {}); // never settles
      return Promise.resolve({ rows: [] });
    },
    streamQuery: async function* () {
      yield { rows: [] };
    },
  };
  const driver: Driver = {
    init: async () => {},
    acquireConnection: async () => connection,
    beginTransaction: async () => {},
    commitTransaction: async () => {},
    rollbackTransaction: async () => {},
    releaseConnection: async () => {},
    destroy: async () => {},
  };
  const db = new Kysely<Database>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (d) => new PostgresIntrospector(d),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  return { db, calls: () => calls };
}

describe("waitForDb (cold Aurora resume, ADR-0003)", () => {
  it("returns once the connection succeeds after transient failures", async () => {
    const { db, attempts } = fakeDb(2); // fails twice, then up
    await waitForDb(db, { attempts: 5, delayMs: 1 });
    expect(attempts()).toBe(3); // 2 failures + 1 success
  });

  it("succeeds on the first attempt when the cluster is already warm", async () => {
    const { db, attempts } = fakeDb(0);
    await waitForDb(db, { attempts: 5, delayMs: 1 });
    expect(attempts()).toBe(1);
  });

  it("rethrows the last error after exhausting all attempts (cluster never wakes)", async () => {
    const { db, attempts } = fakeDb(99);
    await expect(waitForDb(db, { attempts: 3, delayMs: 1 })).rejects.toThrow(/ETIMEDOUT/);
    expect(attempts()).toBe(3);
  });

  it("logs each retry (but not the final throw) with attempt context", async () => {
    const { db } = fakeDb(2);
    const log = vi.fn();
    await waitForDb(db, { attempts: 5, delayMs: 1, log });
    expect(log).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith(
      "db_connect_retry",
      expect.objectContaining({ attempt: 1, of: 5 }),
    );
  });

  it("with probeTimeoutMs, abandons a HANGING probe and retries until it responds", async () => {
    const { db, calls } = hangingDb(2); // select 1 hangs twice, then serves
    await waitForDb(db, { attempts: 5, delayMs: 1, probeTimeoutMs: 15 });
    expect(calls()).toBe(3); // 2 timed-out probes + 1 that responded
  });

  it("with probeTimeoutMs, throws after attempts instead of hanging the whole Lambda budget", async () => {
    const { db } = hangingDb(99); // never serves
    await expect(waitForDb(db, { attempts: 3, delayMs: 1, probeTimeoutMs: 15 })).rejects.toThrow(
      /probe timed out/,
    );
  });
});
