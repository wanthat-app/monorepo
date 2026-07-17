import { Logger } from "@aws-lambda-powertools/logger";
import type { WriteConversionsRequest, WriteConversionsResponse } from "@wanthat/contracts";
import { describe, expect, it, vi } from "vitest";
import { applyingConversionTotals } from "./conversion-totals";

const logger = new Logger({ serviceName: "test", logLevel: "SILENT" });

const REQ = { conversions: [] } as unknown as WriteConversionsRequest;

const response = (conversionTotals: Record<string, number>): WriteConversionsResponse => ({
  appended: [],
  failed: [],
  conversionTotals,
});

describe("applyingConversionTotals", () => {
  it("SETs every total from the writer response, then passes the response through", async () => {
    const setConversions = vi.fn(async () => {});
    const res = response({ recAAA11111: 2, recBBB22222: 5 });
    const wrapped = applyingConversionTotals(async () => res, {
      recommendations: { setConversions },
      logger,
    });
    expect(await wrapped(REQ)).toBe(res);
    expect(setConversions).toHaveBeenCalledTimes(2);
    expect(setConversions).toHaveBeenCalledWith("recAAA11111", 2);
    expect(setConversions).toHaveBeenCalledWith("recBBB22222", 5);
  });

  it("a failed SET is logged and non-fatal — the rest still apply (self-healing totals)", async () => {
    const setConversions = vi.fn(async () => {}).mockRejectedValueOnce(new Error("ddb down"));
    const errSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
    const wrapped = applyingConversionTotals(
      async () => response({ recAAA11111: 2, recBBB22222: 5 }),
      { recommendations: { setConversions }, logger },
    );
    await expect(wrapped(REQ)).resolves.toMatchObject({ appended: [], failed: [] });
    expect(setConversions).toHaveBeenCalledTimes(2);
    expect(errSpy).toHaveBeenCalledOnce();
    errSpy.mockRestore();
  });

  it("a writer failure propagates — totals never mask the money path", async () => {
    const setConversions = vi.fn(async () => {});
    const wrapped = applyingConversionTotals(
      async () => {
        throw new Error("writer invoke failed");
      },
      { recommendations: { setConversions }, logger },
    );
    await expect(wrapped(REQ)).rejects.toThrow("writer invoke failed");
    expect(setConversions).not.toHaveBeenCalled();
  });
});
