import type { ExchangeRate } from "@wanthat/contracts";
import type { FxRateRepo, RuntimeConfigRepo } from "@wanthat/dynamo";
import { describe, expect, it, vi } from "vitest";
import type { RateProvider } from "./providers";
import { runFxUpdate } from "./run";

const ISO = "2026-06-27T00:00:00.000Z";
const USD_ILS: ExchangeRate = { base: "USD", quote: "ILS", rate: "3.7215", asOf: ISO };

/** Stub repos: config returns a fixed provider; fx records puts and reports a cache for getAll. */
function deps(opts: { provider: "ecb" | "boi"; adapter: RateProvider; cache?: ExchangeRate[] }) {
  const put = vi.fn(async (r: ExchangeRate) => r);
  const config = { get: vi.fn(async () => opts.provider) } as unknown as RuntimeConfigRepo;
  const fx = {
    put,
    getAll: vi.fn(async () => opts.cache ?? []),
  } as unknown as FxRateRepo;
  const resolveProvider = vi.fn(() => opts.adapter);
  return { config, fx, resolveProvider, put };
}

describe("runFxUpdate", () => {
  it("fetches the configured provider and upserts each pair", async () => {
    const adapter: RateProvider = {
      id: "ecb",
      fetchRate: vi.fn(async () => ({ rate: "3.7215", asOf: ISO })),
    };
    const d = deps({ provider: "ecb", adapter, cache: [USD_ILS] });
    const result = await runFxUpdate(d);

    expect(d.resolveProvider).toHaveBeenCalledWith("ecb");
    expect(d.put).toHaveBeenCalledWith({ base: "USD", quote: "ILS", rate: "3.7215", asOf: ISO });
    expect(result.provider).toBe("ecb");
    expect(result.updated).toHaveLength(1);
    expect(result.failed).toHaveLength(0);
    expect(result.rates).toEqual([USD_ILS]);
  });

  it("is last-known-good on a provider failure: records it, does not throw or write", async () => {
    const adapter: RateProvider = {
      id: "boi",
      fetchRate: vi.fn(async () => {
        throw new Error("provider down");
      }),
    };
    const d = deps({ provider: "boi", adapter, cache: [USD_ILS] }); // prior cached rate survives
    const result = await runFxUpdate(d);

    expect(d.put).not.toHaveBeenCalled();
    expect(result.updated).toHaveLength(0);
    expect(result.failed).toEqual([{ pair: "USD#ILS", error: "provider down" }]);
    expect(result.rates).toEqual([USD_ILS]);
  });
});
