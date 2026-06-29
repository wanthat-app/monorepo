import { afterEach, describe, expect, it, vi } from "vitest";
import { ecbProvider, parseBoiSdmx, parseFrankfurter, providerFor } from "./providers";

afterEach(() => vi.unstubAllGlobals());

describe("parseFrankfurter", () => {
  it("extracts the quote rate and midnight-UTC asOf", () => {
    const json = { base: "USD", date: "2026-06-27", rates: { ILS: 3.7215 } };
    expect(parseFrankfurter(json, "ILS")).toEqual({
      rate: "3.7215",
      asOf: "2026-06-27T00:00:00.000Z",
    });
  });

  it("throws when the quoted currency is missing", () => {
    expect(() => parseFrankfurter({ date: "2026-06-27", rates: {} }, "ILS")).toThrow();
  });

  it("throws on a missing date", () => {
    expect(() => parseFrankfurter({ rates: { ILS: 3.7 } }, "ILS")).toThrow();
  });
});

describe("parseBoiSdmx", () => {
  // SDMX-JSON 2.0 shape: dataSets[].series{}.observations{ "<idx>": [value] } + structures[].
  const sdmx = {
    data: {
      dataSets: [{ series: { "0:0": { observations: { "0": [3.71], "1": [3.7301] } } } }],
      structures: [
        {
          dimensions: {
            observation: [{ values: [{ id: "2026-06-26" }, { id: "2026-06-27" }] }],
          },
        },
      ],
    },
  };

  it("takes the latest observation and its time period", () => {
    expect(parseBoiSdmx(sdmx)).toEqual({ rate: "3.7301", asOf: "2026-06-27T00:00:00.000Z" });
  });

  it("throws when there are no observations", () => {
    expect(() =>
      parseBoiSdmx({ data: { dataSets: [{ series: {} }], structures: [{}] } }),
    ).toThrow();
  });
});

describe("providerFor", () => {
  it("selects boi or defaults to ecb", () => {
    expect(providerFor("boi").id).toBe("boi");
    expect(providerFor("ecb").id).toBe("ecb");
  });
});

describe("ecbProvider.fetchRate", () => {
  it("fetches and parses a live-shaped response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ base: "USD", date: "2026-06-27", rates: { ILS: 3.69 } }),
      })),
    );
    expect(await ecbProvider.fetchRate("USD", "ILS")).toEqual({
      rate: "3.69",
      asOf: "2026-06-27T00:00:00.000Z",
    });
  });

  it("throws on a non-2xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })),
    );
    await expect(ecbProvider.fetchRate("USD", "ILS")).rejects.toThrow(/503/);
  });
});
