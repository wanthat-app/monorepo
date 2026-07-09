# Conversion poller + wallet update — order ingestion, ledger credit, real balances

**Date:** 2026-07-10
**Status:** Approved (design review with Dennis, 2026-07-09/10)
**Slice:** implements ADR-0009 (scheduled `order.listbyindex` conversion ingestion) and fills the
wallet read path (app-core aggregation + SPA balances). Dev only — the prod schedule stays
disabled.

## Context

- The landing/attribution slice shipped 2026-07-09: clicks now reach AliExpress with
  `ref` (recommendationId) + `c` (member sub) / `g` (guestId) appended
  (`withAttribution`, ADR-0008), and the funnel analytics pipeline (CloudWatch Logs
  subscription -> Firehose -> S3 -> Athena) is live, already subscribed to the
  conversion-poller log group with a `$.type` filter.
- `services/conversion-poller` is a stub; `services/retailer-proxy` has a stubbed
  `listOrders` op in its event union; `packages/aliexpress` has the signed `call()`
  primitive and an unused `OrderListByIndexParams` interface but no order client.
- Aurora is money-only (ADR-0006/0020): `wallet_entry` keyed by `cognito_sub` with the
  unique idempotency index `(order_id, kind, status)`, `audit_log` + `audit_append`
  (hash chain, SECURITY DEFINER), and the `poller_writer` role (SELECT+INSERT on
  wallet_entry, EXECUTE audit_append) — all shipped in migrations 0001–0006. No new
  roles are needed (and migrations cannot create roles).
- app-core serves `GET /wallet` / `GET /wallet/entries` as fixed-empty stubs; the SPA
  HomePage (BalanceCard/ActivityRow) is fully wired to the final wire contracts.
- Governing decisions: ADR-0002 (poller-writer is the sole money writer, in-VPC,
  append-only, DB-enforced), ADR-0003 (proxy reads guest_attribution at conversion),
  ADR-0009 (poller design), ADR-0017 (hold settlement currency, convert at display/
  withdrawal), ADR-0021 (interim throttling; this slice is its named revisit trigger).

## 1. Topology

**EventBridge Scheduler -> retailer-proxy (`op: "listOrders"`) -> in-VPC
conversion-poller-writer -> Aurora.**

