# Admin Dashboard Real KPIs + Trends Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The admin dashboard shows real registered/active-user and recommendation KPIs plus 30-day trend charts (signups, active members, recommendations created), sourced from daily counter items in the existing OpsCounters DynamoDB table.

**Architecture:** Extend the OpsCounters sentinel-counter pattern with daily items (`signupsDaily#<date>`, `recsDaily#<date>`, `activeDaily#<date>`) and per-member `presence#<sub>` stamps. Writers: the Post-Confirmation trigger (signups), `app-links` (recommendations + presence), `app-core` (presence). admin-api aggregates them into the two existing stats endpoints; the SPA dashboard renders the new shapes.

**Tech Stack:** TypeScript/Node 24, pnpm + Turborepo, Zod contracts, Hono, DynamoDB (`@aws-sdk/lib-dynamodb`), Vitest, AWS CDK v2, React SPA.

**Spec:** `docs/superpowers/specs/2026-07-12-admin-dashboard-kpis-design.md`

**ADR assessment (done during planning): NO new ADR.** This slice is an application of existing decisions, not a new one: daily counters extend the OpsCounters pattern already established for `customerCounter` (which itself has no ADR — ADRs record conceptual decisions only); operational non-PII in DynamoDB keyed by the canonical `sub` is exactly ADR-0003 + ADR-0020; no compute/network/auth topology changes (ADR-0002/0004/0006 untouched). The "active = used the app" metric definition is recorded in the spec and the contract docs.

## Global Constraints

- Region `il-central-1`; infra description fields ASCII-only (no em-dashes, no parentheses in WAF descriptions).
- NEVER set `reservedConcurrentExecutions` on any Lambda (account limit is 10).
- Counter/presence writes are best-effort everywhere: a metrics failure must NEVER fail a member request, a recommendation create, or a Cognito confirmation.
- All date bucketing in `Asia/Jerusalem`, format `YYYY-MM-DD`.
- Verification before PR: `pnpm lint && pnpm typecheck && pnpm test && pnpm synth` (CI runs biome — lint is mandatory).
- Full-repo `pnpm typecheck` is only guaranteed green again after Task 8 (the contracts reshape in Task 5 intentionally breaks the web dashboard until Task 8 updates it). Per-task verification commands below are scoped accordingly.
- Delivery: PR (ready, not draft) → CI + Check Deploy green → merge to `main` (auto-deploys **dev**) → verify dev → publish a GitHub Release (non-prerelease) to deploy **prod** (behind the `prod` environment approval gate).

---

### Task 0: Branch

**Files:** none

- [ ] **Step 1: Create the feature branch**

```bash
cd /Users/dennis/projects/wanthat-app/monorepo
git checkout -b feat/admin-dashboard-kpis
```

---

### Task 1: `@wanthat/dynamo` — OpsMetricsRepo + Jerusalem date helpers

**Files:**
- Create: `packages/dynamo/src/ops-metrics.ts`
- Create: `packages/dynamo/src/ops-metrics.test.ts`
- Modify: `packages/dynamo/src/index.ts` (add export)

**Interfaces:**
- Consumes: nothing new (`DynamoDBDocumentClient` from `@aws-sdk/lib-dynamodb`, same as `customer-counter.ts`).
- Produces (used by Tasks 2–4, 6):
  - `jerusalemDate(now?: Date): string` — `YYYY-MM-DD` in Asia/Jerusalem.
  - `lastNDates(n: number, now?: Date): string[]` — dense ascending list ending today (Jerusalem).
  - `type DailyMetric = "signupsDaily" | "recsDaily" | "activeDaily"`.
  - `class OpsMetricsRepo { constructor(doc, tableName); incrementDaily(metric, date): Promise<void>; markActive(sub, date): Promise<boolean>; touch(sub, date): void; getDailyCounts(metric, dates): Promise<Map<string, number>>; countActiveSince(cutoffDate): Promise<number> }`
  - `PRESENCE_PREFIX = "presence#"`.

- [ ] **Step 1: Write the failing tests**

Create `packages/dynamo/src/ops-metrics.test.ts` (same `stub()` fake-doc-client pattern as `customer-counter.test.ts`):

