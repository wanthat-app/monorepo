# Admin Money KPIs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The dashboard's money placeholders become real ledger-derived KPIs: Cashback earned, Pending cashback, Conversions (30d) + trend, ₪ per active member (30d).

**Architecture:** Approach A (spec 2026-07-13): admin-api derives everything at read time from the append-only `wallet_entry` ledger via a new pure `deriveMoneyStats` in `@wanthat/domain` (mirroring `deriveBalances` lifecycle-collapse semantics), converts ₪ estimates exactly like the member wallet (`convertMinor` + cached FX + commission bps), and serves one new `GET /admin/stats/money`. No stored totals anywhere.

**Tech Stack:** TypeScript/Node 24, Kysely (Aurora `app_ro`), Zod contracts, Hono, Vitest (+ Testcontainers for the db read), AWS CDK, React SPA.

**Spec:** `docs/superpowers/specs/2026-07-13-admin-money-kpis-design.md`

## Global Constraints

- Money is exact bigint code-side; decimal STRING on the JSON wire (`moneyJson` serializer). Never floats.
- Lifecycle collapse per `(currency, order_id, kind)`: furthest status wins (`pending < confirmed < clawback`), clawback contributes 0; NULL `order_id` rows stand alone.
- A conversion = one DISTINCT non-null `order_id` (both reward kinds on one order = ONE conversion), bucketed to the Jerusalem date of its EARLIEST reward row.
- All date bucketing Asia/Jerusalem (`jerusalemDate`/`lastNDates` from `@wanthat/dynamo`); `@wanthat/domain` stays pure — rows arrive pre-stamped with their bucket date.
- Rename "Pending payouts" → "Pending cashback"; "Link conversion" → "Conversions (30d)".
- Infra description fields ASCII-only; NEVER set reserved concurrency.
- db tests need Docker: `export DOCKER_HOST=unix:///Users/dennis/.colima/default/docker.sock`.
- Verification pre-PR: `pnpm lint && pnpm typecheck && pnpm test && pnpm synth`. Delivery STOPS at the open PR — merge/deploy stays with Dennis.

---

### Task 0: Branch

- [ ] **Step 1:**

```bash
cd /Users/dennis/projects/wanthat-app/monorepo
git checkout main && git pull && git checkout -b feat/admin-money-kpis
```

---

### Task 1: `@wanthat/domain` — deriveMoneyStats (pure derivation)

**Files:**
- Create: `packages/domain/src/money-stats.ts`
- Create: `packages/domain/src/money-stats.test.ts`
- Modify: `packages/domain/src/index.ts` (add `export { deriveMoneyStats, type MoneyStatsRow, type MoneyCurrencyTotals, type DerivedMoneyStats } from "./money-stats";`)

**Interfaces:**
- Consumes: nothing new (`WalletEntryKind`/`WalletEntryStatus` types exist in `@wanthat/contracts`; STATUS_RANK semantics documented in `packages/domain/src/wallet.ts`).
- Produces (used by Task 4):
  - `interface MoneyStatsRow { kind: "referrer_cashback" | "consumer_reward"; amountMinor: bigint; currency: string; orderId: string | null; status: "pending" | "confirmed" | "clawback"; date: string }` (date = Jerusalem bucket, `YYYY-MM-DD`).
  - `interface MoneyCurrencyTotals { currency: string; confirmedMinor: bigint; pendingMinor: bigint; confirmedInWindowMinor: bigint }`
  - `interface DerivedMoneyStats { totals: MoneyCurrencyTotals[]; conversionsInWindow: number; dailyConversions: { date: string; count: number }[] }`
  - `function deriveMoneyStats(rows: MoneyStatsRow[], dates: string[]): DerivedMoneyStats` — `dates` is the dense ascending window; `dailyConversions` covers exactly those dates, zero-filled; `totals` sorted by currency.

