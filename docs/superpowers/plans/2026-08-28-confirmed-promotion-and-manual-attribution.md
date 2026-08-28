# Confirmed-order promotion + manual-attribution completion — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make matured AliExpress orders (tracked and manually-attributed) advance from `pending` to `confirmed` in the wallet, via a new wide, slow-cadence "Buyer Confirmed Receipt" scan.

**Architecture:** Split the settlement poll window by status. The existing narrow watermark scan keeps handling new orders (`Payment Completed` → `pending`). A new `scanConfirmedOrders` step sweeps a wide fixed window (`[now − confirmScanDays, now]`) for `Buyer Confirmed Receipt` on a slow cadence, resolving tracked orders via `custom_parameters` and manual orders by injecting the stored `unattributed_order.claim`, writing `confirmed` rows through the sole money writer. `settle-claims` (initial manual `pending` credit) is unchanged.

**Tech Stack:** TypeScript, Node 24, AWS Lambda (`retailer-settlement`, non-VPC), DynamoDB (`@wanthat/dynamo`), Zod contracts (`@wanthat/contracts`), Vitest, Biome, CDK.

## Global Constraints

- Money enters ONLY through `ledger-writer` via `invokeWriter` (audit-or-fail). Never write money elsewhere (ADR-0002/0004).
- Ledger is append-only; the `(order_id, kind, status)` unique index makes repeated writes idempotent no-ops (ADR-0009). Re-scans must rely on this, never on read-modify-write.
- Manual attribution reads OUR stored `claim` (DynamoDB `unattributed_order`), never AliExpress `custom_parameters`.
- `confirmScanDays` MUST stay under the `listbyindex` max window span (empirically `∈ (87, 365)` days). Default 80.
- Retailer calls stay sequential with the ADR-0021 throttle (one ~1.2s retry on `ApiCallLimit`). Never parallel retailer calls.
- No new infra/IAM: `retailer-settlement` already grants config read, `poller_state` r/w, `unattributed_order` r/w, and `ledger-writer` invoke.
- Run `pnpm lint` (Biome) before any PR; CI runs it. Always `cdk diff` before deploy.

---

### Task 1: Add the two poller config keys

**Files:**
- Modify: `packages/contracts/src/config/keys.ts` (schema defs near line 53; `CONFIG_KEYS` ~line 143; `CONFIG_SCHEMAS` ~line 171; `CONFIG_DEFAULTS` ~line 200)
- Test: `packages/contracts/src/config/keys.test.ts` (or the existing config test file)

**Interfaces:**
- Produces: config keys `"poller.confirmScanDays"` (schema `PollerConfirmScanDays`, default `80`) and `"poller.confirmScanIntervalMinutes"` (schema `PollerConfirmScanIntervalMinutes`, default `720`). Read via `RuntimeConfigRepo.get(key)` → number.

- [ ] **Step 1: Write the failing test** — assert the new keys parse and expose defaults.

```ts
import { CONFIG_DEFAULTS, CONFIG_SCHEMAS } from "./keys";

it("defines poller.confirmScanDays (default 80, under the listbyindex span cap)", () => {
  expect(CONFIG_DEFAULTS["poller.confirmScanDays"]).toBe(80);
  expect(CONFIG_SCHEMAS["poller.confirmScanDays"].parse(85)).toBe(85);
  expect(() => CONFIG_SCHEMAS["poller.confirmScanDays"].parse(400)).toThrow();
});

it("defines poller.confirmScanIntervalMinutes (default 720)", () => {
  expect(CONFIG_DEFAULTS["poller.confirmScanIntervalMinutes"]).toBe(720);
  expect(CONFIG_SCHEMAS["poller.confirmScanIntervalMinutes"].parse(1440)).toBe(1440);
});
```

- [ ] **Step 2: Run it, expect FAIL** — `pnpm --filter @wanthat/contracts test -- keys` (key not present).

- [ ] **Step 3: Implement.** Add near line 53:

```ts
/** Wide-window span (days) the confirmed-status scan re-reads to catch maturation. Under the
 * listbyindex max window span (empirically <90 days; ADR-0009 amendment). Read per run. */
export const PollerConfirmScanDays = z.number().int().min(1).max(85);
/** Cadence (minutes) of the wide confirmed-status scan — slower than the new-order poll; confirmed
 * money is not latency-sensitive. Read per run. */
export const PollerConfirmScanIntervalMinutes = z.number().int().min(15).max(10080);
```

Add `"poller.confirmScanDays"` and `"poller.confirmScanIntervalMinutes"` to `CONFIG_KEYS` (next to the other `poller.*`), to `CONFIG_SCHEMAS` (`PollerConfirmScanDays` / `PollerConfirmScanIntervalMinutes`), and to `CONFIG_DEFAULTS` (`80` / `720`).

- [ ] **Step 4: Run tests, expect PASS.** `pnpm --filter @wanthat/contracts test -- keys`

- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat(contracts): poller.confirmScanDays + confirmScanIntervalMinutes config keys"`

---

### Task 2: Extract the shared `manualClaimWrite` helper

**Files:**
- Create: `services/retailer-settlement/src/manual-claim.ts`
- Modify: `services/retailer-settlement/src/settle-claims.ts` (use the helper — no behavior change)
- Test: `services/retailer-settlement/src/manual-claim.test.ts`

**Interfaces:**
- Produces:
```ts
export function manualClaimWrite(args: {
  orderId: string;
  recommendationId: string;
  referrerSub: string;
  cashback: { referrerBps: number; consumerBps: number };
  gross: bigint;
  currency: string;
  status: WalletEntryStatus;      // from @wanthat/contracts
  occurredAt: string;
}): ConversionWrite;               // from @wanthat/contracts
```
Referrer-only (`consumer: null`, `consumer: "none"`) — an unattributed order has no known buyer.

- [ ] **Step 1: Write the failing test.**

```ts
import { manualClaimWrite } from "./manual-claim";

it("builds a referrer-only ConversionWrite from a claim (consumer none)", () => {
  const w = manualClaimWrite({
    orderId: "O1", recommendationId: "R1", referrerSub: "sub-1",
    cashback: { referrerBps: 5000, consumerBps: 0 },
    gross: 100n, currency: "USD", status: "confirmed", occurredAt: "2026-08-01T00:00:00.000Z",
  });
  expect(w.consumer).toBe("none");
  expect(w.resolved.consumer).toBeNull();
  expect(w.resolved.status).toBe("confirmed");
  expect(w.resolved.referrer.sub).toBe("sub-1");
  expect(w.resolved.referrer.reward.amountMinor).toBe(50n);
  expect(w.gross.amountMinor).toBe(100n);
});
```

- [ ] **Step 2: Run it, expect FAIL** — `pnpm --filter @wanthat/retailer-settlement test -- manual-claim`

- [ ] **Step 3: Implement `manual-claim.ts`.**

```ts
import type { ConversionWrite, WalletEntryStatus } from "@wanthat/contracts";
import { splitCommission } from "@wanthat/domain";

/** Assemble the ledger write for a manually-attributed (claimed) order: referrer-only, since an
 * unattributed order has no known buyer. Single source of the manual money math — used by the
 * claim-settlement sweep (initial pending credit) and the confirmed scan (promotion). */
export function manualClaimWrite(args: {
  orderId: string;
  recommendationId: string;
  referrerSub: string;
  cashback: { referrerBps: number; consumerBps: number };
  gross: bigint;
  currency: string;
  status: WalletEntryStatus;
  occurredAt: string;
}): ConversionWrite {
  const split = splitCommission(args.gross, args.cashback.referrerBps, args.cashback.consumerBps);
  return {
    resolved: {
      orderId: args.orderId,
      recommendationId: args.recommendationId,
      referrer: { sub: args.referrerSub, reward: { amountMinor: split.referrerMinor, currency: args.currency } },
      consumer: null,
      status: args.status,
      occurredAt: args.occurredAt,
    },
    gross: { amountMinor: args.gross, currency: args.currency },
    consumer: "none",
  };
}
```

