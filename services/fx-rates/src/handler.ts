/**
 * FX rates updater (UC8 — FX rate update; ADR-0003). Non-VPC, like the redirect/retailer-proxy
 * (external HTTPS egress + DynamoDB, no VPC). Triggered by EventBridge Scheduler on an admin-tunable
 * period (CONFIG `fx.updateIntervalMinutes`; admin-api updates the schedule), and also on demand via
 * POST /admin/fx-rates/refresh.
 *
 * Per run: fetch the current rate for each tracked pair (settlement currency → display currency, e.g.
 * USD → ILS) from an external FX provider, then upsert the DynamoDB `fx_rate` cache as an
 * ExchangeRate (`@wanthat/contracts`) keyed (base, quote) with the provider's `asOf`. The pure
 * `convertMinor` (@wanthat/domain) reads that cache for the ILS display figure and the
 * withdrawal-time conversion. Failures leave the prior cached rate in place (last-known-good).
 *
 * Open: the FX provider + spread/rounding policy, the tracked-pair set, and a staleness threshold
 * beyond which withdrawal should block rather than convert on a stale rate.
 *
 * Stub.
 */
export const handler = async (): Promise<unknown> => {
  throw new Error("not implemented");
};