- [ ] **Step 1: Write the failing tests** — `packages/domain/src/money-stats.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { deriveMoneyStats, type MoneyStatsRow } from "./money-stats";

const DATES = ["2026-07-11", "2026-07-12", "2026-07-13"];

const row = (over: Partial<MoneyStatsRow>): MoneyStatsRow => ({
  kind: "referrer_cashback",
  amountMinor: 500n,
  currency: "USD",
  orderId: "order-1",
  status: "pending",
  date: "2026-07-12",
  ...over,
});

describe("deriveMoneyStats — lifecycle collapse", () => {
  it("furthest status wins: pending+confirmed rows count once, as confirmed", () => {
    const stats = deriveMoneyStats(
      [row({ status: "pending", date: "2026-07-11" }), row({ status: "confirmed" })],
      DATES,
    );
    expect(stats.totals).toEqual([
      {
        currency: "USD",
        confirmedMinor: 500n,
        pendingMinor: 0n,
        confirmedInWindowMinor: 500n,
      },
    ]);
  });

  it("clawback contributes zero everywhere", () => {
    const stats = deriveMoneyStats(
      [row({ status: "pending" }), row({ status: "confirmed" }), row({ status: "clawback" })],
      DATES,
    );
    expect(stats.totals[0]?.confirmedMinor).toBe(0n);
    expect(stats.totals[0]?.pendingMinor).toBe(0n);
    expect(stats.totals[0]?.confirmedInWindowMinor).toBe(0n);
  });

  it("same order, different kinds collapse separately", () => {
    const stats = deriveMoneyStats(
      [
        row({ kind: "referrer_cashback", status: "confirmed", amountMinor: 500n }),
        row({ kind: "consumer_reward", status: "pending", amountMinor: 200n }),
      ],
      DATES,
    );
    expect(stats.totals[0]?.confirmedMinor).toBe(500n);
    expect(stats.totals[0]?.pendingMinor).toBe(200n);
  });

  it("NULL orderId rows stand alone (never collapsed together)", () => {
    const stats = deriveMoneyStats(
      [
        row({ orderId: null, status: "pending", amountMinor: 100n }),
        row({ orderId: null, status: "pending", amountMinor: 100n }),
      ],
      DATES,
    );
    expect(stats.totals[0]?.pendingMinor).toBe(200n);
  });
});

describe("deriveMoneyStats — window", () => {
  it("confirmed-in-window uses the CONFIRMED row's date, not the pending row's", () => {
    const stats = deriveMoneyStats(
      [
        row({ status: "pending", date: "2026-06-01" }), // long before the window
        row({ status: "confirmed", date: "2026-07-12" }),
      ],
      DATES,
    );
    expect(stats.totals[0]?.confirmedInWindowMinor).toBe(500n);
  });

  it("a reward confirmed before the window counts all-time but not in-window", () => {
    const stats = deriveMoneyStats([row({ status: "confirmed", date: "2026-06-01" })], DATES);
    expect(stats.totals[0]?.confirmedMinor).toBe(500n);
    expect(stats.totals[0]?.confirmedInWindowMinor).toBe(0n);
  });
});

describe("deriveMoneyStats — conversions", () => {
  it("both kinds on one order = ONE conversion, bucketed to the earliest row's date", () => {
    const stats = deriveMoneyStats(
      [
        row({ kind: "referrer_cashback", date: "2026-07-12" }),
        row({ kind: "consumer_reward", date: "2026-07-13" }),
      ],
      DATES,
    );
    expect(stats.conversionsInWindow).toBe(1);
    expect(stats.dailyConversions).toEqual([
      { date: "2026-07-11", count: 0 },
      { date: "2026-07-12", count: 1 },
      { date: "2026-07-13", count: 0 },
    ]);
  });

  it("orders first seen before the window are not window conversions", () => {
    const stats = deriveMoneyStats(
      [row({ date: "2026-06-01" }), row({ orderId: "order-2", date: "2026-07-13" })],
      DATES,
    );
    expect(stats.conversionsInWindow).toBe(1);
  });

  it("orphan rows (null orderId) are not conversions", () => {
    const stats = deriveMoneyStats([row({ orderId: null })], DATES);
    expect(stats.conversionsInWindow).toBe(0);
  });

  it("clawed-back orders still COUNT as conversions (the order happened)", () => {
    const stats = deriveMoneyStats(
      [row({ status: "pending" }), row({ status: "clawback", date: "2026-07-13" })],
      DATES,
    );
    expect(stats.conversionsInWindow).toBe(1);
  });
});

describe("deriveMoneyStats — shape", () => {
  it("multi-currency totals are sorted by currency", () => {
    const stats = deriveMoneyStats(
      [
        row({ currency: "USD", status: "confirmed" }),
        row({ currency: "ILS", orderId: "order-ils", status: "pending", amountMinor: 300n }),
      ],
      DATES,
    );
    expect(stats.totals.map((t) => t.currency)).toEqual(["ILS", "USD"]);
  });

  it("an empty ledger yields empty totals and a dense zero series", () => {
    const stats = deriveMoneyStats([], DATES);
    expect(stats.totals).toEqual([]);
    expect(stats.conversionsInWindow).toBe(0);
    expect(stats.dailyConversions).toEqual(DATES.map((date) => ({ date, count: 0 })));
  });
});
```

- [ ] **Step 2:** Run: `pnpm --filter @wanthat/domain test -- money-stats` — Expected: FAIL (module not found).

- [ ] **Step 3: Implement** — `packages/domain/src/money-stats.ts`:

```ts
/**
 * Platform-wide money KPI derivation over reward rows of the append-only `wallet_entry` ledger
 * (spec 2026-07-13). Same lifecycle model as `deriveBalances` (wallet.ts): a reward's rows share
 * `(currency, orderId, kind)` and the furthest-advanced status wins — pending < confirmed <
 * clawback, clawback contributes 0. Pure exact-bigint math; the caller fetches rows
 * (`@wanthat/db` `listRewardRows`) and pre-stamps each with its Asia/Jerusalem bucket `date`
 * (this module stays timezone- and IO-free).
 */

export interface MoneyStatsRow {
  kind: "referrer_cashback" | "consumer_reward";
  amountMinor: bigint;
  currency: string;
  orderId: string | null;
  status: "pending" | "confirmed" | "clawback";
  /** Asia/Jerusalem bucket of the row's created_at, YYYY-MM-DD (caller-computed). */
  date: string;
}

export interface MoneyCurrencyTotals {
  currency: string;
  /** All-time Σ of collapsed rewards at `confirmed`. */
  confirmedMinor: bigint;
  /** All-time Σ of collapsed rewards at `pending`. */
  pendingMinor: bigint;
  /** Σ of rewards whose collapsed status is confirmed AND whose confirmed row falls in the window. */
  confirmedInWindowMinor: bigint;
}

export interface DerivedMoneyStats {
  /** Per-currency totals, sorted by currency (deterministic wire order). */
  totals: MoneyCurrencyTotals[];
  /** Distinct orders (any reward row) first seen inside the window. */
  conversionsInWindow: number;
  /** Dense daily distinct-order counts over exactly the given dates. */
  dailyConversions: { date: string; count: number }[];
}

const STATUS_RANK = { pending: 0, confirmed: 1, clawback: 2 } as const;

/**
 * Derive the dashboard money KPIs. `dates` is the dense ascending 30-day axis (Jerusalem);
 * window membership is set membership in `dates`.
 */
export function deriveMoneyStats(rows: MoneyStatsRow[], dates: string[]): DerivedMoneyStats {
  const window = new Set(dates);

  // Collapse each reward's lifecycle rows to the furthest-advanced row (deriveBalances rule);
  // orphan rows (no orderId) stand alone. Track each distinct order's earliest-seen date.
  const rewards = new Map<string, MoneyStatsRow>();
  const orderFirstSeen = new Map<string, string>();
  let orphan = 0;
  for (const row of rows) {
    const key =
      row.orderId === null ? `orphan#${orphan++}` : `${row.currency}#${row.orderId}#${row.kind}`;
    const seen = rewards.get(key);
    if (!seen || STATUS_RANK[row.status] > STATUS_RANK[seen.status]) rewards.set(key, row);
    if (row.orderId !== null) {
      const first = orderFirstSeen.get(row.orderId);
      if (!first || row.date < first) orderFirstSeen.set(row.orderId, row.date);
    }
  }

  const perCurrency = new Map<string, MoneyCurrencyTotals>();
  const totalsFor = (currency: string): MoneyCurrencyTotals => {
    let totals = perCurrency.get(currency);
    if (!totals) {
      totals = { currency, confirmedMinor: 0n, pendingMinor: 0n, confirmedInWindowMinor: 0n };
      perCurrency.set(currency, totals);
    }
    return totals;
  };
  for (const reward of rewards.values()) {
    const totals = totalsFor(reward.currency);
    if (reward.status === "clawback") continue; // clawed back: contributes 0 (but keeps its currency row)
    if (reward.status === "confirmed") {
      totals.confirmedMinor += reward.amountMinor;
      // The winning row IS the confirmed row, so its date is the confirmation bucket.
      if (window.has(reward.date)) totals.confirmedInWindowMinor += reward.amountMinor;
    } else {
      totals.pendingMinor += reward.amountMinor;
    }
  }

  // Conversions: one per distinct order, on its earliest-seen bucket.
  const byDay = new Map(dates.map((d) => [d, 0]));
  let conversionsInWindow = 0;
  for (const first of orderFirstSeen.values()) {
    if (!window.has(first)) continue;
    conversionsInWindow += 1;
    byDay.set(first, (byDay.get(first) ?? 0) + 1);
  }

  return {
    totals: [...perCurrency.values()].sort((a, b) => a.currency.localeCompare(b.currency)),
    conversionsInWindow,
    dailyConversions: dates.map((date) => ({ date, count: byDay.get(date) ?? 0 })),
  };
}
```

- [ ] **Step 4:** Run: `pnpm --filter @wanthat/domain test -- money-stats` — Expected: PASS (11 tests). NOTE the "multi-currency" test: a currency whose only reward is clawed back still creates a zeroed row via `totalsFor` before the `continue` — the test above doesn't exercise that, this is intentional (a currency row of zeros is harmless and keeps the loop simple).

- [ ] **Step 5:**

```bash
git add packages/domain/src/money-stats.ts packages/domain/src/money-stats.test.ts packages/domain/src/index.ts
git commit -m "feat(domain): deriveMoneyStats - ledger-derived platform money KPIs"
```

---

### Task 2: `@wanthat/db` — listRewardRows

**Files:**
- Create: `packages/db/src/money-stats.ts`
- Modify: `packages/db/src/index.ts` (add `export { listRewardRows, type RewardRow } from "./money-stats";`)
- Test: extend `packages/db/src/wallet.test.ts` (reuses its seeded fixtures + harness)

**Interfaces:**
- Consumes: `Database` (schema.ts), Kysely handle.
- Produces (Task 4): `interface RewardRow { kind: "referrer_cashback" | "consumer_reward"; amountMinor: bigint; currency: string; orderId: string | null; status: "pending" | "confirmed" | "clawback"; createdAt: Date }`; `listRewardRows(db: Kysely<Database>): Promise<RewardRow[]>`.

- [ ] **Step 1: Write the failing test** — append to `packages/db/src/wallet.test.ts` (import `listRewardRows` from `./money-stats`; read the file's seed block first — it inserts referrer/consumer/adjustment rows for two subs):

```ts
describe("listRewardRows", () => {
  it("returns reward rows for ALL members, excluding adjustments/withdrawals", async () => {
    const rows = await listRewardRows(db);
    // Every seeded referrer_cashback/consumer_reward row, across both subs; no other kinds.
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.kind === "referrer_cashback" || r.kind === "consumer_reward")).toBe(
      true,
    );
    const subsCovered = new Set(rows.map(() => true));
    expect(subsCovered.size).toBe(1); // rows carry NO sub — platform-wide aggregation is anonymous
    const first = rows[0];
    expect(typeof first?.amountMinor).toBe("bigint");
    expect(first?.createdAt).toBeInstanceOf(Date);
  });
});
```

Adjust the count assertion to the file's actual fixtures after reading them (assert the exact expected number of reward rows seeded).

- [ ] **Step 2:** Run: `DOCKER_HOST=unix:///Users/dennis/.colima/default/docker.sock pnpm --filter @wanthat/db test -- wallet` — Expected: FAIL (module not found).