- [ ] **Step 4: Refactor `settle-claims.ts`** to build its `write` via `manualClaimWrite(...)`:

```ts
const write = manualClaimWrite({
  orderId: item.orderId,
  recommendationId: rec.recommendationId,
  referrerSub: rec.ownerId,
  cashback: rec.cashback,
  gross: BigInt(item.commissionMinor),
  currency: item.currency ?? "USD",
  status: mapStatus(item.orderStatus) ?? "pending",
  occurredAt: item.occurredAt ?? deps.now().toISOString(),
});
```
Remove the now-unused inline `splitCommission` import if no longer referenced there.

- [ ] **Step 5: Run tests, expect PASS.** `pnpm --filter @wanthat/retailer-settlement test` (manual-claim + existing settle-claims tests still green).

- [ ] **Step 6: Commit.** `git commit -am "refactor(settlement): extract manualClaimWrite, reuse in settle-claims"`

---

### Task 3: Narrow the new-order poll to Payment Completed only

**Files:**
- Modify: `services/retailer-settlement/src/poll-orders.ts` (`POLL_STATUSES`, ~line 47)
- Test: `services/retailer-settlement/src/poll-orders.test.ts`

**Interfaces:**
- Produces: `POLL_STATUSES = ["Payment Completed"] as const` — the narrow scan no longer queries `"Buyer Confirmed Receipt"` (proven useless in the recent window; moved to `scanConfirmedOrders`).

- [ ] **Step 1: Write/adjust the failing test** — assert the poll queries ONLY `Payment Completed`.

```ts
it("queries only Payment Completed in the narrow scan", async () => {
  const statuses: string[] = [];
  const client = fakeClient((params) => { statuses.push(params.status); return { orders: [], nextQueryIndexId: null }; });
  await pollOrders(depsWith(client));
  expect(statuses).toEqual(["Payment Completed"]);
});
```
(Update any existing test that asserted two status sweeps.)

- [ ] **Step 2: Run it, expect FAIL** — currently sweeps both statuses.

- [ ] **Step 3: Implement** — `export const POLL_STATUSES = ["Payment Completed"] as const;` and update the block comment (drop the "one per status filter" pair note).

- [ ] **Step 4: Run tests, expect PASS.** `pnpm --filter @wanthat/retailer-settlement test -- poll-orders`

- [ ] **Step 5: Commit.** `git commit -am "feat(settlement): narrow poll to Payment Completed (confirmed moves to a wide scan)"`

---

### Task 4: `scanConfirmedOrders` — the wide, slow-cadence confirmed scan

**Files:**
- Create: `services/retailer-settlement/src/scan-confirmed.ts`
- Test: `services/retailer-settlement/src/scan-confirmed.test.ts`

**Interfaces:**
- Consumes: `AttributionDeps` + `resolveOrder`, `mapStatus`, `parseGmt8`, `toGmt8` (from `./attribution` / `./poll-orders`), `manualClaimWrite` (Task 2), `UnattributedOrderRepo.get`/`recordSighting`, `PollerStateRepo`, `RuntimeConfigBatchReader`, `AliExpressClient`, `InvokeWriter`.
- Produces:
```ts
export const CONFIRMED_STATE_KEY = "aliexpress#confirmed";
export const CONFIRMED_STATUS = "Buyer Confirmed Receipt";
export interface ScanConfirmedDeps {
  client: () => Promise<AliExpressClient | null>;
  state: PollerStateRepo;
  config: RuntimeConfigBatchReader;
  attribution: AttributionDeps;
  recommendations: Pick<RecommendationRepo, "get">;
  unattributed: Pick<UnattributedOrderRepo, "get" | "recordSighting">;
  invokeWriter: ((req: WriteConversionsRequest) => Promise<WriteConversionsResponse>) | null;
  now: () => Date;
  sleep?: (ms: number) => Promise<void>;
  logger: Logger;
}
export async function scanConfirmedOrders(deps: ScanConfirmedDeps): Promise<ConfirmedScanSummary>;
```

