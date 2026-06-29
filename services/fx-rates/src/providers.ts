import { type Currency, type FxProvider, type IsoDateTime, RateDecimal } from "@wanthat/contracts";

/**
 * FX rate providers (ADR-0017). Both sources are implemented behind one adapter; the live one is
 * chosen at run time by CONFIG `fx.provider`. The pure response parsers are exported for unit tests;
 * the network fetch is the only impure part.
 *
 * - **ecb** (default, commercial-safe): the ECB daily reference rate via Frankfurter. EUR-based, so
 *   USD/ILS comes back as a direct cross when we set `base`.
 * - **boi**: the Bank of Israel representative rate over SDMX (no key). Gated on commercial-licensing
 *   consent (Product/Legal issue), hence not the default. The SDMX-JSON shape below is parsed
 *   defensively and should be re-confirmed against the live endpoint when boi is switched on.
 */
export interface ProviderQuote {
  /** Exact decimal string, quote units per 1 base unit (e.g. "3.7215"). */
  readonly rate: RateDecimal;
  /** When the provider quoted it (basis for staleness checks). */
  readonly asOf: IsoDateTime;
}

export interface RateProvider {
  readonly id: FxProvider;
  fetchRate(base: Currency, quote: Currency): Promise<ProviderQuote>;
}

const FRANKFURTER_BASE = "https://api.frankfurter.app";
const BOI_SDMX_URL =
  "https://edge.boi.gov.il/FusionEdgeServer/sdmx/v2/data/dataflow/BOI.STATISTICS/EXR/1.0/RER_USD_ILS";

// ---- ecb (Frankfurter) -------------------------------------------------------------------------

export const ecbProvider: RateProvider = {
  id: "ecb",
  async fetchRate(base, quote) {
    const url = `${FRANKFURTER_BASE}/latest?base=${base}&symbols=${quote}`;
    return parseFrankfurter(await fetchJson(url), quote);
  },
};

/** Parse a Frankfurter `/latest` response: `{ base, date: "YYYY-MM-DD", rates: { [quote]: number } }`. */
export function parseFrankfurter(json: unknown, quote: Currency): ProviderQuote {
  const body = json as { date?: unknown; rates?: Record<string, unknown> };
  const value = body.rates?.[quote];
  const date = body.date;
  if (typeof date !== "string") throw new Error("frankfurter: missing date");
  return { rate: toRateDecimal(value), asOf: isoFromDate(date) };
}

// ---- boi (Bank of Israel, SDMX) ----------------------------------------------------------------

export const boiProvider: RateProvider = {
  id: "boi",
  async fetchRate(base, quote) {
    if (base !== "USD" || quote !== "ILS") {
      throw new Error(`boi provider supports only USD/ILS, got ${base}/${quote}`);
    }
    const json = await fetchJson(`${BOI_SDMX_URL}?lastNObservations=1`, {
      Accept: "application/vnd.sdmx.data+json",
    });
    return parseBoiSdmx(json);
  },
};

/**
 * Parse an SDMX-JSON dataflow response down to the latest observation. Handles the 2.0 (`structures`
 * array) shape; the rate is the highest-indexed observation value and `asOf` its TIME_PERIOD.
 */
export function parseBoiSdmx(json: unknown): ProviderQuote {
  const data = (json as { data?: unknown }).data ?? json;
  const dataSets = (data as { dataSets?: unknown[] }).dataSets;
  const structures = (data as { structures?: unknown[]; structure?: unknown }).structures ?? [
    (data as { structure?: unknown }).structure,
  ];
  const series = (dataSets?.[0] as { series?: Record<string, unknown> } | undefined)?.series;
  const firstSeries = series ? Object.values(series)[0] : undefined;
  const observations = (firstSeries as { observations?: Record<string, unknown[]> } | undefined)
    ?.observations;
  if (!observations) throw new Error("boi sdmx: no observations");

  // Latest observation = the largest numeric observation key.
  const lastIndex = Object.keys(observations)
    .map(Number)
    .reduce((a, b) => Math.max(a, b), -1);
  const value = observations[String(lastIndex)]?.[0];

  const timeValues = (
    structures?.[0] as
      | { dimensions?: { observation?: Array<{ values?: Array<{ id?: unknown }> }> } }
      | undefined
  )?.dimensions?.observation?.[0]?.values;
  const period = timeValues?.[lastIndex]?.id;
  if (typeof period !== "string") throw new Error("boi sdmx: no time period");

  return { rate: toRateDecimal(value), asOf: isoFromDate(period) };
}

// ---- shared helpers ----------------------------------------------------------------------------

export function providerFor(id: FxProvider): RateProvider {
  return id === "boi" ? boiProvider : ecbProvider;
}

async function fetchJson(url: string, headers?: Record<string, string>): Promise<unknown> {
  const res = await fetch(url, headers ? { headers } : undefined);
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

/** A positive finite provider number → an exact decimal string (rejects NaN/∞/exponent forms). */
function toRateDecimal(value: unknown): RateDecimal {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`invalid rate value: ${String(value)}`);
  }
  return RateDecimal.parse(value.toString());
}

/** A provider date (`YYYY-MM-DD`) → an ISO-8601 UTC instant at midnight (daily reference rate). */
function isoFromDate(date: string): IsoDateTime {
  const iso = `${date}T00:00:00.000Z`;
  if (Number.isNaN(Date.parse(iso))) throw new Error(`invalid provider date: ${date}`);
  return iso;
}
