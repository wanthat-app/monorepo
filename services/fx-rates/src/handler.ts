/**
 * FX rates updater (UC8 — FX rate update; ADR-0003). Non-VPC, like the redirect/retailer-proxy
 * (external HTTPS egress + DynamoDB, no VPC). Triggered by EventBridge Scheduler on an admin-tunable
 * period (CONFIG `fx.updateIntervalMinutes`; admin-api updates the schedule), and also on demand via
 * POST /admin/fx-rates/refresh.
 *
 * Per run: fetch the current representative rate for each tracked pair (settlement → display, e.g.
 * USD → ILS) and upsert the DynamoDB `fx_rate` cache as an ExchangeRate (`@wanthat/contracts`) keyed
 * (base, quote) with the provider's `asOf`. The pure `convertMinor` (@wanthat/domain) reads that
 * cache for the ILS display figure and the withdrawal-time conversion. Failures leave the prior
 * cached rate in place (last-known-good).
 *
 * Provider (ADR-0017): selected at run time by CONFIG `fx.provider` (`boi` | `ecb`), both behind the
 * adapter. `boi` = Bank of Israel representative rate via the series DB (SDMX, no key) —
 * GET https://edge.boi.gov.il/FusionEdgeServer/sdmx/v2/data/dataflow/BOI.STATISTICS/EXR/1.0/RER_USD_ILS;
 * `ecb` = ECB reference rate via Frankfurter (EUR base, USD/ILS as a cross) — the commercial-safe
 * default. Open: BoI commercial-licensing consent (Product/Legal issue), spread/rounding policy, and
 * a staleness threshold beyond which withdrawal should block rather than convert on a stale rate.
 *
 * Stub.
 */
export const handler = async (): Promise<unknown> => {
  throw new Error("not implemented");
};