- [ ] **Step 3: Implement** — `packages/db/src/money-stats.ts`:

```ts
import type { Kysely } from "kysely";
import type { Database } from "./schema";

/**
 * Platform-wide reward rows for the admin money KPIs (spec 2026-07-13). Fetch-all is deliberate:
 * MVP volumes are bounded (same justification as wallet.ts `listEntriesForSub`) and the
 * derivation (`@wanthat/domain` `deriveMoneyStats`) needs the lifecycle rows, not aggregates —
 * SQL aggregation is the documented future optimization. No `cognito_sub` on the wire out of
 * this module: the platform aggregation is member-anonymous by construction.
 */
export interface RewardRow {
  kind: "referrer_cashback" | "consumer_reward";
  amountMinor: bigint;
  currency: string;
  orderId: string | null;
  status: "pending" | "confirmed" | "clawback";
  createdAt: Date;
}

export async function listRewardRows(db: Kysely<Database>): Promise<RewardRow[]> {
  const rows = await db
    .selectFrom("wallet_entry")
    .select(["kind", "amount_minor", "currency", "order_id", "status", "created_at"])
    .where("kind", "in", ["referrer_cashback", "consumer_reward"])
    .execute();
  return rows.map((r) => ({
    kind: r.kind as RewardRow["kind"],
    amountMinor: BigInt(r.amount_minor),
    currency: r.currency,
    orderId: r.order_id,
    status: r.status,
    createdAt: r.created_at,
  }));
}
```

- [ ] **Step 4:** Run: `DOCKER_HOST=unix:///Users/dennis/.colima/default/docker.sock pnpm --filter @wanthat/db test -- wallet` — Expected: PASS.

- [ ] **Step 5:**

```bash
git add packages/db/src/money-stats.ts packages/db/src/index.ts packages/db/src/wallet.test.ts
git commit -m "feat(db): listRewardRows - platform-wide reward rows for money KPIs"
```

---

### Task 3: `@wanthat/contracts` — MoneyStats

**Files:**
- Create: `packages/contracts/src/stats/money.ts`
- Modify: `packages/contracts/src/stats/index.ts` (add `export * from "./money";`)
- Test: `packages/contracts/src/stats/money.test.ts`

**Interfaces:**
- Consumes: `Money`, `Currency` (`../common`), `DailyCount` (`./daily`).
- Produces (Tasks 4+6): `MoneyStats` zod schema + type:

- [ ] **Step 1: Write the schema** — `packages/contracts/src/stats/money.ts`:

```ts
import { z } from "zod";
import { Currency, Money } from "../common";
import { DailyCount } from "./daily";

/** Confirmed + pending platform cashback held in one currency (all-time, lifecycle-collapsed). */
export const MoneyCurrencyTotals = z.object({
  currency: Currency,
  confirmed: Money,
  pending: Money,
});
export type MoneyCurrencyTotals = z.infer<typeof MoneyCurrencyTotals>;

/**
 * GET /admin/stats/money — dashboard money KPIs, derived per request from the `wallet_entry`
 * ledger (spec 2026-07-13, approach A: nothing stored). Semantics mirror the member wallet:
 * lifecycle collapse per (currency, orderId, kind), furthest status wins, clawback = 0.
 *
 * - `totals`: per-currency all-time confirmed/pending reward sums (adjustments/withdrawals are
 *   member movements, not platform cashback — excluded).
 * - `ilsEstimate`: display-only ₪ conversion of the USD totals (cached rate minus the
 *   fx.conversionCommissionBps — identical to the member wallet's `≈₪`). Hard zeros when no
 *   USD is held; null ONLY when USD is held but no rate is cached.
 * - `conversions30d` / `dailyConversions`: distinct attributed orders, bucketed to the
 *   Jerusalem date of the order's earliest reward row; dense 30-entry series.
 * - `cashbackPerActive30d`: ₪ confirmed-in-window ÷ active members (30d) — the PRD §3.2
 *   go/no-go metric. Null when the rate is missing (with USD held) or active30d is 0.
 */
export const MoneyStats = z.object({
  totals: z.array(MoneyCurrencyTotals),
  ilsEstimate: z.object({ confirmed: Money, pending: Money }).nullable(),
  conversions30d: z.number().int().nonnegative(),
  dailyConversions: z.array(DailyCount).length(30),
  cashbackPerActive30d: Money.nullable(),
});
export type MoneyStats = z.infer<typeof MoneyStats>;
```