```ts
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jerusalemDate, lastNDates, OpsMetricsRepo } from "./ops-metrics";

function stub(respond: (name: string, input: Record<string, unknown>) => unknown) {
  const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
  const doc = {
    send: async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
      calls.push({ name: cmd.constructor.name, input: cmd.input });
      return respond(cmd.constructor.name, cmd.input);
    },
  } as unknown as DynamoDBDocumentClient;
  return { doc, calls };
}

const denied = () => new ConditionalCheckFailedException({ message: "denied", $metadata: {} });

let error: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  error = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  error.mockRestore();
});

describe("jerusalemDate", () => {
  it("formats an instant as the Asia/Jerusalem calendar date", () => {
    // 22:30 UTC = 01:30 next day in Jerusalem (summer, UTC+3).
    expect(jerusalemDate(new Date("2026-07-11T22:30:00Z"))).toBe("2026-07-12");
    expect(jerusalemDate(new Date("2026-07-11T12:00:00Z"))).toBe("2026-07-11");
  });
});

describe("lastNDates", () => {
  it("returns a dense ascending list ending today (Jerusalem)", () => {
    const dates = lastNDates(3, new Date("2026-07-11T22:30:00Z")); // local 2026-07-12
    expect(dates).toEqual(["2026-07-10", "2026-07-11", "2026-07-12"]);
  });

  it("spans month boundaries", () => {
    expect(lastNDates(2, new Date("2026-07-01T12:00:00Z"))).toEqual(["2026-06-30", "2026-07-01"]);
  });
});

describe("OpsMetricsRepo.incrementDaily", () => {
  it("ADDs 1 to the daily counter item", async () => {
    const { doc, calls } = stub(() => ({}));
    await new OpsMetricsRepo(doc, "ops-counters").incrementDaily("recsDaily", "2026-07-12");
    expect(calls[0]?.name).toBe("UpdateCommand");
    expect(calls[0]?.input.Key).toEqual({ counterKey: "recsDaily#2026-07-12" });
    expect(calls[0]?.input.UpdateExpression).toBe("ADD #count :one");
  });
});

describe("OpsMetricsRepo.markActive", () => {
  it("stamps the presence item and bumps activeDaily on first touch", async () => {
    const { doc, calls } = stub(() => ({}));
    const repo = new OpsMetricsRepo(doc, "ops-counters");
    expect(await repo.markActive("sub-1", "2026-07-12")).toBe(true);
    expect(calls[0]?.input.Key).toEqual({ counterKey: "presence#sub-1" });
    expect(calls[1]?.input.Key).toEqual({ counterKey: "activeDaily#2026-07-12" });
  });

  it("memoizes: the second same-day touch makes NO DynamoDB call", async () => {
    const { doc, calls } = stub(() => ({}));
    const repo = new OpsMetricsRepo(doc, "ops-counters");
    await repo.markActive("sub-1", "2026-07-12");
    expect(await repo.markActive("sub-1", "2026-07-12")).toBe(false);
    expect(calls.length).toBe(2); // presence + activeDaily from the FIRST call only
  });

  it("a new day stamps again", async () => {
    const { doc, calls } = stub(() => ({}));
    const repo = new OpsMetricsRepo(doc, "ops-counters");
    await repo.markActive("sub-1", "2026-07-12");
    expect(await repo.markActive("sub-1", "2026-07-13")).toBe(true);
    expect(calls.length).toBe(4);
  });

  it("condition failure (already stamped by another container) skips the counter", async () => {
    const { doc, calls } = stub((name) => {
      if (name === "UpdateCommand") throw denied();
      return {};
    });
    const repo = new OpsMetricsRepo(doc, "ops-counters");
    expect(await repo.markActive("sub-1", "2026-07-12")).toBe(false);
    expect(calls.length).toBe(1); // presence attempt only, no activeDaily bump
    // …and the memo remembers, so a retry is free:
    expect(await repo.markActive("sub-1", "2026-07-12")).toBe(false);
    expect(calls.length).toBe(1);
  });
});

describe("OpsMetricsRepo.touch", () => {
  it("swallows and logs failures (fire-and-forget)", async () => {
    const { doc } = stub(() => {
      throw new Error("dynamo down");
    });
    new OpsMetricsRepo(doc, "ops-counters").touch("sub-1", "2026-07-12");
    await new Promise((r) => setTimeout(r, 0)); // let the floating promise settle
    expect(error).toHaveBeenCalled();
  });
});

describe("OpsMetricsRepo.getDailyCounts", () => {
  it("zero-fills missing days and maps found items by date", async () => {
    const { doc } = stub(() => ({
      Responses: {
        "ops-counters": [{ counterKey: "signupsDaily#2026-07-11", count: 4 }],
      },
    }));
    const counts = await new OpsMetricsRepo(doc, "ops-counters").getDailyCounts("signupsDaily", [
      "2026-07-10",
      "2026-07-11",
    ]);
    expect(counts.get("2026-07-10")).toBe(0);
    expect(counts.get("2026-07-11")).toBe(4);
  });

  it("follows UnprocessedKeys", async () => {
    let call = 0;
    const { doc } = stub(() => {
      call += 1;
      if (call === 1)
        return {
          Responses: { "ops-counters": [{ counterKey: "signupsDaily#2026-07-10", count: 1 }] },
          UnprocessedKeys: {
            "ops-counters": { Keys: [{ counterKey: "signupsDaily#2026-07-11" }] },
          },
        };
      return {
        Responses: { "ops-counters": [{ counterKey: "signupsDaily#2026-07-11", count: 2 }] },
      };
    });
    const counts = await new OpsMetricsRepo(doc, "ops-counters").getDailyCounts("signupsDaily", [
      "2026-07-10",
      "2026-07-11",
    ]);
    expect(counts.get("2026-07-11")).toBe(2);
  });
});

describe("OpsMetricsRepo.countActiveSince", () => {
  it("COUNT-scans presence items past the cutoff, following pagination", async () => {
    let call = 0;
    const { doc, calls } = stub(() => {
      call += 1;
      if (call === 1) return { Count: 2, LastEvaluatedKey: { counterKey: "presence#x" } };
      return { Count: 1 };
    });
    const n = await new OpsMetricsRepo(doc, "ops-counters").countActiveSince("2026-06-13");
    expect(n).toBe(3);
    expect(calls[0]?.input.Select).toBe("COUNT");
    expect(calls[0]?.input.FilterExpression).toContain("begins_with");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @wanthat/dynamo test -- ops-metrics`
Expected: FAIL — `./ops-metrics` module not found.

- [ ] **Step 3: Implement `packages/dynamo/src/ops-metrics.ts`**

```ts
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { BatchGetCommand, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

/**
 * Dashboard metrics in the OpsCounters table (same sentinel-counter pattern as
 * `customerCounter` — PK attribute `counterKey`, atomic ADD, a missing item reads as zero):
 *
 *   `signupsDaily#<YYYY-MM-DD>`  { count }        confirmed signups that local day
 *   `recsDaily#<YYYY-MM-DD>`     { count }        recommendations created that local day
 *   `activeDaily#<YYYY-MM-DD>`   { count }        DISTINCT members seen that local day
 *   `presence#<sub>`             { lastSeenDate } the member's last active local day
 *
 * "Active" means USED THE APP (any authenticated member-API call), not "signed in" — the SPA
 * keeps sessions alive via refresh tokens, so fresh Cognito sign-ins would undercount badly.
 * The presence item is the first-touch-of-day detector AND the source for distinct
 * active-in-window counts (which canNOT be summed from daily counters — repeat visitors would
 * double-count). All days are Asia/Jerusalem calendar dates, matching how the dashboard reads.
 */
export type DailyMetric = "signupsDaily" | "recsDaily" | "activeDaily";

export const PRESENCE_PREFIX = "presence#";

/** The Asia/Jerusalem calendar date of an instant, as YYYY-MM-DD (en-CA gives ISO order). */
export function jerusalemDate(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem" }).format(now);
}

/**
 * Dense ascending list of the last `n` Jerusalem calendar dates, ending today. Arithmetic runs
 * on a noon-UTC anchor of today's LOCAL date so DST transitions can't skip or repeat a day.
 */
export function lastNDates(n: number, now: Date = new Date()): string[] {
  const anchor = new Date(`${jerusalemDate(now)}T12:00:00Z`);
  const dates: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    dates.push(new Date(anchor.getTime() - i * 86_400_000).toISOString().slice(0, 10));
  }
  return dates;
}

const dailyKey = (metric: DailyMetric, date: string) => `${metric}#${date}`;

export class OpsMetricsRepo {
  /** sub → the date this container already stamped (skips repeat DynamoDB calls same-day). */
  private readonly stamped = new Map<string, string>();

