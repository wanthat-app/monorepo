import { describe, expect, it } from "vitest";
import { GetWalletResponse } from "./endpoints";

describe("GetWalletResponse", () => {
  it("parses the empty-wallet stub shape with a zero ILS estimate", () => {
    const parsed = GetWalletResponse.parse({
      balances: [],
      estimated: {
        available: { amountMinor: "0", currency: "ILS" },
        pending: { amountMinor: "0", currency: "ILS" },
      },
    });
    expect(parsed.estimated?.available.amountMinor).toBe(0n);
    expect(parsed.estimated?.available.currency).toBe("ILS");
    expect(parsed.balances).toEqual([]);
  });

  it("accepts a null estimate (a held currency without an FX rate)", () => {
    const parsed = GetWalletResponse.parse({ balances: [], estimated: null });
    expect(parsed.estimated).toBeNull();
  });

  it("rejects a response missing the estimated field", () => {
    expect(GetWalletResponse.safeParse({ balances: [] }).success).toBe(false);
  });
});