This is the ADR-0009 chain, and also the only workable one: the VPC is endpoint-free
(the Lambda interface endpoint was removed in PR #111), so an in-VPC function cannot
invoke other Lambdas — the non-VPC proxy must be the orchestrator and invoke the
in-VPC writer, mirroring the existing `RetailerProxyClient` invoke pattern in reverse.

- **retailer-proxy** (non-VPC, sole retailer egress, holds the credential) orchestrates:
  watermark + heartbeat gate (§2), GMT+8 window computation (`poller.lookbackHours`
  runtime config, default 72), sequential `order.listbyindex` paging with the ADR-0021
  throttle (one ~1.2s ban-window retry on `ApiCallLimit`), attribution resolution (§3),
  writer invocation, watermark advance.
- **conversion-poller** (existing service) becomes the **in-VPC poller-writer**
  (ADR-0002): moves from edge-services-stack (non-VPC by charter) to api-stack (in-VPC
  siblings), connects via IAM auth as `poller_writer`, reserved concurrency 1
  (serializes runs, caps Aurora connections). It is invoked by the proxy, not scheduled.

## 2. Schedule + admin-tunable interval (heartbeat gate)

- The EventBridge schedule fires a **fixed 15-minute heartbeat** targeting the
  retailer-proxy with static input `{"op":"listOrders","retailer":"aliexpress"}`.
  **Enabled on dev only; prod stays disabled** (flagged in CDK by env).
- The poll op **gates itself**: it reads `poller.intervalMinutes` from runtime config —
  **default changes 60 -> 30** — and no-ops (`{status:"ok", skipped:"not_due"}`) unless
  `now - lastRunAt >= interval`. Admins tune the cadence in the existing runtime-config
  panel; changes take effect within <=15 minutes.
- This satisfies ADR-0009's CONFIG-driven interval with a different apply mechanism
  than the ADR sketch (self-gating instead of admin-api calling
  `scheduler:UpdateSchedule`, which an in-VPC admin-api cannot reach). Deferred
  execution detail, not a decision change; revisit only if a sub-15-minute cadence is
  ever needed.

## 3. Poll run (retailer-proxy)

1. **Gate:** read `poller_state` (new DynamoDB table, PK `stateKey`, item
   `aliexpress#orders`: `lastRunAt`, `watermarkEndTime`); skip if not due (§2).
2. **Window:** `[watermarkEndTime - overlap, now]` clamped to
   `[now - lookbackHours, now]`, formatted `yyyy-MM-dd HH:mm:ss` in **GMT+8**
   (the API's clock, ADR-0009). First run ever: `[now - lookbackHours, now]`.
   Re-reading overlap is safe — the ledger no-ops duplicates.
3. **Fetch:** page `aliexpress.affiliate.order.listbyindex` via a new
   `AliExpressClient.listOrdersByIndex(params)` (uses the existing signed `call()`;
   consumes the until-now-unused `OrderListByIndexParams`; cursor
   `start_query_index_id`). Tolerant Zod response schema; the exact field names /
   full status enum are integration-verified (ADR-0009 explicitly flags them) —
   unknown statuses are logged and skipped, never crash a run.
4. **Resolve attribution** per order from round-tripped `custom_parameters`:
   `ref` -> `RecommendationRepo.get` -> referrer sub (`ownerId`) + the **snapshotted**
   `cashback` split; `c` -> member consumer sub; else `g` ->
   `GuestAttributionRepo.get(g)` -> sub if mapped. Outcomes: consumer = member sub |
   mapped guest sub | null (unmapped guest / no key). A missing/foreign `ref`
   (e.g. another env's order on the shared account) -> **untracked**: excluded from
   money, counted in the run summary. This also naturally isolates envs until the
   planned env marker on redirect params (deferred; needed when prod goes live).
5. **Map status:** `Payment Completed` -> `pending`; buyer-confirmed/finished ->
   `confirmed`; invalid/rejected -> `clawback`.
6. **Hand off:** build `ResolvedConversion[]` (existing contract; its stale "resolves
   sub -> customer row" doc comment is corrected — the ledger keys by `cognito_sub`
   directly) plus the gross commission per order for the analytics event, and invoke
   the writer in batches. On writer success, advance `watermarkEndTime` and
   `lastRunAt`; on any thrown failure, advance **nothing** (next run re-reads the
   window; idempotency absorbs it).

## 4. Ledger write (conversion-poller-writer, in-VPC)

Per `ResolvedConversion`, per party — `referrer_cashback` for the referrer, and
`consumer_reward` when `consumer` is non-null:

- Amounts: `splitCommission(grossCommissionMinor, referrerBps, consumerBps)` from the
  recommendation's **snapshot** (never live config), credited in **USD minor units**
  (settlement currency; ILS conversion only at display/withdrawal — ADR-0017,
  zero FX float).
- `INSERT ... ON CONFLICT DO NOTHING` against the unique `(order_id, kind, status)`
  index: re-reads no-op; a status advance is a **new immutable row** (append-only —
  the Kysely types already forbid UPDATE).
- Every **newly inserted** row: `audit_append(payload)` (hash chain). Additionally,
  **one** `ConversionEvent` `console.log` line per conversion whose status produced at
  least one new row (`{type:"conversion", orderId, recommendationId,
  consumer: member|guest|none, amount: gross Money, status, at}` — per order+status,
  not per party row) — the Firehose subscription on this log group ships it to Athena
  automatically.
- **Conversions counter:** on a first-sight order (new `pending` referrer row), the
  writer increments the recommendation's `conversions` attribute (DynamoDB UpdateItem
  ADD). Clicks counter stays 0 (deferred). The writer reaches DynamoDB via a **gateway
  endpoint** (free; added to the VPC if absent — consistent with the NAT-free /
  no-paid-endpoints rule, ADR-0004).
- Response to the proxy: `{appended: [{orderId, kind, status}], failed: [...]}` —
  per-conversion try/catch so one bad order never poisons a batch; failures are
  reported in the run summary and retried naturally on the next overlapping window.

## 5. Wallet reads (packages/db + app-core + SPA)

- New `packages/db/src/wallet.ts`:
  - **Derived balance** per `WalletBalance` contract: for each order-keyed reward
    `(order_id, kind)` take the furthest-advanced status (clawback > confirmed >
    pending; clawback contributes 0); group per currency into
    `asRecommender`/`asBuyer` `{confirmed, pending}`;
    `available = sum(confirmed rewards) + adjustments - withdrawals`. All
    `WHERE cognito_sub = :sub`, exact bigint math.
  - **History**: `wallet_entry` newest-first, cursor-paginated on `(created_at, id)`,
    mapped to the `WalletEntry` contract.
- **app-core** replaces its stubs: `GET /wallet` -> balances + `estimated`
  (`convertMinor` with the cached USD->ILS `fx_rate` and `fx.conversionCommissionBps`;
  `estimated: null` when no rate is cached), `GET /wallet/entries` -> history page.
  app-core gains `FX_RATE_TABLE`/`RUNTIME_CONFIG_TABLE` env + read grants, reachable
  through the same DynamoDB gateway endpoint.
- **SPA**: no data-shape changes (HomePage/BalanceCard/ActivityRow already consume the
  final wire contracts); verification against a really-credited wallet only.

## 6. Infra summary

- Move the conversion-poller fn to api-stack: VPC (`PRIVATE_ISOLATED`, `lambdaSg`),
  `DB_USER=poller_writer`, `cluster.grantConnect`, RDS CA bundle env (mirror app-core),
  reserved concurrency 1, recommendation-table **write** grant (counter).
- retailer-proxy gains: recommendation + guest_attribution **read** grants,
  `poller_state` **read/write** grant, `lambda:InvokeFunction` on the writer,
  `CONVERSION_WRITER_FUNCTION` env (unset in PR A = dry mode).
- New DynamoDB table `poller_state` (data-stack, PK `stateKey`, on-demand).
- DynamoDB **gateway endpoint** in the VPC if absent (free).
- Scheduler: remove the poller's disabled schedule; add the proxy heartbeat
  `rate(15 minutes)`, static input, **enabled only when env == dev**.
- Cross-stack order respected: api-stack (writer) exists before edge-services (proxy)
  in `wanthat.ts`; Observability's funnel subscription already covers the writer's log
  group (it moves stacks — the log-group reference in `funnelLogGroups` follows the fn).
- ASCII-only descriptions, no parentheses, as always.

## 7. Error handling summary

| Failure | Behavior |
|---|---|
| `ApiCallLimit` mid-page | one ban-window retry (ADR-0021); still throttled -> abort run, watermark untouched |
| Unknown order status | log + skip the order; counted in run summary |
| Missing/foreign `ref` | untracked: no money, run-summary count (env isolation until the env marker ships) |
| Unmapped `g` | reward the referrer only; consumer null (`ConsumerKind: "none"` in the event... see note) |
| Writer batch partially fails | per-conversion isolation; failed orders retried on next overlapping window |
| Any thrown proxy failure | no watermark advance; overlapping re-read is idempotent |
| Aurora scale-to-zero resume | `waitForDb`/60s connect timeout (existing pool behavior); writer fn timeout 90s |

Timeout nesting: the proxy synchronously awaits the writer, so its own timeout must
exceed the writer's — proxy 15s -> **300s** (harmless to the sync `generateLink` path,
which stays bounded by the caller's API Gateway 30s), writer 15s -> **90s** (one Aurora
scale-to-zero resume + a batch of inserts).

Note on the event's `consumer` field: `member` when `c` resolved, `guest` when `g` was
present (mapped or not), `none` when no consumer key round-tripped.

## 8. Testing

- **aliexpress**: `listOrdersByIndex` request signing/paging + tolerant response parse
  (fixtures incl. unknown status, missing custom_parameters).
- **proxy**: heartbeat gate (due/not-due), GMT+8 window math incl. first run + clamp,
  attribution matrix (member / mapped guest / unmapped guest / no key / foreign ref),
  throttle retry, watermark advance only on success, dry mode.
- **writer**: idempotent append (same batch twice -> 0 new rows), status-advance rows,
  audit_append per new row, ConversionEvent emission shape, counter increment only on
  first-sight pending, per-conversion failure isolation.
- **db/app-core**: balance derivation (pending->confirmed advance, clawback supersedes,
  withdrawal subtraction, multi-currency), history pagination, FX estimate + null-rate
  fallback. Migration test via existing testcontainers harness (CI has Docker).
- **e2e (Dennis, dev)**: place a real attributed order through the recreated link ->
  poller run credits pending -> wallet shows it; this also confirms the ADR-0008
  `custom_parameters` round-trip (open integration question until then).

## 9. PR slicing (each deployable, opened ready)

- **PR A — order ingestion, dry:** aliexpress client + response schema, `ListOrders`
  proxy contracts, attribution module, `poller_state` + watermark + heartbeat gate,
  `poller.intervalMinutes` default 60 -> 30, `order.ts` doc-comment fix. Writer invoke
  behind unset env -> logs resolved conversions only; manually invocable on dev.
- **PR B — money:** writer in-VPC (api-stack move, poller_writer, reserved concurrency,
  gateway endpoint), append + audit + ConversionEvent + conversions counter,
  proxy -> writer invoke, heartbeat schedule enabled on dev.
- **PR C — wallet reads:** packages/db wallet queries, real app-core endpoints + FX
  estimate, SPA verification.

## 10. Deferred (explicitly out of scope, unchanged decisions)

- Withdrawal/payout flow (`withdrawal` kind exists; no endpoint).
- Clicks counter (resolve-path concern, later slice).
- Env marker on redirect `custom_parameters` (needed when prod goes live; foreign-ref
  untracking isolates envs until then).
- Prod schedule enablement.
- Admin `scheduler:UpdateSchedule` mechanism (heartbeat gate covers tunability).
- A real cross-invoke rate limiter (ADR-0021 revisit stands; this slice reuses the
  interim pattern).