  constructor(
    private readonly doc: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  /** ADD 1 to a daily metric counter (atomic; the item materialises on first ADD). */
  // `count` aliased defensively — cheap, and uniform with the other expressions here.
  async incrementDaily(metric: DailyMetric, date: string): Promise<void> {
    await this.doc.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { counterKey: dailyKey(metric, date) },
        UpdateExpression: "ADD #count :one",
        ExpressionAttributeNames: { "#count": "count" },
        ExpressionAttributeValues: { ":one": 1 },
      }),
    );
  }

  /**
   * First-touch-of-day: advance the member's presence stamp to `date`; when this call won the
   * advance (condition passed), also bump that day's distinct-actives counter. Returns whether
   * THIS call was the first touch. The `<` condition (ISO dates compare lexicographically)
   * also refuses to move a stamp backwards if a laggard container carries yesterday's date.
   */
  async markActive(sub: string, date: string): Promise<boolean> {
    if (this.stamped.get(sub) === date) return false;
    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { counterKey: `${PRESENCE_PREFIX}${sub}` },
          UpdateExpression: "SET lastSeenDate = :date",
          ConditionExpression: "attribute_not_exists(lastSeenDate) OR lastSeenDate < :date",
          ExpressionAttributeValues: { ":date": date },
        }),
      );
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        // Another container (or an earlier cold start) already counted this member today.
        this.stamped.set(sub, date);
        return false;
      }
      throw err;
    }
    this.stamped.set(sub, date);
    await this.incrementDaily("activeDaily", date);
    return true;
  }

  /** Fire-and-forget presence stamp for request paths: never delays or fails the member call. */
  touch(sub: string, date: string): void {
    void this.markActive(sub, date).catch((err) => {
      console.error(
        JSON.stringify({
          error: "presence_stamp_failed",
          sub,
          detail: err instanceof Error ? err.message : String(err),
        }),
      );
    });
  }

  /** Dense daily counts for the given dates — missing items (quiet days) read as zero. */
  async getDailyCounts(metric: DailyMetric, dates: string[]): Promise<Map<string, number>> {
    const counts = new Map(dates.map((d) => [d, 0]));
    // 30 dates fit one BatchGet page (cap 100), but honor UnprocessedKeys regardless.
    let keys: Record<string, unknown>[] = dates.map((date) => ({
      counterKey: dailyKey(metric, date),
    }));
    while (keys.length > 0) {
      const res = await this.doc.send(
        new BatchGetCommand({ RequestItems: { [this.tableName]: { Keys: keys } } }),
      );
      for (const item of res.Responses?.[this.tableName] ?? []) {
        counts.set(String(item.counterKey).slice(metric.length + 1), Number(item.count ?? 0));
      }
      keys = res.UnprocessedKeys?.[this.tableName]?.Keys ?? [];
    }
    return counts;
  }

  /**
   * DISTINCT members seen on/after `cutoffDate` (inclusive): a COUNT scan over the presence
   * items — one tiny item per member ever seen, fine at MVP scale (the spec's accepted
   * exception to O(1) counter reads; swap the implementation if scale ever demands).
   */
  async countActiveSince(cutoffDate: string): Promise<number> {
    let count = 0;
    let startKey: Record<string, unknown> | undefined;
    do {
      const res = await this.doc.send(
        new ScanCommand({
          TableName: this.tableName,
          Select: "COUNT",
          FilterExpression: "begins_with(counterKey, :prefix) AND lastSeenDate >= :cutoff",
          ExpressionAttributeValues: { ":prefix": PRESENCE_PREFIX, ":cutoff": cutoffDate },
          ...(startKey ? { ExclusiveStartKey: startKey } : {}),
        }),
      );
      count += res.Count ?? 0;
      startKey = res.LastEvaluatedKey;
    } while (startKey);
    return count;
  }
}
```

Add to `packages/dynamo/src/index.ts` (alongside the existing exports):

```ts
export * from "./ops-metrics";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @wanthat/dynamo test -- ops-metrics`
Expected: PASS (all describes).

- [ ] **Step 5: Commit**

```bash
git add packages/dynamo/src/ops-metrics.ts packages/dynamo/src/ops-metrics.test.ts packages/dynamo/src/index.ts
git commit -m "feat(dynamo): OpsMetricsRepo - daily dashboard counters + presence stamps"
```

---

### Task 2: Post-Confirmation trigger — daily signup counter

**Files:**
- Modify: `services/post-confirmation/src/confirm.ts`
- Modify: `services/post-confirmation/src/handler.ts`
- Test: `services/post-confirmation/src/confirm.test.ts`

**Interfaces:**
- Consumes: `OpsMetricsRepo.incrementDaily("signupsDaily", date)`, `jerusalemDate()` from `@wanthat/dynamo` (Task 1).
- Produces: `ConfirmDeps` gains `metrics: { incrementDaily(metric: "signupsDaily", date: string): Promise<void> }`.

- [ ] **Step 1: Write the failing tests**

In `services/post-confirmation/src/confirm.test.ts`, the existing tests build a `deps` object — add `metrics: { incrementDaily: vi.fn().mockResolvedValue(undefined) }` to the shared deps factory (wherever `counter: { incrementTotal: ... }` is built), then add:

```ts
it("bumps the daily signup counter with today's Jerusalem date", async () => {
  const deps = makeDeps(); // the file's existing deps factory, now with metrics
  await handleConfirmation(deps, confirmEvent()); // the file's existing valid-event factory
  expect(deps.metrics.incrementDaily).toHaveBeenCalledWith(
    "signupsDaily",
    expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
  );
});

it("a daily-counter failure is logged and swallowed (never blocks confirmation)", async () => {
  const deps = makeDeps();
  deps.metrics.incrementDaily.mockRejectedValue(new Error("dynamo down"));
  await expect(handleConfirmation(deps, confirmEvent())).resolves.toBeUndefined();
  expect(deps.log.error).toHaveBeenCalledWith(
    "signup_daily_count_failed",
    expect.objectContaining({ error: "dynamo down" }),
  );
});

it("does not bump the daily counter for non-signup trigger sources", async () => {
  const deps = makeDeps();
  await handleConfirmation(deps, {
    ...confirmEvent(),
    triggerSource: "PostConfirmation_ConfirmForgotPassword",
  });
  expect(deps.metrics.incrementDaily).not.toHaveBeenCalled();
});
```

(Adapt factory/helper names to what the file actually uses — read it first; the assertions stay as written.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter post-confirmation test`
Expected: FAIL — `metrics` missing from `ConfirmDeps` (type error) / not called.

- [ ] **Step 3: Implement**

In `services/post-confirmation/src/confirm.ts`:

1. Add to `ConfirmDeps` (after `counter`):

```ts
  /** Daily signup counter (`signupsDaily#<date>`, OpsCounters) — the dashboard's signup trend. */
  metrics: { incrementDaily(metric: "signupsDaily", date: string): Promise<void> };
```

2. Add `import { jerusalemDate } from "@wanthat/dynamo";` and append a fourth best-effort step at the end of `handleConfirmation` (after the `customer_counter_drift` try/catch), same contract as the others:

```ts
  // Daily signup counter (dashboard trend): same best-effort contract — a miss only dents a
  // chart, never a confirmation.
  try {
    await deps.metrics.incrementDaily("signupsDaily", jerusalemDate());
  } catch (err) {
    deps.log.error("signup_daily_count_failed", {
      sub,
      error: err instanceof Error ? err.message : String(err),
    });
  }
