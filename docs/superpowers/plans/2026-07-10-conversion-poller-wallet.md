# Conversion Poller + Wallet Update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-07-10-conversion-poller-wallet-design.md` — read it first.

**Goal:** Ingest AliExpress conversions on a schedule (proxy polls `order.listbyindex`, resolves `ref`/`c`/`g` attribution, in-VPC writer appends the append-only ledger + audit chain) and serve real wallet balances (app-core aggregation + existing SPA).

**Architecture:** EventBridge 15-min heartbeat → retailer-proxy `listOrders` op (self-gated by admin config `poller.intervalMinutes`, default 30; GMT+8 windows; watermark in a new `poller_state` DynamoDB table; attribution resolved against recommendation/guest_attribution) → invokes the in-VPC conversion-poller-writer (`poller_writer` role, `ON CONFLICT DO NOTHING` on the `(order_id, kind, status)` unique index, `audit_append`, `ConversionEvent` log line, conversions counter). Wallet reads: fetch a member's entries, derive balances in pure code, FX-estimate via the cached rate. Dev only — the prod schedule stays disabled.

**Tech Stack:** TypeScript/Node 24, Zod contracts, Kysely + pg (IAM auth), DynamoDB, CDK v2, vitest (+ testcontainers for db tests — CI has Docker; locally they may fail without it, CI is the gate).

## Global Constraints

- Commands at repo root: `pnpm lint` (biome; run `npx biome check --write .` before), `pnpm typecheck`, `pnpm test`, `pnpm synth`; `pnpm turbo typecheck --force` before trusting a green (stale workspace `dist` lies — rebuild with `pnpm build` after cross-package changes).
- PRs opened **ready**, in order A → B → C; merge to main deploys dev.
- Money: bigint minor units in code, decimal-string on JSON wires (`moneyJson` replacer pattern). Rewards credit in **USD** (settlement currency); ILS only for display estimates.
- Append-only ledger: never UPDATE/DELETE `wallet_entry` (types already forbid it); idempotency = the existing unique index `wallet_entry_order_kind_status_idx (order_id, kind, status)`.
- Migrations cannot create roles (`wanthat_migrator` has no CREATEROLE); `poller_writer` grants already exist (migration 0006) — this slice needs **no new migration**.
- ADR-0021 throttling: retailer calls sequential; exactly one retry after ~1.2s on `ApiCallLimit` (reuse the `withThrottleRetry` shape from `services/retailer-proxy/src/generate-link.ts:127-136`).
- New workspace packages imported by a Lambda → `infra/package.json` devDependencies. ASCII-only AWS descriptions, no parentheses.
- The VPC is endpoint-free except the **existing free DynamoDB gateway endpoint** (`infra/lib/network-stack.ts:62-66`) — in-VPC functions may use DynamoDB but can NOT invoke Lambdas or other AWS APIs.
- Integration-pending facts (ADR-0009): exact `order.listbyindex` response field names and the full status enum. Parse tolerantly; log + skip unknowns; verify against the first real dev order.

---

## PR A — order ingestion, dry (no money writes)

### Task 1: `@wanthat/aliexpress` — `listOrdersByIndex`

**Files:**
- Modify: `packages/aliexpress/src/client.ts`
- Test: `packages/aliexpress/src/client.test.ts` (extend; mirror the existing `getProductDetail` test style with an injected `fetchFn`)

**Interfaces:**
- Consumes: existing private `call()` (`client.ts:217-247`), `OrderListByIndexParams` (`client.ts:13-20` — already declared), `AliExpressApiError`.
- Produces (Task 4 consumes):

```ts
export interface AliExpressOrder {
  orderId: string;                 // order_id / order_number, stringified
  status: string;                  // raw platform status, e.g. "Payment Completed"
  customParameters: string | null; // raw round-tripped JSON/string; parsing is the proxy's job
  commissionMinor: string | null;  // estimated commission, integer minor units (decimalToMinor)
  commissionCurrency: string | null;
  orderTimeGmt8: string | null;    // raw platform timestamp, informational
}
export interface OrderListPage {
  orders: AliExpressOrder[];
  nextQueryIndexId: string | null; // cursor for the next page; null = done
}
// on AliExpressClient:
async listOrdersByIndex(params: OrderListByIndexParams, timeoutMs = 8000): Promise<OrderListPage>
```

