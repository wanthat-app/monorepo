# ADR 0017 — Currency model & FX rate sourcing

- **Status:** Accepted
- **Date:** 2026-06-28
- **Related:** [ADR-0003](0003-datastore-aurora-and-dynamodb.md) (currency-agnostic ledger + DynamoDB), [ADR-0009](0009-conversion-ingestion-poller.md) (conversion credits the settlement currency)

## Context

AliExpress pays affiliate commission in a **settlement currency** (USD), but the member's wallet is
presented in **ILS** (Israel-first). We must decide *when* and *at what rate* USD becomes ILS, and
where the rate comes from. The earlier draft (SDD F4-R8) converted **at credit time** and held the
ledger in ILS at a rate locked on each conversion. That carries FX risk on our own books: between
crediting and payout we'd owe ILS while still holding USD, so any rate move is our loss/gain on
money we haven't moved yet — and it locks a rate we haven't realised.

## Decision

**Hold the wallet in the retailer's settlement currency; convert to ILS only at display and at
withdrawal.**

- **The ledger stores amounts in the settlement currency** (USD for AliExpress). There is **no
  conversion at credit** — our ILS liability is never created until money actually moves, so our
  liability matches our receivable and we carry **no FX float risk**. `Money` is currency-tagged and
  the wallet returns one balance **per currency held** (ADR-0003).
- **Display** converts to ILS for convenience, **net of a conversion commission** (CONFIG
  `fx.conversionCommissionBps`, default 2%) which buffers intraday drift and covers our own
  conversion cost. The **real** conversion happens only **at withdrawal**, where the rate is
  committed (and retained for audit); the ₪50 threshold is evaluated on the converted value.
- **Rate sourcing:** a scheduled, non-VPC `fx-rates` updater pulls a **daily reference rate** into a
  DynamoDB `fx_rate` cache (keyed `(base, quote)`, rate as an exact decimal string + `asOf`); the
  pure `convertMinor` (`@wanthat/domain`) reads it for exact bigint math. Refresh cadence is
  admin-tunable (CONFIG `fx.updateIntervalMinutes`, default twice-daily); a failed refresh leaves the
  **last-known-good** rate in place.
- **Provider for MVP: the Bank of Israel representative rate (שער יציג)** — the official daily
  USD/ILS reference rate: free, ILS-native, defensible to members ("we use the Bank of Israel
  rate"), and daily cadence matches our needs. Served from BoI's series database over SDMX (no API
  key): `https://edge.boi.gov.il/FusionEdgeServer/sdmx/v2/data/dataflow/BOI.STATISTICS/EXR/1.0/RER_USD_ILS`
  (CSV/SDMX-JSON). The provider sits behind an adapter, so it is **swappable** without touching the
  wallet.
  - **Licensing caveat (must resolve before launch):** BoI's site Terms of Use prohibit commercial
    reuse/redistribution of its data without **prior written consent** — there is no open license.
    So either obtain written consent from BoI (Public Enquiries) for our use, or fall back to a
    commercially-reusable source. **Fallback: ECB reference rates** (e.g. via Frankfurter) — freely
    reusable with attribution, EUR-based so USD/ILS is a cross. Same daily cadence; swap via the
    adapter if consent isn't secured.

We do **not** need real-time/intraday FX: a daily reference rate plus the commission buffer is
sufficient for a cashback wallet.

## Alternatives considered

- **Convert at credit, ledger in ILS** (the earlier draft) — rejected: creates FX float risk
  (liability ≠ receivable) and commits a rate before any money moves.
- **Real-time / intraday FX API** — unnecessary cost and complexity; the commission buffer absorbs
  daily drift.
- **A commercial FX API (Open Exchange Rates — USD base; or ECB via Frankfurter)** — viable and kept
  as drop-in alternatives behind the provider adapter; BoI chosen for MVP for authority, zero cost,
  and the right cadence.
- **Sourcing the rate from the payout rail** (e.g. Wise/Bit/PayBox) — the most accurate to realised
  cost, but couples to an unbuilt payout integration; deferred — revisit when the payout rail is
  chosen, since the rate we pay should match (or be conservative vs.) what the rail actually gives.

## Consequences

- Zero FX float on our books; FX risk is borne transparently at withdrawal.
- The displayed ILS figure **drifts with the rate even when the wallet is idle** — a UX consequence;
  balances and the ₪50 threshold are computed on the live converted value.
- BoI is **daily-only**; acceptable given the commission buffer, and the adapter lets us escalate to
  a higher-frequency provider if needed.
- **Endpoint confirmed** (BoI series DB, SDMX, no key — see above); **commercial-licensing is the
  open risk** — obtain BoI written consent or switch the adapter to ECB/Frankfurter before launch.
- **To confirm at integration:** a **staleness threshold** beyond which withdrawal should block
  rather than convert on a stale rate; and the spread/rounding policy of the conversion commission.