```

3. In `services/post-confirmation/src/handler.ts`, import `OpsMetricsRepo` from `@wanthat/dynamo` and wire (after `counter:`):

```ts
    metrics: new OpsMetricsRepo(doc, requireEnv("OPS_COUNTERS_TABLE")),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter post-confirmation test`
Expected: PASS (existing + 3 new).

- [ ] **Step 5: Commit**

```bash
git add services/post-confirmation/src/
git commit -m "feat(post-confirmation): count daily signups for the dashboard trend"
```

---

### Task 3: app-links — presence middleware + daily recommendations counter

**Files:**
- Modify: `services/app-links/src/context.ts` (add `opsMetrics`)
- Modify: `services/app-links/src/handler.ts` (presence middleware)
- Modify: `services/app-links/src/links/router.ts` (recsDaily on create)
- Test: `services/app-links/src/links/router.test.ts`, `services/app-links/src/handler.test.ts` (create if absent)

**Interfaces:**
- Consumes: `OpsMetricsRepo`, `jerusalemDate` (Task 1); `subFromClaims` (existing `claims.ts`).
- Produces: `LinksContext.opsMetrics: OpsMetricsRepo`; env var `OPS_COUNTERS_TABLE` required (infra sets it in Task 7).

- [ ] **Step 1: Write the failing tests**

In `services/app-links/src/links/router.test.ts`, extend the hoisted `fake` context with `opsMetrics: { incrementDaily: vi.fn().mockResolvedValue(undefined), touch: vi.fn() }`, then add to the recommendations-create describe:

```ts
it("bumps the daily recommendations counter on a NEW create (fire-and-forget)", async () => {
  fake.recommendations.create.mockImplementation(async (item: unknown) => ({
    item,
    created: true,
  }));
  const res = await recsRequest(); // the file's existing helper for POST /recommendations
  expect(res.status).toBe(201);
  expect(fake.opsMetrics.incrementDaily).toHaveBeenCalledWith(
    "recsDaily",
    expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
  );
});

it("does NOT bump the counter on an idempotent replay (created=false)", async () => {
  // reuse the file's existing replay setup that returns { created: false }
  expect(fake.opsMetrics.incrementDaily).not.toHaveBeenCalled();
});

it("a counter failure does not fail the create", async () => {
  fake.opsMetrics.incrementDaily.mockRejectedValue(new Error("dynamo down"));
  fake.recommendations.create.mockImplementation(async (item: unknown) => ({
    item,
    created: true,
  }));
  const res = await recsRequest();
  expect(res.status).toBe(201);
});
```

Create/extend `services/app-links/src/handler.test.ts` with the presence-middleware behavior (mock `./context` like router.test.ts does; build requests with the JWT-claims env shape used in `claims.ts`):

```ts
it("stamps presence for an authenticated call", async () => {
  await app.request("/recommendations", {}, claimsEnv("sub-1")); // env with jwt claims sub
  expect(fake.opsMetrics.touch).toHaveBeenCalledWith(
    "sub-1",
    expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
  );
});

it("does not stamp public routes (no claims)", async () => {
  await app.request("/healthz", {});
  expect(fake.opsMetrics.touch).not.toHaveBeenCalled();
});
```

(Adapt helper names to the file's existing conventions; keep the assertions.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter app-links test`
Expected: FAIL — `opsMetrics` missing on context/type.

- [ ] **Step 3: Implement**

1. `services/app-links/src/context.ts`: add to `LinksContext`:

```ts
  /** Dashboard metrics (OpsCounters): presence stamps + the daily recommendations counter. */
  opsMetrics: OpsMetricsRepo;
```

wire in `getContext()`:

```ts
    opsMetrics: new OpsMetricsRepo(doc, requireEnv("OPS_COUNTERS_TABLE")),
```

(import `OpsMetricsRepo` from `@wanthat/dynamo`).

2. `services/app-links/src/handler.ts`: after the `/healthz` + `/config` registrations, before the routers:

```ts
import { jerusalemDate } from "@wanthat/dynamo";
import { subFromClaims } from "./claims";
import { getContext } from "./context";

// Presence stamp (dashboard active-member metric, spec 2026-07-12): any authenticated call
// marks the member active today. Fire-and-forget - never delays or fails the request; routes
// without JWT claims (healthz, public config) skip through.
app.use("*", async (c, next) => {
  const sub = subFromClaims(c);
  if (sub) getContext().opsMetrics.touch(sub, jerusalemDate());
  await next();
});
```

NOTE: `handler.ts` currently types Bindings inline as `{ event: LambdaEvent }` — `subFromClaims` expects `Context<{ Bindings: Bindings }>` from `./claims`, which is the same shape; import the `Bindings` type from `./claims` for the `Hono` generic if TS complains.

3. `services/app-links/src/links/router.ts`, in the POST `/recommendations` route, right after the id-collision guard (before the response):

```ts
    // Daily-created counter (dashboard trend): stats-grade, fire-and-forget - a counter miss
    // never fails the member's create. Replays (created=false) don't recount.
    if (created) {
      void ctx.opsMetrics.incrementDaily("recsDaily", jerusalemDate()).catch((err) => {
        console.error("recs_daily_count_failed", err);
      });
    }
```

(import `jerusalemDate` from `@wanthat/dynamo` at the top).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter app-links test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/app-links/src/
git commit -m "feat(app-links): presence stamps + daily recommendations counter"
```

---

### Task 4: app-core — presence middleware

**Files:**
- Modify: `services/app-core/src/context.ts` (add `opsMetrics`)
- Modify: `services/app-core/src/handler.ts` (presence middleware)
- Test: `services/app-core/src/handler.test.ts`

**Interfaces:**
- Consumes: `OpsMetricsRepo`, `jerusalemDate` (Task 1); `subFromClaims` (existing `app-core/src/claims.ts`).
- Produces: `AppCoreContext.opsMetrics: OpsMetricsRepo`; env var `OPS_COUNTERS_TABLE` required (infra sets it in Task 7).

- [ ] **Step 1: Write the failing tests**

In `services/app-core/src/handler.test.ts` (mock `./context` following the file's existing pattern; add `opsMetrics: { touch: vi.fn() }` to the fake):

```ts
it("stamps presence for an authenticated call", async () => {
  await app.request("/wallet", {}, claimsEnv("sub-1"));
  expect(fake.opsMetrics.touch).toHaveBeenCalledWith(
    "sub-1",
    expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
  );
});