(If `Currency` is not exported from `../common`, import it from the same module `Money` uses — check `packages/contracts/src/common/money.ts` line 1.)

- [ ] **Step 2: Write the test** — `packages/contracts/src/stats/money.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { MoneyStats } from "./money";

const dense = Array.from({ length: 30 }, (_, i) => ({
  date: `2026-06-${String(i + 1).padStart(2, "0")}`,
  count: 0,
}));

describe("MoneyStats contract", () => {
  it("accepts wire-shaped money (decimal strings) and yields bigints", () => {
    const parsed = MoneyStats.parse({
      totals: [
        {
          currency: "USD",
          confirmed: { amountMinor: "500", currency: "USD" },
          pending: { amountMinor: "200", currency: "USD" },
        },
      ],
      ilsEstimate: {
        confirmed: { amountMinor: "1690", currency: "ILS" },
        pending: { amountMinor: "676", currency: "ILS" },
      },
      conversions30d: 1,
      dailyConversions: dense,
      cashbackPerActive30d: { amountMinor: "56", currency: "ILS" },
    });
    expect(parsed.totals[0]?.confirmed.amountMinor).toBe(500n);
    expect(parsed.cashbackPerActive30d?.amountMinor).toBe(56n);
  });

  it("accepts the null fallbacks (no FX rate / no actives)", () => {
    const ok = MoneyStats.safeParse({
      totals: [],
      ilsEstimate: null,
      conversions30d: 0,
      dailyConversions: dense,
      cashbackPerActive30d: null,
    });
    expect(ok.success).toBe(true);
  });

  it("rejects a conversions series that is not exactly 30 entries", () => {
    const bad = MoneyStats.safeParse({
      totals: [],
      ilsEstimate: null,
      conversions30d: 0,
      dailyConversions: dense.slice(0, 29),
      cashbackPerActive30d: null,
    });
    expect(bad.success).toBe(false);
  });
});
```

- [ ] **Step 3:** Run: `pnpm --filter @wanthat/contracts build && pnpm --filter @wanthat/contracts test -- money` — Expected: PASS.

- [ ] **Step 4:**

```bash
git add packages/contracts/src/stats/
git commit -m "feat(contracts): MoneyStats - dashboard money KPI shapes"
```

---

### Task 4: admin-api — GET /admin/stats/money

**Files:**
- Create: `services/admin-api/src/http.ts` (extract `moneyJson` from user-detail.ts — two consumers now)
- Modify: `services/admin-api/src/user-detail.ts` (import `moneyJson` from `./http`, delete the local copy)
- Modify: `services/admin-api/src/context.ts` (add `fx: FxRateRepo`)
- Modify: `services/admin-api/src/handler.ts` (new route)
- Test: `services/admin-api/src/handler.test.ts`

**Interfaces:**
- Consumes: `deriveMoneyStats`/`MoneyStatsRow` (Task 1), `listRewardRows` (Task 2), `MoneyStats` (Task 3), `jerusalemDate`/`lastNDates` + `FxRateRepo` (`@wanthat/dynamo`), `convertMinor` (`@wanthat/domain`), `Bps` (`@wanthat/contracts`), existing `ctx.config.get` + `ctx.opsMetrics.countActiveSince`.
- Produces: the `MoneyStats` wire (bigint → decimal string via `moneyJson`), consumed by the SPA in Task 6. New env `FX_RATE_TABLE` (Task 5 provides it).

- [ ] **Step 1: Extract moneyJson** — `services/admin-api/src/http.ts`:

```ts
import type { Context } from "hono";
import type { Bindings } from "./guard";

/** Money's wire rule (bigint minor units → decimal string); `c.json` throws on bigint. */
export function moneyJson(c: Context<{ Bindings: Bindings }>, value: unknown): Response {
  return c.body(
    JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
    200,
    { "content-type": "application/json" },
  );
}
```

In `user-detail.ts`: delete the local `moneyJson` function and add `import { moneyJson } from "./http";` (drop the now-unused `Context` import if nothing else uses it).

- [ ] **Step 2: Write the failing tests** — in `services/admin-api/src/handler.test.ts`, add to the hoisted `ctx`: `fx: { get: vi.fn().mockResolvedValue(undefined) }` (+ type entry `fx: { get: ReturnType<typeof vi.fn> }`). `@wanthat/db` is already mocked via `dbFns` — add `listRewardRows: vi.fn().mockResolvedValue([])` to that hoisted object. Then:

```ts
describe("admin money stats", () => {
  const reward = (over: Record<string, unknown>) => ({
    kind: "referrer_cashback",
    amountMinor: 500n,
    currency: "USD",
    orderId: "order-1",
    status: "confirmed",
    createdAt: new Date("2026-07-12T10:00:00Z"),
    ...over,
  });

  it("serves ledger-derived totals with the ₪ estimate and per-active figure", async () => {
    dbFns.listRewardRows.mockResolvedValue([
      reward({}),
      reward({ kind: "consumer_reward", amountMinor: 200n, status: "pending" }),
    ]);
    ctx.fx.get.mockResolvedValue({ base: "USD", quote: "ILS", rate: "3.38" });
    ctx.config.getAll.mockResolvedValue([]); // commission comes via ctx.config.get below
    ctx.config.get = vi.fn().mockResolvedValue(0); // 0 bps commission → pure rate conversion
    ctx.opsMetrics.countActiveSince.mockResolvedValue(2);
    const res = await app.request("/admin/stats/money", {}, adminEnv);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.totals).toEqual([
      {
        currency: "USD",
        confirmed: { amountMinor: "500", currency: "USD" },
        pending: { amountMinor: "200", currency: "USD" },
      },
    ]);
    // 500 minor USD * 3.38 = 1690 minor ILS (0 bps commission).
    expect(body.ilsEstimate.confirmed).toEqual({ amountMinor: "1690", currency: "ILS" });
    expect(body.conversions30d).toBe(1);
    expect((body.dailyConversions as unknown[]).length).toBe(30);
    // 1690 / 2 active members = 845.
    expect(body.cashbackPerActive30d).toEqual({ amountMinor: "845", currency: "ILS" });
  });

  it("empty ledger: hard-zero ILS estimate even with no rate cached", async () => {
    dbFns.listRewardRows.mockResolvedValue([]);
    ctx.fx.get.mockResolvedValue(undefined);
    ctx.config.get = vi.fn().mockResolvedValue(0);
    ctx.opsMetrics.countActiveSince.mockResolvedValue(0);
    const res = await app.request("/admin/stats/money", {}, adminEnv);
    const body = (await res.json()) as Record<string, any>;
    expect(body.ilsEstimate.confirmed).toEqual({ amountMinor: "0", currency: "ILS" });
    expect(body.cashbackPerActive30d).toBeNull(); // 0 actives → null
  });

  it("USD held but no rate: ilsEstimate and per-active are null", async () => {
    dbFns.listRewardRows.mockResolvedValue([reward({})]);
    ctx.fx.get.mockResolvedValue(undefined);
    ctx.config.get = vi.fn().mockResolvedValue(0);
    ctx.opsMetrics.countActiveSince.mockResolvedValue(5);
    const res = await app.request("/admin/stats/money", {}, adminEnv);
    const body = (await res.json()) as Record<string, any>;
    expect(body.ilsEstimate).toBeNull();
    expect(body.cashbackPerActive30d).toBeNull();
  });

  it("403s a non-admin", async () => {
    expect((await app.request("/admin/stats/money", {}, memberEnv)).status).toBe(403);
  });
});
```

