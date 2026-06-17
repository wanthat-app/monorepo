# ADR 0002 — Conversion ingestion via a scheduled order-report poller

- **Status:** Accepted
- **Date:** 2026-06-17
- **Context refs:** Solution Design Document §6, §8.1, §9.2, §9.4, §10.1, §13, §17; AWS Architecture (MVP) §3.3
- **Supersedes framing in:** SDD's `conversion-webhook` (push/postback) component

## Context

The SDD is internally inconsistent on how AliExpress conversions arrive: §6/§9.4 model a
public `conversion-webhook` Lambda *receiving a postback* (push), while §8.1/§9.2 describe
reading the *"Live Order report"* (pull).

Verification against the AliExpress / Alibaba Open Platform docs
([apiId=52650](https://developer.alibaba.com/docs/api.htm?apiId=52650);
[wecantrack](https://wecantrack.com/aliexpress-integration/)) found:

- Both a **postback/S2S** path and a **pull Affiliate API** exist, but they are **not**
  equivalent — the pull API carries *"the richest transaction detail (product category,
  SubID, commission tier)"*, while postback/S2S *"fire per-conversion only"* with less detail.
- The order-query method is **`aliexpress.affiliate.order.listbyindex`**:
  - **Time-window based** — `start_time` + `end_time` **required**, format
    `yyyy-MM-dd HH:mm:ss`, **timezone GMT+8** (not UTC).
  - **Cursor pagination** via `start_query_index_id` (returns `max/min_query_index_id`);
    **not** page numbers.
  - Filterable by `status` (`Payment Completed`, `Buyer Confirmed Receipt`, …).
  - Response per order includes `order_id`/`sub_order_id`, `order_status`,
    `estimated_paid_commission` / `estimated_finished_commission`, `settled_currency`,
    **`custom_parameters` (JSON — carries our injected SubID / per-click values)**,
    `paid_time` / `finished_time`.
  - You do **not** supply order ids to list; `order_id` comes back in the response.
    (`aliexpress.affiliate.order.get` exists for targeted re-fetches by `order_ids`.)

The pending→confirmed→rejected lifecycle (§10.1) is inherently reconciliation-shaped
(orders mature over the 3-day window and can later be rejected), which is a re-read-the-window
pattern — a poll, not a one-shot push. The data Wanthat's crediting needs (SubID, commission,
currency) lives in the pull API.

## Decision

Ingest conversions with a **scheduled reconciliation poller**, not a webhook:

`EventBridge Scheduler → poller Lambda → aliexpress.affiliate.order.listbyindex (cursor loop)
→ upsert conversion (idempotent on order_id/order_ref) → drive pending→confirmed→rejected
→ ledger + audit`.

- **Scheduler period is configurable** (env/SSM-driven CDK parameter; e.g. default hourly,
  tunable per environment) — *not* hardcoded.
- Query the **new `api-sg.aliexpress.com/sync` gateway with HMAC-SHA256**, consistent with
  the SDD Appendix A link-generation decision — **not** the legacy `gw.api.taobao.com` MD5
  gateway.
- Window = `[watermark − overlap, now]` computed in **GMT+8**; re-read overlapping windows so
  status transitions are captured. Idempotent upsert by `order_id` makes re-reads safe.
- Persist a **cursor/watermark** as small state (Postgres row / DynamoDB item / SSM param).
- Map status → ledger: `Payment Completed` → `commission_pending`
  (`estimated_paid_commission`); `Buyer Confirmed Receipt`/finished → `commission_confirmed`
  (`estimated_finished_commission`); invalid/rejected → `clawback`.
- No public conversion endpoint → smaller attack surface (no inbound signature/WAF for it).

## Consequences

- The §13 "webhook processing lag" metric becomes **"poll lag / reconciliation gap"**.
- Credit latency is bounded by the poll period (acceptable: the 3-day window dwarfs it).
- Infra shape: EventBridge Scheduler + outbound-only Lambda + watermark store — *no* API
  Gateway route, signature scheme, or WAF for conversions.
- `custom_parameters` is the attribution channel — see the consumer-attribution lookup design
  (forthcoming ADR) for packing both `short_id` (referrer) and `click_id` (consumer) into it.

## To confirm at integration (API access pending — SDD §17 risk)

- Full `status` enum, including the rejected/invalid state used for clawbacks.
- That `custom_parameters` reliably round-trips the **per-click** value on the `api-sg` gateway
  (SDD §10.1 already hedges this with "measure, don't mitigate").

## Optional later

Accept a postback/S2S as a low-latency *hint* that triggers an early pull, with the poll
remaining the source of truth. Not in MVP.