**Behavior:**
1. Gate: read `poller.confirmScanIntervalMinutes`; if `state.get(CONFIRMED_STATE_KEY)` ran within the interval, return `{ ran: false, ... }`.
2. Build client (dry mode if null → log, don't write).
3. Window: `confirmScanDays = config.get("poller.confirmScanDays")`; `start = now − confirmScanDays days`; `[toGmt8(start), toGmt8(now)]`.
4. Paginate `listOrdersByIndex({ status: CONFIRMED_STATUS, ... })` with the ADR-0021 throttle retry.
5. For each order:
   - `resolveOrder(order, attribution)`; if `resolved` → push `outcome.write`.
   - else if `reason === "no_ref"` → `item = unattributed.get(order.orderId)`; if `item?.claim` and `order.commissionMinor` and `mapStatus(order.status)` and `recommendations.get(claim.recommendationId)` → push `manualClaimWrite({... status: mapStatus(order.status), gross: BigInt(order.commissionMinor), currency: order.commissionCurrency ?? "USD", occurredAt: parseGmt8(order.orderTimeGmt8) ?? now, referrerSub: rec.ownerId, cashback: rec.cashback, recommendationId: rec.recommendationId })`. If no claim → `recordSighting(...)` (keep it claimable). Log skips.
   - else (`foreign_env` etc.) → log, skip.
6. Batch `invokeWriter` in `WRITE_BATCH` (25) chunks (same as poll).
7. `state.put({ stateKey: CONFIRMED_STATE_KEY, lastRunAt: now.toISOString(), watermarkEndTime: now.toISOString() })` (watermark unused for the fixed window but the item schema requires it).

- [ ] **Step 1: Write failing tests** (fakes only — no live calls):

```ts
// tracked confirmed order → confirmed write
it("writes a confirmed row for a tracked matured order", async () => {
  const writes = captureWrites();
  await scanConfirmedOrders(deps({ orders: [trackedOrder({ status: "Buyer Confirmed Receipt" })], writes }));
  expect(writes.last().resolved.status).toBe("confirmed");
});

// manual (no_ref + claim) → injected confirmed write
it("injects the stored claim for a manual matured order", async () => {
  const writes = captureWrites();
  const unattributed = fakeUnattributed({ O9: itemWithClaim({ recommendationId: "R1" }) });
  await scanConfirmedOrders(deps({ orders: [noRefOrder({ orderId: "O9", status: "Buyer Confirmed Receipt", commissionMinor: "100" })], unattributed, writes }));
  expect(writes.last().resolved.status).toBe("confirmed");
  expect(writes.last().consumer).toBe("none");
  expect(writes.last().resolved.recommendationId).toBe("R1");
});

// no_ref without a claim → sighting only, no write
it("only sights an unclaimed no_ref order, never credits it", async () => {
  const writes = captureWrites();
  const sighted: string[] = [];
  await scanConfirmedOrders(deps({ orders: [noRefOrder({ orderId: "O0" })], writes, onSight: (id) => sighted.push(id) }));
  expect(writes.all()).toHaveLength(0);
  expect(sighted).toContain("O0");
});

// cadence gate: recently run → no scan
it("skips when the confirm-scan interval has not elapsed", async () => {
  const client = vi.fn();
  await scanConfirmedOrders(deps({ lastRunAt: "now-ish (within interval)", client }));
  expect(client).not.toHaveBeenCalled();
});

// fixed wide window, not the watermark
it("scans [now - confirmScanDays, now], independent of any watermark", async () => {
  const captured = captureWindow();
  await scanConfirmedOrders(deps({ confirmScanDays: 80, captured }));
  expect(daysSpan(captured)).toBeCloseTo(80, 0);
});
```

- [ ] **Step 2: Run, expect FAIL** — `pnpm --filter @wanthat/retailer-settlement test -- scan-confirmed` (module missing).

- [ ] **Step 3: Implement `scan-confirmed.ts`** per the Behavior spec above (mirror `poll-orders.ts` structure: gate → client → window → paginated sweep with `withThrottleRetry` → resolve/inject → batched writer → state put). Reuse `toGmt8`/`OVERLAP`-free fixed window; import `resolveOrder`, `mapStatus`, `parseGmt8` from `./attribution`, `toGmt8` from `./poll-orders`, `manualClaimWrite` from `./manual-claim`.

- [ ] **Step 4: Run tests, expect PASS.** `pnpm --filter @wanthat/retailer-settlement test -- scan-confirmed`

- [ ] **Step 5: Commit.** `git commit -am "feat(settlement): scanConfirmedOrders — wide confirmed scan, tracked + manual injection"`

---

### Task 5: Wire `scanConfirmedOrders` into the heartbeat

**Files:**
- Modify: `services/retailer-settlement/src/handler.ts` (deps assembly ~105-139; handler ~144-153)
- Test: existing `poll-orders.test.ts` / a small handler test if present (the deps wiring is covered by Task 4 unit tests; this task is integration glue)

**Interfaces:**
- Consumes: `scanConfirmedOrders`, `ScanConfirmedDeps` (Task 4).

- [ ] **Step 1: Add a `confirmed: ScanConfirmedDeps` branch** to the `cached` deps object, reusing the same `client`, `config`, `attribution`, `unattributed`, `recommendations`, `invokeWriter`, `logger`, and `state` (`new PollerStateRepo(...)` — can reuse the poll's instance).

- [ ] **Step 2: Call it each heartbeat** in `handler`, after `pollOrders`, before/after `settleClaims`:

```ts
const summary = await pollOrders(deps.poll);
logger.info("poll_summary", { summary: JSON.stringify(summary) });
const confirmed = await scanConfirmedOrders(deps.confirmed);
if (confirmed.ran) logger.info("confirmed_scan_summary", { ...confirmed });
const claims = await settleClaims(deps.claims);
if (claims.processed > 0) logger.info("claims_summary", { ...claims });
return summary;
```

- [ ] **Step 3: Typecheck + full service test.** `pnpm --filter @wanthat/retailer-settlement typecheck && pnpm --filter @wanthat/retailer-settlement test`

- [ ] **Step 4: Commit.** `git commit -am "feat(settlement): run scanConfirmedOrders every heartbeat"`

---

### Task 6: Verify, ship to dev, promote to prod

- [ ] **Step 1: Full verification.** `pnpm typecheck && pnpm lint && pnpm test && pnpm synth`. All green. `pnpm diff` shows NO infra change (code-only bundle update to `retailer-settlement`).
- [ ] **Step 2: PR.** Push branch `feat/confirmed-promotion-manual-attribution`, open PR to `main`, wait for `ci` + `check-deploy` + CodeQL green.
- [ ] **Step 3: Merge → dev.** Squash-merge; watch the dev Deploy to success.
- [ ] **Step 4: Verify self-heal in dev/prod.** After the first confirmed-scan cadence tick (or temporarily lower `poller.confirmScanIntervalMinutes` via admin to force a run), confirm the 14 orphaned orders (incl. Dennis's) get `confirmed` rows. In prod: check Dennis's wallet flips from pending to available.
- [ ] **Step 5: Promote to prod.** Create a GitHub Release (next tag from latest) targeting `main` → auto-triggers the prod Deploy. Confirm success.

## Self-Review

**Spec coverage:** split window (Task 3 narrow + Task 4 wide) ✓; manual injection (Task 4) ✓; settle-claims unchanged except DRY refactor (Task 2) ✓; config keys (Task 1) ✓; self-heal/backfill (Task 6 step 4) ✓; idempotency (Global Constraints + Task 4 rely on unique index) ✓; no infra change (Task 6 step 1) ✓; ADR-0009 amendment note (spec — optional doc, fold into Task 4 commit body).

**Placeholders:** none — all steps carry concrete code or exact commands.

**Type consistency:** `manualClaimWrite` signature identical in Task 2 (defined) and Task 4 (consumed); `ScanConfirmedDeps`/`CONFIRMED_STATE_KEY` defined in Task 4, consumed in Task 5; config key strings match Task 1 across Task 4's `config.get`.
