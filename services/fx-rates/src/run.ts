import type { Currency, ExchangeRate, FxProvider } from "@wanthat/contracts";
import type { FxRateRepo, RuntimeConfigRepo } from "@wanthat/dynamo";
import { providerFor, type RateProvider } from "./providers";

/** Pairs the cache tracks: settlement currency (USD, AliExpress) → display currency (ILS). */
export const TRACKED_PAIRS: ReadonlyArray<{ base: Currency; quote: Currency }> = [
  { base: "USD", quote: "ILS" },
];

export interface FxRunResult {
  readonly provider: FxProvider;
  readonly updated: ExchangeRate[];
  readonly failed: Array<{ pair: string; error: string }>;
  /** The full cache after the run — shape-compatible with `RefreshFxRatesResponse` (`{ rates }`). */
  readonly rates: ExchangeRate[];
}

export interface FxRunDeps {
  readonly config: RuntimeConfigRepo;
  readonly fx: FxRateRepo;
  /** Injectable for tests; defaults to the real provider registry. */
  readonly resolveProvider?: (id: FxProvider) => RateProvider;
  readonly log?: (msg: string, ctx?: Record<string, unknown>) => void;
}

/**
 * One FX refresh run (ADR-0017): read the live provider from CONFIG, fetch each tracked pair, and
 * upsert the cache. A per-pair fetch failure is **last-known-good** — it leaves the cached rate in
 * place and is recorded in `failed`, never thrown — so a provider outage degrades gracefully and a
 * scheduled invoke doesn't trip retries/alarms.
 */
export async function runFxUpdate(deps: FxRunDeps): Promise<FxRunResult> {
  const resolve = deps.resolveProvider ?? providerFor;
  const provider = (await deps.config.get("fx.provider")) as FxProvider;
  const adapter = resolve(provider);

  const updated: ExchangeRate[] = [];
  const failed: Array<{ pair: string; error: string }> = [];
  for (const { base, quote } of TRACKED_PAIRS) {
    const pair = `${base}#${quote}`;
    try {
      const quote_ = await adapter.fetchRate(base, quote);
      updated.push(await deps.fx.put({ base, quote, rate: quote_.rate, asOf: quote_.asOf }));
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      failed.push({ pair, error });
      deps.log?.("fx_fetch_failed", { pair, provider, error });
    }
  }

  return { provider, updated, failed, rates: await deps.fx.getAll() };
}