(Adapt `ctx.config.get` stubbing to the fake's actual shape — if `config` is typed without `get`, extend the hoisted object with `get: vi.fn()` alongside `getAll`/`put` instead of assigning in-test.)

- [ ] **Step 3:** Run: `pnpm --filter admin-api test` — Expected: FAIL (404 route).

- [ ] **Step 4: Implement.**

`services/admin-api/src/context.ts` — import `FxRateRepo` from `@wanthat/dynamo`; add to `AdminContext`:

```ts
  /** Cached FX rates (read-only): the money KPIs' display-only ₪ estimate (ADR-0017). */
  fx: FxRateRepo;
```

wire: `fx: new FxRateRepo(getDocClient(region), requireEnv("FX_RATE_TABLE")),`

`services/admin-api/src/handler.ts` — imports: add `MoneyStats`, `Bps` to the `@wanthat/contracts` import; `import { listRewardRows } from "@wanthat/db";` (extend the existing `@wanthat/db` import line); `import { jerusalemDate, lastNDates } from "@wanthat/dynamo";` (extend); `import { convertMinor, deriveMoneyStats } from "@wanthat/domain";`; `import { moneyJson } from "./http";`. Then after the catalog route:

```ts
// GET /admin/stats/money — the dashboard money KPIs, derived per request from the wallet_entry
// ledger (spec 2026-07-13, approach A: money is derived, never stored). Aurora read as app_ro;
// the SPA fetches this separately so a scale-to-zero resume delays only the money cards.
// Rewards settle in USD (ADR-0017); the ILS figures are display-only estimates off the cached
// rate minus the conversion commission - the member wallet's exact semantics.
app.get("/admin/stats/money", async (c) => {
  const ctx = getContext();
  const dates = lastNDates(30);
  const [rows, active30d, rate, commissionBps] = await Promise.all([
    listRewardRows(ctx.db),
    ctx.opsMetrics.countActiveSince(dates[0] as string),
    ctx.fx.get("USD", "ILS"),
    ctx.config.get("fx.conversionCommissionBps"),
  ]);
  const stats = deriveMoneyStats(
    rows.map((r) => ({
      kind: r.kind,
      amountMinor: r.amountMinor,
      currency: r.currency,
      orderId: r.orderId,
      status: r.status,
      date: jerusalemDate(r.createdAt),
    })),
    dates,
  );

  const bps = Bps.parse(commissionBps);
  const ils = (amountMinor: bigint) =>
    rate ? { amountMinor: convertMinor(amountMinor, rate.rate, bps), currency: "ILS" } : null;
  const ZERO_ILS = { amountMinor: 0n, currency: "ILS" };
  const usd = stats.totals.find((t) => t.currency === "USD");

  // Wallet-contract fallbacks: no USD held → hard zeros (nothing converts to nothing at any
  // rate); USD held but no cached rate → null (genuinely unknowable).
  const ilsEstimate = !usd
    ? { confirmed: ZERO_ILS, pending: ZERO_ILS }
    : rate
      ? { confirmed: ils(usd.confirmedMinor), pending: ils(usd.pendingMinor) }
      : null;
  const windowIls = !usd ? ZERO_ILS : ils(usd.confirmedInWindowMinor);
  const cashbackPerActive30d =
    windowIls === null || active30d === 0
      ? null
      : { amountMinor: windowIls.amountMinor / BigInt(active30d), currency: "ILS" };

  return moneyJson(
    c,
    MoneyStats.parse({
      totals: stats.totals.map((t) => ({
        currency: t.currency,
        confirmed: { amountMinor: t.confirmedMinor, currency: t.currency },
        pending: { amountMinor: t.pendingMinor, currency: t.currency },
      })),
      ilsEstimate,
      conversions30d: stats.conversionsInWindow,
      dailyConversions: stats.dailyConversions,
      cashbackPerActive30d,
    }),
  );
});
```

NOTE: `MoneyStats.parse` yields bigints (the Money schema transforms), and `moneyJson` re-serializes them to strings — same round trip the user wallet route does.

- [ ] **Step 5:** Run: `pnpm --filter admin-api test` — Expected: PASS.

- [ ] **Step 6:**

```bash
git add services/admin-api/src/
git commit -m "feat(admin-api): GET /admin/stats/money - ledger-derived dashboard KPIs"
```

---

### Task 5: Infra — FX table for admin-api

**Files:**
- Modify: `infra/lib/admin-stack.ts` (prop + env + grant)
- Modify: `infra/bin/wanthat.ts` (pass `fxRateTable`)

- [ ] **Step 1:** In `AdminStackProps` (next to `runtimeConfigTable`): `readonly fxRateTable: dynamodb.ITable;` with comment `/** Cached FX rates: the money KPIs' display-only ILS estimate (ADR-0017). */`. In the AdminApi `environment` block (after `OPS_COUNTERS_TABLE`): `FX_RATE_TABLE: props.fxRateTable.tableName,` with an ASCII-only comment `// Cached FX rate for the money KPIs' display-only ILS estimate (ADR-0017).`. With the other grants: `props.fxRateTable.grantReadData(fn);`. In `infra/bin/wanthat.ts`, AdminStack props: `fxRateTable: data.fxRateTable,`.

- [ ] **Step 2:** Run: `pnpm synth` — Expected: success.

- [ ] **Step 3:**

```bash
git add infra/lib/admin-stack.ts infra/bin/wanthat.ts
git commit -m "feat(infra): FX rate table env + read grant for admin-api money stats"
```

---

### Task 6: Web — live money cards + conversions panel

**Files:**
- Modify: `apps/web/src/lib/admin-api.ts` (wire types + `moneyStats` client)
- Modify: `apps/web/src/features/admin/AdminPage.tsx` (dashboard section)
- Modify: `apps/web/src/i18n.ts` (en + he)

- [ ] **Step 1: Client** — in `apps/web/src/lib/admin-api.ts` (wire = decimal-string money, like `AdminUserWalletWire`):

```ts
/** Money on the admin wire: minor units as a decimal string (the moneyJson rule). */
export interface MoneyWire {
  amountMinor: string;
  currency: string;
}

/** GET /admin/stats/money — see @wanthat/contracts MoneyStats for semantics. */
export interface MoneyStatsWire {
  totals: { currency: string; confirmed: MoneyWire; pending: MoneyWire }[];
  ilsEstimate: { confirmed: MoneyWire; pending: MoneyWire } | null;
  conversions30d: number;
  dailyConversions: { date: string; count: number }[];
  cashbackPerActive30d: MoneyWire | null;
}
```

and in the `adminApi` object: `moneyStats: (token: string) => adminRequest<MoneyStatsWire>("/admin/stats/money", token),`

- [ ] **Step 2: i18n** — en admin `stats` block: `cashback: "Cashback earned"`, `pending: "Pending cashback"`, `conversions: "Conversions (30d)"`, add `perActive30d: "Per active member (30d)"`; add sibling block `conversionsPanel: { title: "Conversions", trend: "Attributed orders (last 30 days)" }`. he: `cashback: "קאשבק שנצבר"`, `pending: "קאשבק ממתין"`, `conversions: "המרות (30 יום)"`, `perActive30d: "לחבר פעיל (30 יום)"`, `conversionsPanel: { title: "המרות", trend: "הזמנות משויכות (30 הימים האחרונים)" }`.

- [ ] **Step 3: Dashboard** — in `AdminPage.tsx`:

1. Extend imports: `import { adminApi, type CatalogStats, type MoneyStatsWire, type StatsOverview, type UsersStats } from "../../lib/admin-api";` and `import { formatMoneyMinor } from "../../lib/money";`.
2. In `DashboardView`, add state + fetch (alongside the others): 

```tsx
  // undefined = loading, null = fetch failed. Fetched independently: this one wakes
  // scale-to-zero Aurora (~20s cold), so only the money cards wait on it.
  const [money, setMoney] = useState<MoneyStatsWire | null | undefined>(undefined);
```

and inside the existing `useEffect`:

```tsx
    adminApi
      .moneyStats(token)
      .then(setMoney)
      .catch(() => setMoney(null));
```

3. Replace the three placeholder money cards with four live ones (same icons; the fourth reuses the users icon path from the headline row):

```tsx
      {/* Money KPIs (spec 2026-07-13): ledger-derived, own fetch + skeleton (Aurora cold start). */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <KpiCard
          label={t("admin.stats.cashback")}
          value={moneyValue(money, (m) => ilsOrTotals(m, "confirmed"))}
          live
          icon={<path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />}
        />
        <KpiCard
          label={t("admin.stats.pending")}
          value={moneyValue(money, (m) => ilsOrTotals(m, "pending"))}
          tone="pending"
          live
          icon={
            <>
              <circle cx="12" cy="12" r="9" />
              <path d="M12 7v5l3 2" />
            </>
          }
        />
        <KpiCard
          label={t("admin.stats.conversions")}
          value={moneyValue(money, (m) => m.conversions30d.toLocaleString("en-US"))}
          live
          icon={
            <>
              <path d="M3 17l6-6 4 4 7-7" />
              <path d="M14 8h6v6" />
            </>
          }
        />
        <KpiCard
          label={t("admin.stats.perActive30d")}
          value={moneyValue(money, (m) =>
            m.cashbackPerActive30d
              ? formatMoneyMinor(m.cashbackPerActive30d.amountMinor, "ILS")
              : "—",
          )}
          live
          icon={
            <>
              <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
            </>
          }
        />
      </div>
```

4. Add the helpers next to `DashboardView` (module scope):

```tsx
/** Skeleton while loading, em-dash on failure, formatted value once loaded. */
function moneyValue(
  money: MoneyStatsWire | null | undefined,
  format: (m: MoneyStatsWire) => ReactNode,
): ReactNode {
  if (money === undefined) return <Skeleton className="h-[30px] w-16" />;
  if (money === null) return "—";
  return format(money);
}

/** The ₪ estimate when a rate is cached; falls back to the first raw currency total. */
function ilsOrTotals(m: MoneyStatsWire, bucket: "confirmed" | "pending"): string {
  if (m.ilsEstimate) return formatMoneyMinor(m.ilsEstimate[bucket].amountMinor, "ILS");
  const first = m.totals[0];
  return first ? formatMoneyMinor(first[bucket].amountMinor, first.currency) : "—";
}
```

5. Add a Conversions panel after `RecsPanel` (`<ConversionsPanel money={money} />` in the JSX):

```tsx
/** The conversions panel: 30-day attributed-order trend from the money stats. */
function ConversionsPanel({ money }: { money: MoneyStatsWire | null | undefined }) {
  const { t } = useTranslation();
  return (
    <div className="rounded-card border border-line bg-surface p-5">
      <h2 className="mb-4 font-display text-lg font-semibold text-ink">
        {t("admin.conversionsPanel.title")}
      </h2>
      {money === null ? (
        <div className="py-10 text-center text-sm text-muted">{t("admin.users.error")}</div>
      ) : (
        <div>
          <div className="mb-2 text-[12.5px] font-semibold text-muted">
            {t("admin.conversionsPanel.trend")}
          </div>
          <DailyTrend data={money?.dailyConversions ?? null} />
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4:** Run: `pnpm typecheck && pnpm --filter web test` — Expected: PASS (i18n parity holds — both languages got the same keys).

- [ ] **Step 5:**

```bash
git add apps/web/src/lib/admin-api.ts apps/web/src/features/admin/AdminPage.tsx apps/web/src/i18n.ts
git commit -m "feat(web): live money KPI cards + conversions trend on the dashboard"
```

---

### Task 7: Verification + PR (STOP at the open PR)

- [ ] **Step 1:**

```bash
export DOCKER_HOST=unix:///Users/dennis/.colima/default/docker.sock
pnpm lint && pnpm typecheck && pnpm test && pnpm synth
```

Expected: all green. Fix at the source (run `pnpm exec biome format --write <file>` on any format drift, commit as `style:`).

- [ ] **Step 2:** Push + open the PR (ready, not draft), titled `feat(admin): money KPIs - ledger-derived dashboard cards + conversions trend`; body: summary of the endpoint/derivation, the wallet-mirroring semantics, the FX fallbacks, infra grant, and a note that the running-total alternative was rejected (spec §Decisions). Wait for CI + Check Deploy (blocking if red).

- [ ] **Step 3:** STOP. Report the PR to Dennis — merge and deploys are his call (per the merge-review gate).