- [ ] **Step 1: Failing tests** — gateway request contains `method=aliexpress.affiliate.order.listbyindex`, `start_time`/`end_time`/`status`/`tracking_id` (+ `start_query_index_id` when given); a fixture payload parses into `AliExpressOrder[]` with commission via `decimalToMinor`; an order missing `custom_parameters` yields `customParameters: null`; an empty result yields `{orders: [], nextQueryIndexId: null}` (NOT a throw — unlike link.generate, an empty window is normal); an `error_response` still throws `AliExpressApiError`. Use a tolerant fixture (extra unknown fields) to prove `.passthrough()`.
- [ ] **Step 2: Run — FAIL**: `pnpm --filter @wanthat/aliexpress test`
- [ ] **Step 3: Implement.** Zod response schema modeled on `ProductDetailResponse` (`client.ts:71-99`): `aliexpress_affiliate_order_listbyindex_response.resp_result.result` with `orders.order: array(passthrough object)`, plus `min_query_index_id`/`max_query_index_id`/`next_query_index_id`-style cursor and `current_record_count` — **field names are integration-pending**: accept both `order_id` and `order_number` for the id, both `estimated_paid_commission` and `paid_commission`/`order_commission` for the commission (first non-empty wins), and read the cursor tolerantly; a malformed top-level payload throws `AliExpressApiError("malformed_result", ...)` (mirror productdetail). Business params include `tracking_id: this.options.trackingId`, `page_size: String(params.pageSize ?? 50)`.
- [ ] **Step 4: PASS + commit** `feat(aliexpress): order.listbyindex client with tolerant parsing`

### Task 2: Contracts — proxy poll contracts, writer contracts, config default 30

**Files:**
- Modify: `packages/contracts/src/retailer/proxy.ts` (add ListOrders wire types)
- Modify: `packages/contracts/src/conversion/order.ts` (fix stale comment; add write-request contracts)
- Modify: `packages/contracts/src/config/keys.ts` (`poller.intervalMinutes` default 60 → **30**)
- Test: `packages/contracts/src/conversion/order.test.ts` (create)

**Interfaces (produced; Tasks 4, 7 consume):**

```ts
// retailer/proxy.ts — the poll op's result the proxy answers (never-throw union, generateLink style)
export const PollOrdersSummary = z.object({
  status: z.literal("ok"),
  ran: z.boolean(),                       // false = heartbeat gated ("not_due")
  window: z.object({ startTime: z.string(), endTime: z.string() }).nullable(),
  fetched: z.number().int(),
  resolved: z.number().int(),
  untracked: z.number().int(),            // missing/foreign ref, unknown status
  written: z.object({ appended: z.number().int(), failed: z.number().int() }).nullable(), // null in dry mode
});
export const PollOrdersError = z.object({ status: z.literal("error"), code: z.enum(["retailer_not_configured", "upstream_error"]), message: z.string().optional() });
export const PollOrdersResponse = z.discriminatedUnion("status", [PollOrdersSummary, PollOrdersError]);

// conversion/order.ts — the proxy → writer invoke payload/response
export const ConversionWrite = z.object({
  resolved: ResolvedConversion,
  gross: Money,                            // retailer-reported commission (for the analytics event)
  consumer: ConsumerKind,                  // member | guest | none (event field; guest may still be unmapped)
});
export const WriteConversionsRequest = z.object({ conversions: z.array(ConversionWrite).min(1) });
export const WriteConversionsResponse = z.object({
  appended: z.array(z.object({ orderId: z.string(), kind: WalletEntryKind, status: WalletEntryStatus })),
  failed: z.array(z.object({ orderId: z.string(), error: z.string() })),
});
```

- [ ] **Step 1: Failing test** — `WriteConversionsRequest` round-trips a wire sample (string minor units → bigint), rejects an empty `conversions`, and `PollOrdersResponse` discriminates ok/error.
- [ ] **Step 2: FAIL**, then implement. In `order.ts`, also REPLACE the stale doc sentences claiming the writer "resolves sub → `customer` row (via its unique `cognito_sub`)" with: "the ledger is keyed by `cognito_sub` directly (ADR-0006 decision 4/ADR-0020) — `ConversionParty.sub` maps straight onto `wallet_entry.cognito_sub`; there is no customer table." In `keys.ts` change the `poller.intervalMinutes` default literal to `30` (decision 2026-07-10).
- [ ] **Step 3: PASS** (`pnpm --filter @wanthat/contracts test`), `pnpm build`, **commit** `feat(contracts): poll-orders + write-conversions contracts, poller interval default 30`

