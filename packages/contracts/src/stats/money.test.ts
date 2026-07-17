import { describe, expect, it } from "vitest";
import { MoneyStats } from "./money";

const dense = Array.from({ length: 30 }, (_, i) => ({
  date: `2026-06-${String(i + 1).padStart(2, "0")}`,
  count: 0,
}));

describe("MoneyStats contract", () => {
  it("accepts wire-shaped money (decimal strings) and yields bigints", () => {
    const parsed = MoneyStats.parse({
      totals: [
        {
          currency: "USD",
          confirmed: { amountMinor: "500", currency: "USD" },
          pending: { amountMinor: "200", currency: "USD" },
        },
      ],
      ilsEstimate: {
        confirmed: { amountMinor: "1690", currency: "ILS" },
        pending: { amountMinor: "676", currency: "ILS" },
        confirmedInWindow: { amountMinor: "1690", currency: "ILS" },
      },
      conversions30d: 1,
      dailyConversions: dense,
    });
    expect(parsed.totals[0]?.confirmed.amountMinor).toBe(500n);
    expect(parsed.ilsEstimate?.confirmedInWindow.amountMinor).toBe(1690n);
  });

  it("accepts the null ilsEstimate fallback (USD held, no FX rate)", () => {
    const ok = MoneyStats.safeParse({
      totals: [],
      ilsEstimate: null,
      conversions30d: 0,
      dailyConversions: dense,
    });
    expect(ok.success).toBe(true);
  });

  it("rejects a conversions series that is not exactly 30 entries", () => {
    const bad = MoneyStats.safeParse({
      totals: [],
      ilsEstimate: null,
      conversions30d: 0,
      dailyConversions: dense.slice(0, 29),
    });
    expect(bad.success).toBe(false);
  });
});
