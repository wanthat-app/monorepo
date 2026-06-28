# ADR 0009 — Conversion ingestion: scheduled reconciliation poller

- **Status:** Accepted
- **Date:** 2026-06-28
- **Related:** [ADR-0002](0002-app-compute-topology.md) (fetcher/writer split), [ADR-0004](0004-network-topology-nat-free-egress.md) (egress), [ADR-0008](0008-consumer-attribution-model.md) (attribution resolved here)

## Context

AliExpress conversions can be ingested two ways: a **postback/S2S push** per conversion, or a
**pull of the Affiliate API**. They are not equivalent — the pull API carries the richest
transaction detail (product category, SubID via `custom_parameters`, commission tier, settled
currency), while postbacks fire per-conversion with less detail. The crediting lifecycle is
**pending → confirmed → rejected**: orders mature over a ~3-day window and can later be rejected,
which is inherently a re-read-the-window reconciliation — a poll, not a one-shot push. The data
we need to credit (SubID, commission, currency) lives in the pull API.

## Decision

Ingest conversions with a **scheduled reconciliation poller**:

`EventBridge Scheduler → fetch via aliexpress.affiliate.order.listbyindex → append to the
event-log ledger keyed (order_id, kind, status) → derive balance + audit.`

- Query the **`api-sg.aliexpress.com/sync` gateway with HMAC-SHA256** (not the legacy MD5
  gateway). `order.listbyindex` is **time-window based** (`start_time`/`end_time`, format
  `yyyy-MM-dd HH:mm:ss`, **GMT+8**), **cursor-paginated** (`start_query_index_id`), filterable by
  `status`.
- **Scheduler period is configurable** (env/SSM-driven; default hourly, tunable per environment).
- Window = `[watermark − overlap, now]` in GMT+8; re-read overlapping windows so status
  transitions are captured. The ledger is an **append-only event log** keyed `(order_id, kind,
  status)`: a reward advances `pending → confirmed → clawback` as **separate immutable rows**, while
  a re-read of an unchanged order no-ops (the row already exists). The balance is **derived** (take
  each reward's furthest-advanced status). Persist a **watermark/cursor**.
- Status → ledger event: `Payment Completed` → a `pending` row; `Buyer Confirmed Receipt` /
  finished → a `confirmed` row; invalid/rejected → a `clawback` (terminal, contributes 0). Entry
  `kind` ∈ `referrer_cashback` / `consumer_reward` / `adjustment` / `withdrawal` (a withdrawal is a
  negative standalone event with `order_id` null; the payout flow itself is deferred).
- **Cashback amounts** = the **recommendation's snapshotted split rates** (referrer/consumer bps,
  locked at link creation — ADR-0008) applied to the retailer's reported commission, and are
  credited in the retailer's **settlement currency** (USD for AliExpress): the wallet is held in
  that currency and converted to ILS only at withdrawal, not at credit — so our liability matches
  our receivable (zero FX float).
- Realised as `EventBridge → Retailer Proxy.listOrders` (makes the IPv4-only retailer call,
  resolves attribution from `custom_parameters` — `ref` → recommendation → referrer + product;
  `c`/`g` → consumer, incl. the DynamoDB `guest_attribution` lookup) `→ invokes an in-VPC writer`
  (drives the Aurora ledger + audit). See ADR-0002 / ADR-0004 / ADR-0008.
- **Conversion events → analytics.** The in-VPC writer emits a **conversion event** (resolved
  attribution, amount, `pending`/`confirmed`/`clawback` status) as a structured `console.log` line
  that a **CloudWatch Logs subscription → Firehose → S3** ships — the same off-band mechanism as
  the redirect impression/click events (ADR-0007), so the writer needs no Firehose endpoint. This
  completes the funnel (impressions → clicks → **conversions**) in S3/Athena while the
  **authoritative** ledger stays in Aurora — the event stream is analytics-only, never the source
  of truth for money.

## Alternatives considered

- **Webhook / postback as source of truth** — carries less detail (no SubID / commission tier
  richness), requires a public endpoint + signature scheme + WAF, and doesn't fit the
  re-read-the-window reconciliation the pending→confirmed→rejected lifecycle needs.
- **Legacy `gw.api.taobao.com` MD5 gateway** — superseded by the `api-sg` HMAC-SHA256 gateway,
  consistent with link generation.
- **Postback as a low-latency hint that triggers an early pull** (poll stays source of truth) —
  a reasonable later optimisation; deferred, not in MVP.

## Consequences

- The monitoring metric is **poll lag / reconciliation gap**.
- Credit latency is bounded by the poll period — acceptable, since the 3-day maturation window
  dwarfs it.
- No public conversion endpoint → smaller attack surface (no inbound signature / WAF for it).
- The sole money-writer is the poller-writer (append-only), enforcing the integrity property of
  ADR-0002.
- **To confirm at integration:** the full `status` enum including the rejected/invalid state used
  for clawbacks, and that `custom_parameters` reliably round-trips the per-click value on the
  `api-sg` gateway.