it("does not stamp /healthz (no claims)", async () => {
  await app.request("/healthz", {});
  expect(fake.opsMetrics.touch).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter app-core test`
Expected: FAIL.

- [ ] **Step 3: Implement**

1. `services/app-core/src/context.ts`: add `opsMetrics: OpsMetricsRepo` to the context interface and wire `opsMetrics: new OpsMetricsRepo(getDocClient(region), requireEnv("OPS_COUNTERS_TABLE"))` (reuse the existing doc-client/region variables; match the file's structure).

2. `services/app-core/src/handler.ts`: same middleware as app-links, registered after the healthz routes and before `app.route("/wallet", ...)`:

```ts
import { jerusalemDate } from "@wanthat/dynamo";
import { subFromClaims } from "./claims";

// Presence stamp (dashboard active-member metric, spec 2026-07-12): any authenticated call
// marks the member active today. Fire-and-forget - never delays or fails the request; the
// public healthz probes carry no claims and skip through.
app.use("*", async (c, next) => {
  const sub = subFromClaims(c);
  if (sub) getContext().opsMetrics.touch(sub, jerusalemDate());
  await next();
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter app-core test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/app-core/src/
git commit -m "feat(app-core): presence stamps for the active-member metric"
```

---

### Task 5: Contracts — DailyCount + reshaped UsersStats / CatalogStats

**Files:**
- Create: `packages/contracts/src/stats/daily.ts`
- Modify: `packages/contracts/src/stats/users.ts` (full rewrite below)
- Modify: `packages/contracts/src/stats/catalog.ts` (full rewrite below)
- Modify: `packages/contracts/src/stats/index.ts` (add `export * from "./daily";`)

**Interfaces:**
- Produces (used by Tasks 6 + 8): `DailyCount = { date: string, count: number }`; `UsersStats` (all fields REQUIRED): `usersCount, suspendedUsersCount, newToday, new7d, new30d, active7d, active30d, dailySignups: DailyCount[30], dailyActive: DailyCount[30]`; `CatalogStats`: `products, recommendations, dailyCreated: DailyCount[30]`.
- BREAKING (intentional, resolved inside this PR): deletes `UsersDailySignup` and the legacy optional fields `total/active/suspended`; the web dashboard compiles again after Task 8. `UsersStats.parse(...)` calls in admin-api throw until Task 6 lands — Tasks 5→6→8 must land in this order.

- [ ] **Step 1: Write `packages/contracts/src/stats/daily.ts`**

```ts
import { z } from "zod";

/** One day of a dashboard trend: an ISO calendar date (YYYY-MM-DD, Asia/Jerusalem) + a count.
 * Series are dense (zero-filled) and ascending so charts get a fixed 30-day axis. */
export const DailyCount = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD"),
  count: z.number().int().nonnegative(),
});
export type DailyCount = z.infer<typeof DailyCount>;
```

- [ ] **Step 2: Rewrite `packages/contracts/src/stats/users.ts`**

```ts
import { z } from "zod";
import { DailyCount } from "./daily";

/**
 * GET /admin/stats/users — the dashboard's population + activity metrics, all served from the
 * OpsCounters DynamoDB table (in-VPC admin-api needs no cognito-idp — ADR-0004):
 *
 * - `usersCount` / `suspendedUsersCount`: the EXACT `customerCounter` item (atomic ADD, kept by
 *   the Post-Confirmation trigger + the admin moderation routes). Counts CONFIRMED customers
 *   only — deliberately narrower than the users page's approximate whole-pool estimate
 *   (`ListUsersResponse.total`, includes UNCONFIRMED).
 * - `newToday` / `new7d` / `new30d` + `dailySignups`: sums of the `signupsDaily#<date>` items.
 * - `active7d` / `active30d`: DISTINCT members whose `presence#<sub>` stamp falls in the window.
 *   "Active" means USED THE APP (any authenticated member-API call) — not "signed in recently",
 *   which refresh-token sessions would undercount.
 * - `dailyActive`: the `activeDaily#<date>` items (distinct members per single day).
 *
 * All windows/dates are Asia/Jerusalem. Counters exist from the 2026-07 dashboard slice onward;
 * earlier days read as zero (spec 2026-07-12, approach B).
 */
export const UsersStats = z.object({
  usersCount: z.number().int().nonnegative(),
  suspendedUsersCount: z.number().int().nonnegative(),
  /** Registered since local midnight today / in the rolling last 7 / 30 days. */
  newToday: z.number().int().nonnegative(),
  new7d: z.number().int().nonnegative(),
  new30d: z.number().int().nonnegative(),
  /** Distinct members active in the rolling last 7 / 30 days (see "active" above). */
  active7d: z.number().int().nonnegative(),
  active30d: z.number().int().nonnegative(),
  /** Dense, ascending, exactly 30 entries (oldest → today). */
  dailySignups: z.array(DailyCount).length(30),
  dailyActive: z.array(DailyCount).length(30),
});
export type UsersStats = z.infer<typeof UsersStats>;
```

- [ ] **Step 3: Rewrite `packages/contracts/src/stats/catalog.ts`**

```ts
import { z } from "zod";
import { DailyCount } from "./daily";

/**
 * GET /admin/stats/catalog — exact entity totals from the transactional counters (the sentinel
 * `#counter` items incremented atomically with each conditional create), plus the daily
 * recommendations-created trend (`recsDaily#<date>` items in OpsCounters, bumped fire-and-forget
 * by app-links on each NEW create). `products` = shared catalog items; `recommendations` =
 * members' created links. `dailyCreated`: dense, ascending, exactly 30 entries (oldest → today,
 * Asia/Jerusalem); days before the 2026-07 dashboard slice read as zero.
 */
export const CatalogStats = z.object({
  products: z.number().int().nonnegative(),
  recommendations: z.number().int().nonnegative(),
  dailyCreated: z.array(DailyCount).length(30),
});
export type CatalogStats = z.infer<typeof CatalogStats>;
```

- [ ] **Step 4: Add the barrel export**

In `packages/contracts/src/stats/index.ts` add `export * from "./daily";`. Grep for leftover references to the deleted names:

Run: `grep -rn "UsersDailySignup" packages services apps --include="*.ts" --include="*.tsx" | grep -v dist`
Expected: no hits outside this task's rewritten files.

- [ ] **Step 5: Verify contracts build + tests**

Run: `pnpm --filter @wanthat/contracts build && pnpm --filter @wanthat/contracts test`
Expected: PASS. (Full-repo typecheck is intentionally deferred — web breaks until Task 8.)

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/stats/
git commit -m "feat(contracts): DailyCount trends in UsersStats + CatalogStats"
```

---

### Task 6: admin-api — real stats endpoints

**Files:**
- Modify: `services/admin-api/src/context.ts` (add `opsMetrics`)
- Modify: `services/admin-api/src/handler.ts` (`/admin/stats/users` + `/admin/stats/catalog`)
- Test: `services/admin-api/src/handler.test.ts`

**Interfaces:**
- Consumes: `OpsMetricsRepo`, `lastNDates` (Task 1); `UsersStats`, `CatalogStats` (Task 5). `OPS_COUNTERS_TABLE` env + `grantReadData` already exist for admin-api (admin-stack.ts:99,123) — Scan + BatchGet are covered; no infra change for this task.
- Produces: the wire shapes of Task 5, consumed by the SPA in Task 8.

- [ ] **Step 1: Write the failing tests**

In `services/admin-api/src/handler.test.ts`: add to the hoisted `ctx`:

```ts
    opsMetrics: {
      getDailyCounts: vi.fn(),
      countActiveSince: vi.fn().mockResolvedValue(0),
    },
```

(and its type entry `opsMetrics: { getDailyCounts: ReturnType<typeof vi.fn>; countActiveSince: ReturnType<typeof vi.fn> }`). Then:

```ts
describe("admin users stats", () => {
  it("aggregates counters, windows and dense 30-day series", async () => {
    ctx.customerCounter.get.mockResolvedValue({ total: 12, disabled: 2 });
    // getDailyCounts(metric, dates) → signups: 2 on the last day, 3 on the first; active: 1 daily.
    ctx.opsMetrics.getDailyCounts.mockImplementation(
      async (metric: string, dates: string[]) =>
        new Map(
          dates.map((d, i) => [
            d,
            metric === "signupsDaily" ? (i === dates.length - 1 ? 2 : i === 0 ? 3 : 0) : 1,
          ]),
        ),
    );
    ctx.opsMetrics.countActiveSince.mockResolvedValueOnce(4).mockResolvedValueOnce(9);
    const res = await app.request("/admin/stats/users", {}, adminEnv);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.usersCount).toBe(12);
    expect(body.suspendedUsersCount).toBe(2);
    expect(body.newToday).toBe(2);
    expect(body.new7d).toBe(2); // the first-day 3 falls outside the 7-day window
    expect(body.new30d).toBe(5);
    expect(body.active7d).toBe(4);
    expect(body.active30d).toBe(9);
    expect((body.dailySignups as unknown[]).length).toBe(30);
    expect((body.dailyActive as unknown[]).length).toBe(30);
  });

  it("403s a non-admin", async () => {
    expect((await app.request("/admin/stats/users", {}, memberEnv)).status).toBe(403);
  });
});
```

and extend the catalog describe:

```ts
  it("includes the 30-day created trend", async () => {
    ctx.products.count.mockResolvedValue(1);
    ctx.recommendations.count.mockResolvedValue(2);
    ctx.opsMetrics.getDailyCounts.mockImplementation(
      async (_metric: string, dates: string[]) => new Map(dates.map((d) => [d, 0])),
    );
    const res = await app.request("/admin/stats/catalog", {}, adminEnv);
    const body = (await res.json()) as { dailyCreated: unknown[] };
    expect(body.dailyCreated.length).toBe(30);
  });
```

NOTE: the existing catalog test asserts `toEqual({ products: 41, recommendations: 97 })` — update it to include `dailyCreated` (or assert with `expect.objectContaining`), and give `ctx.opsMetrics.getDailyCounts` a default zero-map mock so older tests keep passing.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter admin-api test`
Expected: FAIL — routes still return the stub shapes.

- [ ] **Step 3: Implement**

1. `services/admin-api/src/context.ts`: add to `AdminContext`:

```ts
  /** Dashboard metrics (read-only here): daily counters + presence items in OpsCounters. */
  opsMetrics: OpsMetricsRepo;
```

wire (reuses the existing `OPS_COUNTERS_TABLE`):

```ts
    opsMetrics: new OpsMetricsRepo(getDocClient(region), requireEnv("OPS_COUNTERS_TABLE")),
```

(import `OpsMetricsRepo` from `@wanthat/dynamo`).

2. `services/admin-api/src/handler.ts`: import `lastNDates` from `@wanthat/dynamo`, then replace the `/admin/stats/users` route:

```ts
// GET /admin/stats/users — population + activity metrics, all DynamoDB (ADR-0004: no
// cognito-idp in the endpoint-free VPC). Counters per the 2026-07-12 dashboard spec:
// exact customerCounter totals, signupsDaily/activeDaily 30-day series (dense, zero-filled,
// Asia/Jerusalem), and DISTINCT active-in-window counts from the presence stamps (which daily
// counters cannot express - repeat visitors would double-count).
app.get("/admin/stats/users", async (c) => {
  const ctx = getContext();
  const dates = lastNDates(30);
  const [counter, signups, active, active7d, active30d] = await Promise.all([
    ctx.customerCounter.get(),
    ctx.opsMetrics.getDailyCounts("signupsDaily", dates),
    ctx.opsMetrics.getDailyCounts("activeDaily", dates),
    ctx.opsMetrics.countActiveSince(dates[dates.length - 7] as string),
    ctx.opsMetrics.countActiveSince(dates[0] as string),
  ]);
  const series = (m: Map<string, number>) => dates.map((date) => ({ date, count: m.get(date) ?? 0 }));
  const sumLast = (m: Map<string, number>, n: number) =>
    dates.slice(-n).reduce((acc, d) => acc + (m.get(d) ?? 0), 0);
  return c.json(
    UsersStats.parse({
      usersCount: counter.total,
      suspendedUsersCount: counter.disabled,
      newToday: sumLast(signups, 1),
      new7d: sumLast(signups, 7),
      new30d: sumLast(signups, 30),
      active7d,
      active30d,
      dailySignups: series(signups),
      dailyActive: series(active),
    }),
  );
});
```

and extend `/admin/stats/catalog`:

```ts
// GET /admin/stats/catalog — exact totals from the transactional counters + the 30-day
// recommendations-created trend (recsDaily items, dense/zero-filled).
app.get("/admin/stats/catalog", async (c) => {
  const ctx = getContext();
  const dates = lastNDates(30);
  const [products, recommendations, created] = await Promise.all([
    ctx.products.count("aliexpress"),
    ctx.recommendations.count(),
    ctx.opsMetrics.getDailyCounts("recsDaily", dates),
  ]);
  return c.json(
    CatalogStats.parse({
      products,
      recommendations,
      dailyCreated: dates.map((date) => ({ date, count: created.get(date) ?? 0 })),
    }),
  );
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter admin-api test`
Expected: PASS (existing + new).

- [ ] **Step 5: Commit**

```bash
git add services/admin-api/src/
git commit -m "feat(admin-api): real users/catalog stats - windows + 30-day trends"
```

---

### Task 7: Infra — OpsCounters wiring for app-core + app-links

**Files:**
- Modify: `infra/lib/api-stack.ts` (props + env + grants)
- Modify: `infra/bin/wanthat.ts` (pass the table to ApiStack)

**Interfaces:**
- Consumes: `data.opsCountersTable` (DataStack, exists).
- Produces: `OPS_COUNTERS_TABLE` env + write grants for both API functions (Tasks 3–4 depend on these at runtime).

- [ ] **Step 1: Wire the table**

1. `infra/lib/api-stack.ts` props (`ApiStackProps`, near `runtimeConfigTable`):

```ts
  /** Dashboard metrics: daily counters + presence stamps (see packages/dynamo ops-metrics). */
  readonly opsCountersTable: dynamodb.ITable;
```

2. Add to BOTH functions' `environment` blocks (comment ASCII-only):

```ts
        // Dashboard metrics (spec 2026-07-12): presence stamps + daily counters in OpsCounters.
        OPS_COUNTERS_TABLE: props.opsCountersTable.tableName,
```

3. Grants, next to each function's existing table grants:

```ts
    // Write-only on OpsCounters: presence stamps + daily counter ADDs are UpdateItems.
    props.opsCountersTable.grantWriteData(appLinksFn);
```

```ts
    props.opsCountersTable.grantWriteData(appCoreFn);
```

4. `infra/bin/wanthat.ts`, in the `new ApiStack(...)` props (after `runtimeConfigTable`):

```ts
  // Dashboard metrics: app-core + app-links stamp presence / bump daily counters.
  opsCountersTable: data.opsCountersTable,
```

- [ ] **Step 2: Synth**

Run: `pnpm synth`
Expected: synth completes with no errors (no AWS creds needed).

- [ ] **Step 3: Commit**

```bash
git add infra/lib/api-stack.ts infra/bin/wanthat.ts
git commit -m "feat(infra): OpsCounters env + write grants for app-core and app-links"
```

---

### Task 8: Web — dashboard UI + i18n

**Files:**
- Modify: `apps/web/src/features/admin/AdminPage.tsx` (dashboard section only)
- Modify: `apps/web/src/i18n.ts` (admin strings, BOTH `en` and `he` sections)

**Interfaces:**
- Consumes: `UsersStats` / `CatalogStats` (Task 5) via the existing `adminApi.usersStats` / `adminApi.catalogStats` (no client changes — types flow from `@wanthat/contracts`).
- Produces: the dashboard per the spec: headline KPI row, second money-placeholder row, revived users panel, active + recommendations trend charts.

- [ ] **Step 1: i18n strings**

In `apps/web/src/i18n.ts`, in the admin `stats`/`users` blocks (en around lines 320–339, he mirrored around line ~840+):

en:
- `stats.users`: change `"Active users"` → `"Registered users"`.
- `stats` add: `active30d: "Active members (30d)"`.
- `users`: DELETE `active: "Active"` and the whole `unavailable:` entry; ADD:
  - `active7d: "Active (7d)"`,
  - `active30d: "Active (30d)"`,
  - `activeTrend: "Active members (last 30 days)"`.
- Add a sibling block after `users`: `recs: { title: "Recommendations", createdTrend: "Created (last 30 days)" }`.

he (keep key parity — the admin-i18n test enforces it):
- `stats.users`: `"משתמשים רשומים"`.
- `stats.active30d`: `"חברים פעילים (30 יום)"`.
- `users.active7d`: `"פעילים (7 ימים)"`, `users.active30d`: `"פעילים (30 יום)"`, `users.activeTrend`: `"חברים פעילים (30 הימים האחרונים)"`; delete `active` and `unavailable`.
- `recs: { title: "המלצות", createdTrend: "נוצרו (30 הימים האחרונים)" }`.

- [ ] **Step 2: Rework the dashboard in `AdminPage.tsx`**

All changes inside the "Dashboard" section (lines ~168–355):

1. **`DashboardView`** — keep the three fetches; rework the cards:

```tsx
function DashboardView({ token }: { token: string | null }) {
  const { t } = useTranslation();
  const [users, setUsers] = useState<UsersStats | null>(null);
  const [failed, setFailed] = useState(false);
  // undefined = loading, null = fetch failed.
  const [catalog, setCatalog] = useState<CatalogStats | null | undefined>(undefined);
  // The user-count KPI: EXACT — `statsOverview.usersCount` reads the `customerCounter` item in
  // OpsCounters (kept by the Post-Confirmation trigger + the moderation routes), so it counts
  // CONFIRMED customers only. The users PAGE header deliberately keeps the other, approximate
  // semantic: `ListUsersResponse.total` estimates the WHOLE pool, including UNCONFIRMED signups.
  const [overview, setOverview] = useState<StatsOverview | null | undefined>(undefined);
  useEffect(() => {
    if (!token) return;
    adminApi
      .usersStats(token)
      .then((u) => {
        setUsers(u);
        setFailed(false);
      })
      .catch(() => setFailed(true));
    adminApi
      .catalogStats(token)
      .then(setCatalog)
      .catch(() => setCatalog(null));
    adminApi
      .statsOverview(token)
      .then(setOverview)
      .catch(() => setOverview(null));
  }, [token]);

  // Skeleton placeholder while the stats request is in flight, so the module doesn't flash "…".
  const num = (v: number | undefined) =>
    v === undefined ? <Skeleton className="h-[30px] w-16" /> : v.toLocaleString("en-US");

  return (
    <div className="flex flex-col gap-[18px]">
      {/* Headline KPIs (spec 2026-07-12): registered, active, recommendations, products. */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <KpiCard
          label={t("admin.stats.users")}
          value={
            overview === null ? (
              "—"
            ) : overview === undefined ? (
              <Skeleton className="h-[30px] w-16" />
            ) : (
              overview.usersCount.toLocaleString("en-US")
            )
          }
          live
          icon={
            <>
              <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
            </>
          }
        />
        <KpiCard
          label={t("admin.stats.active30d")}
          value={failed ? "—" : num(users?.active30d)}
          live
          icon={
            <>
              <circle cx="12" cy="12" r="9" />
              <path d="M8 12l3 3 5-6" />
            </>
          }
        />
        <KpiCard
          label={t("admin.stats.links")}
          value={catalog === null ? "—" : num(catalog?.recommendations)}
          live
          icon={
            <>
              <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" />
              <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />
            </>
          }
        />
        <KpiCard
          label={t("admin.stats.products")}
          value={catalog === null ? "—" : num(catalog?.products)}
          live
          icon={
            <>
              <path d="M21 8l-9-5-9 5v8l9 5 9-5V8z" />
              <path d="M3 8l9 5 9-5M12 13v8" />
            </>
          }
        />
      </div>

      {/* Money KPIs: still placeholders — the wallet-aggregation slice's job, not deleted. */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
        <KpiCard
          label={t("admin.stats.cashback")}
          value="—"
          icon={<path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />}
        />
        <KpiCard
          label={t("admin.stats.pending")}
          value="—"
          tone="pending"
          icon={
            <>
              <circle cx="12" cy="12" r="9" />
              <path d="M12 7v5l3 2" />
            </>
          }
        />
        <KpiCard
          label={t("admin.stats.conversions")}
          value="—"
          icon={
            <>
              <path d="M3 17l6-6 4 4 7-7" />
              <path d="M14 8h6v6" />
            </>
          }
        />
      </div>

      <UsersPanel users={failed ? null : users} failed={failed} />
      <RecsPanel catalog={catalog} />
    </div>
  );
}
```

2. **`UsersPanel`** — six tiles + two charts (drop the `unavailable` branch entirely):

```tsx
function UsersPanel({ users, failed }: { users: UsersStats | null; failed: boolean }) {
  const { t } = useTranslation();
  const num = (v: number | undefined) =>
    v === undefined ? <Skeleton className="h-[22px] w-12" /> : v.toLocaleString("en-US");
  return (
    <div className="rounded-card border border-line bg-surface p-5">
      <h2 className="mb-4 font-display text-lg font-semibold text-ink">{t("admin.users.title")}</h2>
      {failed ? (
        <div className="py-10 text-center text-sm text-muted">{t("admin.users.error")}</div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <StatTile label={t("admin.users.newToday")} value={num(users?.newToday)} />
            <StatTile label={t("admin.users.new7d")} value={num(users?.new7d)} />
            <StatTile label={t("admin.users.new30d")} value={num(users?.new30d)} />
            <StatTile label={t("admin.users.active7d")} value={num(users?.active7d)} />
            <StatTile label={t("admin.users.active30d")} value={num(users?.active30d)} />
            <StatTile label={t("admin.users.suspended")} value={num(users?.suspendedUsersCount)} />
          </div>
          <div className="mt-5">
            <div className="mb-2 text-[12.5px] font-semibold text-muted">
              {t("admin.users.signups30d")}
            </div>
            <DailyTrend data={users?.dailySignups ?? null} />
          </div>
          <div className="mt-5">
            <div className="mb-2 text-[12.5px] font-semibold text-muted">
              {t("admin.users.activeTrend")}
            </div>
            <DailyTrend data={users?.dailyActive ?? null} />
          </div>
        </>
      )}
    </div>
  );
}
```

3. **`RecsPanel`** — new, below UsersPanel:

```tsx
function RecsPanel({ catalog }: { catalog: CatalogStats | null | undefined }) {
  const { t } = useTranslation();
  return (
    <div className="rounded-card border border-line bg-surface p-5">
      <h2 className="mb-4 font-display text-lg font-semibold text-ink">{t("admin.recs.title")}</h2>
      {catalog === null ? (
        <div className="py-10 text-center text-sm text-muted">{t("admin.users.error")}</div>
      ) : (
        <div>
          <div className="mb-2 text-[12.5px] font-semibold text-muted">
            {t("admin.recs.createdTrend")}
          </div>
          <DailyTrend data={catalog?.dailyCreated ?? null} />
        </div>
      )}
    </div>
  );
}
```

4. **`SignupTrend` → `DailyTrend`** — rename and generalize the type (body unchanged):

```tsx
/** A compact 30-bar daily trend. LTR regardless of page direction so time reads left→right. */
function DailyTrend({ data }: { data: { date: string; count: number }[] | null }) {
```

(the JSX inside stays exactly as `SignupTrend` had it).

5. Update the type import at the top of AdminPage.tsx: `UsersStats` now comes from `../../lib/admin-api` already — verify `CatalogStats`/`UsersStats` imports still resolve (they re-export from `@wanthat/contracts`; shapes changed but names didn't).

- [ ] **Step 3: Verify the whole repo compiles + tests pass**

Run: `pnpm typecheck && pnpm --filter web test`
Expected: PASS — this is the task that closes the Task-5 breakage. (The admin i18n parity test must pass with the new keys in both languages.)

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/features/admin/AdminPage.tsx apps/web/src/i18n.ts
git commit -m "feat(web): dashboard leads with registered/active/recommendation KPIs + 30-day trends"
```

---

### Task 9: Full verification + PR

**Files:** none (verification + delivery)

- [ ] **Step 1: Full verification suite**

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm synth
```

Expected: all green. Fix anything red at the source (never suppress warnings).

- [ ] **Step 2: cdk diff (needs AWS creds; if expired, STOP and ask Dennis to re-login)**

```bash
pnpm diff
```

Expected changes ONLY: `OPS_COUNTERS_TABLE` env on app-core/app-links + two IAM write-grant policies + the Lambda code-hash updates. Anything destructive → stop and surface it.

- [ ] **Step 3: Open the PR (ready, not draft)**

Push the branch and open a PR titled `feat(admin): dashboard real KPIs + 30-day trends` — body summarizing: OpsCounters daily counters + presence stamps, active = used-the-app, new stats shapes, dashboard rework, no new ADR (application of ADR-0003/0020 patterns). Wait for CI + Check Deploy; a red Check Deploy is BLOCKING.

- [ ] **Step 4: Merge → dev deploys automatically**

After checks are green, merge. The Deploy workflow applies dev on the merge commit.

---

### Task 10: Verify dev, then deliver prod

**Files:** none (operations)

- [ ] **Step 1: Watch the dev deploy**

```bash
gh run watch $(gh run list --workflow deploy.yml --limit 1 --json databaseId -q '.[0].databaseId')
```

Expected: success.

- [ ] **Step 2: Verify dev end-to-end**

- `GET /admin/stats/users` (with a dev admin token, or via the dev admin console in the browser) returns the new shape with `dailySignups`/`dailyActive` arrays of 30.
- Open the dev admin dashboard: headline KPI row renders (Registered / Active 30d / Recommendations / Products), users panel shows tiles + two charts, recommendations panel shows its chart. Charts may be all-zero — expected until traffic accrues.
- Hit an authenticated member endpoint on dev (e.g. open the member app) and confirm a `presence#<sub>` item + today's `activeDaily#` item appear in the dev OpsCounters table (`aws dynamodb scan --table-name <dev OpsCounters> --max-items 20`).

- [ ] **Step 3: Deliver prod via a GitHub Release**

Per the deploy workflow: publishing a non-prerelease Release deploys prod (behind the `prod` environment approval — Dennis may need to click approve in GitHub).

```bash
git tag -l 'v[0-9]*' | sort -V | tail -1   # find the latest version tag (v0.0.9 at planning time)
gh release create v0.0.10 --target main --title "v0.0.10 - admin dashboard KPIs" --notes "Admin dashboard: real registered/active/recommendation KPIs + 30-day trends (signups, active members, recommendations created)."
```

Expected: the Deploy workflow runs with `WANTHAT_ENV=prod` (may wait on the environment approval) and succeeds.

- [ ] **Step 4: Verify prod**

Open the prod admin dashboard and confirm the new layout renders with real registered-user numbers (counters/trends start at zero — expected, approach B).