### Task 3: `poller_state` — DynamoDB table + repo

**Files:**
- Create: `packages/dynamo/src/poller-state.ts`
- Test: `packages/dynamo/src/poller-state.test.ts` (stub-doc style of `recommendation.test.ts:33-42`)
- Modify: `packages/dynamo/src/index.ts` (export), `infra/lib/data-stack.ts` (table), `infra/lib/edge-services-stack.ts` + its props + `infra/bin/wanthat.ts` (pass table, grant proxy R/W, env `POLLER_STATE_TABLE`)

**Interfaces (produced; Task 4 consumes):**

```ts
export const PollerStateItem = z.object({
  stateKey: z.string(),                 // "aliexpress#orders"
  lastRunAt: z.string(),                // ISO
  watermarkEndTime: z.string(),         // ISO (UTC; the proxy converts to GMT+8 at the edge)
});
export class PollerStateRepo {
  constructor(doc: DynamoDBDocumentClient, tableName: string);
  async get(stateKey: string): Promise<PollerStateItem | undefined>;
  async put(item: PollerStateItem): Promise<void>;   // full-item upsert (single writer: the proxy)
}
```

- [ ] **Step 1: Failing repo tests** (get parses/undefined; put validates + writes `Item` with `stateKey` PK).
- [ ] **Step 2: FAIL → implement** (model on `FxRateRepo`, `packages/dynamo/src/fx-rate.ts`). Table in `data-stack.ts` next to the others: PK `stateKey` (string), on-demand billing, `RemovalPolicy` matching the existing operational tables (copy `guest_attribution`'s settings).
- [ ] **Step 3: PASS + `pnpm synth` + commit** `feat(dynamo,infra): poller_state table + repo`

### Task 4: retailer-proxy — the poll op (dry)

**Files:**
- Create: `services/retailer-proxy/src/poll-orders.ts` (orchestration: gate → window → fetch → resolve → [invoke writer] → watermark)
- Create: `services/retailer-proxy/src/attribution.ts` (pure-ish resolution module)
- Test: `services/retailer-proxy/src/attribution.test.ts`, `services/retailer-proxy/src/poll-orders.test.ts`
- Modify: `services/retailer-proxy/src/handler.ts` (replace the `listOrders` stub; extend `getDeps`)
- Modify: `services/retailer-proxy/package.json` (no new deps expected — `@wanthat/dynamo` already present via ProductRepo)
- Modify: `infra/lib/edge-services-stack.ts`: proxy gains `recommendationTable.grantReadData`, `guestAttributionTable.grantReadData`, envs `RECOMMENDATION_TABLE`/`GUEST_ATTRIBUTION_TABLE`, timeout **300s** (batch polling; harmless to the sync generateLink path — API GW caps that caller at 30s).

**Interfaces:**
- Consumes: Task 1 `listOrdersByIndex`/`AliExpressOrder`, Task 2 contracts, Task 3 `PollerStateRepo`, `RecommendationRepo.get`, `GuestAttributionRepo.get`, `RuntimeConfigRepo.get("poller.intervalMinutes" | "poller.lookbackHours")`, `withAttribution`-era constants (param names `ref`/`c`/`g`).
- Produces:

```ts
// attribution.ts
export interface AttributionDeps { recommendations: Pick<RecommendationRepo, "get">; guests: Pick<GuestAttributionRepo, "get">; }
export type AttributionOutcome =
  | { outcome: "resolved"; write: ConversionWrite }
  | { outcome: "untracked"; reason: "no_ref" | "unknown_ref" | "no_commission" | "unknown_status" };
export async function resolveOrder(order: AliExpressOrder, deps: AttributionDeps): Promise<AttributionOutcome>;

// poll-orders.ts
export interface PollOrdersDeps { client: () => Promise<AliExpressClient | null>; state: PollerStateRepo; config: RuntimeConfigRepo; attribution: AttributionDeps; invokeWriter: ((req: WriteConversionsRequest) => Promise<WriteConversionsResponse>) | null; now: () => Date; sleep?: (ms: number) => Promise<void>; logger: Logger; }
export async function pollOrders(deps: PollOrdersDeps): Promise<PollOrdersResponse>;
export function toGmt8(date: Date): string;  // "yyyy-MM-dd HH:mm:ss" in UTC+8, exported for tests
```

- [ ] **Step 1: Failing attribution tests** — `custom_parameters` JSON `{"ref":"...","c":"..."}` → member `ConversionWrite` (referrer = rec.ownerId + snapshot split via `splitCommission(grossMinor, referrerBps, consumerBps)`; consumer party = `{sub: c, reward: consumerMinor}`); `{"ref","g"}` with mapped guest → consumer = mapped sub, `consumer: "guest"`; unmapped `g` → `consumer: null` party, kind `"guest"` on the event field; `ref` only → consumer null, `"none"`; no/foreign ref → untracked (`no_ref`/`unknown_ref`); null commission → `no_commission`; status mapping `Payment Completed→pending`, `Completed`/`Buyer Confirmed Goods Receipt`/`Finished→confirmed`, `Invalid`/`Order Rejected→clawback` (case-insensitive contains; anything else → `unknown_status`). `custom_parameters` may arrive as a JSON string or already-decoded object — accept both; consumer reward of 0 minor units → consumer party null (nothing to credit).
- [ ] **Step 2: FAIL → implement `attribution.ts`.** `ResolvedConversion.occurredAt` = `order.orderTimeGmt8` converted to ISO when parseable, else `now` — keep a `parseGmt8(s): string | null` helper.
- [ ] **Step 3: Failing poll-orders tests** — not-due gate (lastRunAt 10 min ago, interval 30 → `{ran:false}` and NO client build); due run pages the cursor to exhaustion sequentially; window = `[watermarkEndTime − 1h overlap, now]` clamped to `[now − lookbackHours, now]`, formatted via `toGmt8` (test the formatter against fixed instants — e.g. `2026-07-10T00:00:00Z → "2026-07-10 08:00:00"`); first run (no state item) uses the full lookback; `ApiCallLimit` mid-page → one retry after sleep; a thrown page aborts with `status:"error"` and does NOT `state.put`; success `put`s `{lastRunAt: now, watermarkEndTime: now}`; **dry mode** (`invokeWriter: null`) → `written: null`, resolved conversions logged one line each (`logger.info("dry_resolved", {...})`); with a writer, batches of ≤25 `ConversionWrite`s are passed and the summary aggregates appended/failed.
- [ ] **Step 4: FAIL → implement `poll-orders.ts`**, then wire `handler.ts`: the `listOrders` case calls `pollOrders` with deps built in `getDeps()` (extend the cached deps object with `state`, `recommendations`, `guests`, and `invokeWriter` = `process.env.CONVERSION_WRITER_FUNCTION ? lambdaInvoke(...) : null` — the invoke helper mirrors `services/app-links/src/links/proxy-client.ts` with `WriteConversionsResponse.parse`, serializing the request with the bigint→string replacer). Drop `startTime`/`endTime`/`status` from the `listOrders` event variant (the op computes its own window): the event becomes `{ op: "listOrders"; retailer: "aliexpress" }`.
- [ ] **Step 5: infra edits** (grants/envs/timeout above), `pnpm synth`.
- [ ] **Step 6: Full gate + PR A**

```bash
npx biome check --write . && pnpm lint && pnpm turbo typecheck --force && pnpm test && pnpm synth
# open PR A (ready): "feat(retailer-proxy): scheduled order ingestion, dry mode (PR A)"
```

Post-merge dev check: `aws lambda invoke --function-name wanthat-dev-retailer-proxy --payload '{"op":"listOrders","retailer":"aliexpress"}' /dev/stdout` → `{"status":"ok","ran":true,...}` (or `ran:false` twice in a row — the gate works). No schedule exists yet; manual invokes only.

---

## PR B — money writes

### Task 5: `packages/db` — append helpers

**Files:**
- Create: `packages/db/src/conversion-writer.ts`
- Test: extend the testcontainers harness — create `packages/db/src/conversion-writer.test.ts` importing the same helpers `migrations.test.ts` uses (reuse its container setup util; if it's inline, extract a shared `startTestDb()` into `packages/db/src/test-harness.ts` as part of this task)
- Modify: `packages/db/src/index.ts` (exports)

**Interfaces (produced; Task 6 consumes):**

```ts
export interface WalletEntryInsert {
  cognitoSub: string; kind: WalletEntryTable["kind"]; amountMinor: bigint; currency: string;
  orderId: string; recommendationId: string; status: "pending" | "confirmed" | "clawback";
}
/** INSERT ... ON CONFLICT DO NOTHING; returns true when a row was actually inserted. */
export async function appendWalletEntry(db: Kysely<Database>, entry: WalletEntryInsert): Promise<boolean>;
/** audit_append(payload, now()) via sql template — the ONLY way rows enter audit_log. */
export async function appendAudit(db: Kysely<Database>, payload: unknown): Promise<void>;
```

- [ ] **Step 1: Failing container tests** — insert as `poller_writer`-shaped rows: same `(orderId, kind, status)` twice → first true, second false, exactly one row; status advance (pending then confirmed) → two rows; `appendAudit` chains `prev_hash → entry_hash` (insert two, assert `rows[1].prev_hash === rows[0].entry_hash`). Run migrations first via the existing `createMigrator` harness.
- [ ] **Step 2: FAIL → implement** (`db.insertInto("wallet_entry").values({...}).onConflict((oc) => oc.doNothing()).returning("id").executeTakeFirst()` → truthy = inserted; `sql\`select audit_append(${JSON.stringify(payload)}::jsonb, now())\`.execute(db)`).
- [ ] **Step 3: PASS** (`pnpm --filter @wanthat/db test`; if Docker is unavailable locally, mark the expectation "CI green is the gate" in the PR) **+ commit**.

### Task 6: conversion-poller — the in-VPC writer

**Files:**
- Rewrite: `services/conversion-poller/src/handler.ts`
- Create: `services/conversion-poller/src/writer.ts` + `services/conversion-poller/src/writer.test.ts`
- Create: `services/conversion-poller/src/context.ts` (createDb as `poller_writer` — mirror `services/app-core/src/context.ts` exactly, plus a `RecommendationRepo` over `RECOMMENDATION_TABLE` via the gateway endpoint)
- Modify: `services/conversion-poller/package.json` (add `@wanthat/dynamo`)
- Modify: `packages/dynamo/src/recommendation.ts` (+ test): add

```ts
/** Fire-and-forget stat: ADD conversions 1 (existence-conditional; missing rec no-ops). */
async incrementConversions(recommendationId: string): Promise<void>
```

(UpdateCommand `ADD conversions :one` with `ConditionExpression: "attribute_exists(recommendationId)"`, swallow `ConditionalCheckFailedException`.)

**Interfaces:**
- Consumes: Task 2 `WriteConversionsRequest/Response`, Task 5 helpers, `ConversionEvent` contract.
- Produces: Lambda handler: parses `WriteConversionsRequest` (Money strings → bigint via the schema), per `ConversionWrite`:
  1. rows = referrer entry (`kind: "referrer_cashback"`, `amountMinor: resolved.referrer.reward.amountMinor`, sub = `resolved.referrer.sub`) + consumer entry when `resolved.consumer` non-null (`kind: "consumer_reward"`), both `orderId`/`recommendationId`/`status` from `resolved`.
  2. `appendWalletEntry` each; for each **true** return, `appendAudit({type:"wallet_entry", ...entry})`.
  3. If any row in this conversion was new: emit ONE `ConversionEvent` line — `console.log(JSON.stringify(ConversionEvent.parse({type:"conversion", orderId, recommendationId, consumer, amount: gross, status, at: new Date().toISOString()}), bigintReplacer))` (the log-group subscription filter ships it; `amount` serializes via the replacer).
  4. First-sight pending (a NEW `referrer_cashback`+`pending` row): `recommendations.incrementConversions(recommendationId)` — best-effort try/catch.
  5. try/catch per conversion → `failed: [{orderId, error}]`, never poisons the batch.
- [ ] **Step 1: Failing writer tests** (fake db helpers + repos): batch of member+guest conversions → appended list matches; duplicate batch (helpers return false) → `appended: []`, no audit, no event, no counter; consumer-null conversion → single row; one conversion throwing → appears in `failed`, others unaffected; event emitted once per conversion with `amount` as decimal string in the logged JSON.
- [ ] **Step 2: FAIL → implement.** Handler doc comment: keep/refresh the existing ADR trail (`handler.ts:1-17`).
- [ ] **Step 3: PASS + commit.**

### Task 7: Infra — writer in-VPC, heartbeat schedule (dev only)

**Files:**
- Modify: `infra/lib/api-stack.ts` (create the poller fn here, mirroring the app-core block at L130-159): VPC `PRIVATE_ISOLATED` + `lambdaSg`, memory 256, **timeout 90s**, `reservedConcurrentExecutions: 1`, env `DB_HOST/DB_NAME/DB_USER=poller_writer/DB_CA_CERT` (copy app-core's), `RECOMMENDATION_TABLE` + `recommendationTable.grantReadWriteData` (counter), `cluster.grantConnect(fn, "poller_writer")`; expose `readonly conversionPollerFn`.
- Modify: `infra/lib/edge-services-stack.ts`: DELETE the old poller fn + its disabled schedule + its grants; proxy gains `CONVERSION_WRITER_FUNCTION` env + `lambda:InvokeFunction` grant on the writer (new prop `conversionWriterFn: lambda.IFunction`); add the heartbeat schedule on the **proxy**: `addSchedule("OrderPollHeartbeat", retailerProxy, "rate(15 minutes)", wanthatEnv.name === "dev")` with static input `{"op":"listOrders","retailer":"aliexpress"}` — extend the `addSchedule` helper (L138-154) with an optional `input?: string` passed to the schedule Target.
- Modify: `infra/bin/wanthat.ts`: pass `api.conversionPollerFn` into EdgeServicesStack; update `functions:`/`funnelLogGroups:` references in the ObservabilityStack block from `edgeServices.conversionPollerFn` to `api.conversionPollerFn` (the funnel subscription follows the fn's log group).
- Cross-stack ordering note: the writer moves producer stacks (edge-services → api). Since edge-services consumed nothing from the old fn, no export-removal dance is needed; `pnpm diff` must show the old fn+schedule deleted and the new fn created (a rename/replace, no data at stake).

- [ ] **Step 1:** Apply, `pnpm synth`, inspect the api template for the fn (VPC config, reserved concurrency, DB_USER) and the edge-services template for the schedule (`State: ENABLED` on dev synth, `Input` JSON) — `WANTHAT_ENV=prod pnpm synth` (or the repo's prod-synth path) must show `DISABLED`.
- [ ] **Step 2: Full gate + PR B** (same gate command as Task 4 Step 6). PR body must carry the dev validation script: manually invoke the proxy op once; confirm in CloudWatch the writer appended (or `fetched: 0` for an empty window); after your real AliExpress order lands: rerun → `wallet_entry` rows exist (check via `/admin` activity or a psql query), Athena `SELECT * FROM wanthat_dev_analytics.funnel_events WHERE type='conversion'` shows the event, and the recommendation card's conversions count ticked.

---

## PR C — wallet reads

### Task 8: Balance derivation (pure) + db reads

**Files:**
- Create: `packages/domain/src/wallet.ts` (+ export from `packages/domain/src/index.ts` if the repo pattern is a single barrel — otherwise keep `index.ts` re-exporting)
- Test: `packages/domain/src/wallet.test.ts`
- Create: `packages/db/src/wallet.ts` + `packages/db/src/wallet.test.ts` (testcontainers, reuse Task 5 harness)
- Modify: `packages/db/src/index.ts`

**Interfaces:**

```ts
// domain/wallet.ts — pure derivation per the WalletBalance contract (balance.ts:11-19)
export interface LedgerRow { kind: WalletEntryKind; amountMinor: bigint; currency: string; orderId: string | null; status: "pending"|"confirmed"|"clawback"; }
export function deriveBalances(rows: LedgerRow[]): WalletBalance[];
// per (orderId, kind) reward: furthest status wins (clawback > confirmed > pending; clawback → 0)
// asRecommender = referrer_cashback sums; asBuyer = consumer_reward sums (confirmed + pending each)
// available = confirmed rewards + adjustments − withdrawals, per currency

// db/wallet.ts
export async function listEntriesForSub(db: Kysely<Database>, sub: string): Promise<LedgerRow[]>; // bounded MVP volumes; SQL aggregation is a future optimization
export interface WalletHistoryPage { items: Array<{ id: string; kind: ...; amountMinor: bigint; currency: string; recommendationId: string | null; status: ...; createdAt: Date }>; nextCursor: { createdAt: Date; id: string } | null; }
export async function listWalletHistory(db: Kysely<Database>, sub: string, limit: number, cursor?: { createdAt: Date; id: string }): Promise<WalletHistoryPage>; // ORDER BY created_at DESC, id DESC keyset pagination (activity.ts precedent)
```

- [ ] **Step 1: Failing `deriveBalances` tests** — pending only; pending+confirmed rows for one order count once as confirmed; clawback zeroes a previously confirmed reward; withdrawal subtracts from available; adjustment adds; two currencies → two `WalletBalance` entries; empty → `[]`.
- [ ] **Step 2: FAIL → implement** (exact bigint math; status rank map `{pending:0, confirmed:1, clawback:2}`).
- [ ] **Step 3: db read tests** (containers): history keyset pagination across a 3-row fixture with equal timestamps (id tiebreak); `listEntriesForSub` filters by sub.
- [ ] **Step 4: PASS + commit.**

### Task 9: app-core — real wallet endpoints + FX estimate

**Files:**
- Modify: `services/app-core/src/wallet/router.ts` (fill both handlers), `services/app-core/src/context.ts` (add `fx: FxRateRepo`, `config: RuntimeConfigRepo` via `getDocClient` + envs `FX_RATE_TABLE`/`RUNTIME_CONFIG_TABLE`), `services/app-core/package.json` (add `@wanthat/dynamo`, `@wanthat/domain`)
- Modify: `infra/lib/api-stack.ts` (app-core: the two envs + `fxRateTable.grantReadData` — table already a prop; `runtimeConfigTable.grantReadData` if not present)
- Modify: `infra/package.json` devDependencies if `@wanthat/domain`/`@wanthat/dynamo` missing (they are present — verify)
- Test: `services/app-core/src/wallet/router.test.ts` (extend, existing vi.mock context pattern)

**Interfaces:**
- Consumes: Task 8 functions, `convertMinor`, contracts `GetWalletResponse`/`WalletEstimate`.
- Produces: `GET /wallet` = `deriveBalances(await listEntriesForSub(db, sub))` + `estimated`: for the USD balance with a cached `fx.get("USD","ILS")` rate → `{available: convertMinor(availableUsd, rate, commissionBps), pending: convertMinor(pendingTotal, rate, commissionBps)}` in ILS (commission from `fx.conversionCommissionBps` config); no rate or no USD balance → `estimated: null` (the SPA already handles it). Pending total = asRecommender.pending + asBuyer.pending. `GET /wallet/entries` = `listWalletHistory` mapped to `WalletEntry` wire (cursor base64url-encoded `{createdAt, id}` — reuse the `cursorOf`/`keyOf` pattern from `services/app-links/src/links/router.ts:145-158`).
- [ ] **Step 1: Failing router tests** — seeded fake rows → correct `balances` + ILS estimate figures (compute expected via `convertMinor` by hand in the test); no fx rate → `estimated: null`; entries pagination returns `nextCursor` then terminates; 401 without claims.
- [ ] **Step 2: FAIL → implement.** **Step 3: PASS.**
- [ ] **Step 4: Full gate + PR C.** Post-merge (Dennis, dev): wallet page shows the credited pending amount with `≈₪` estimate; activity rows appear; after AliExpress confirms the order, the next poll advances it and the wallet moves pending → confirmed/available.

---

## Self-review notes (already applied)

- No new migration: `poller_writer` grants, unique idempotency index, and `audit_append` all shipped in 0001–0006; the watermark lives in DynamoDB (`poller_state`), not Aurora.
- Timeout nesting: proxy 300s > writer 90s > pool connect 60s (Aurora scale-to-zero resume).
- The writer emits ONE `ConversionEvent` per conversion-with-new-rows (not per party row) — Athena counts orders, not ledger rows.
- `listOrders` event variant loses its window params (the op computes its own window from config + watermark) — update `RetailerProxyEvent` and any test fixtures using the old shape.
- The funnel subscription filter targets the poller **log group**, which moves stacks with the fn — `wanthat.ts`'s `funnelLogGroups` reference must follow (Task 7), else the conversion events silently stop flowing.
- Dev-only enablement: schedule `State` derives from `wanthatEnv.name === "dev"`; prod synth shows DISABLED (Task 7 Step 1 verifies both).
