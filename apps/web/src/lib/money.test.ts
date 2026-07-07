import { describe, expect, it } from "vitest";
import { formatMoneyMinor, splitMoneyMinor } from "./money";

describe("formatMoneyMinor", () => {
  it("formats zero", () => {
    expect(formatMoneyMinor("0", "ILS")).toBe("₪0.00");
  });
  it("formats sub-unit and grouped amounts", () => {
    expect(formatMoneyMinor("5", "ILS")).toBe("₪0.05");
    expect(formatMoneyMinor("14250", "ILS")).toBe("₪142.50");
    expect(formatMoneyMinor("123456789", "ILS")).toBe("₪1,234,567.89");
  });
  it("uses known symbols and falls back to the code", () => {
    expect(formatMoneyMinor("3620", "USD")).toBe("$36.20");
    expect(formatMoneyMinor("214", "EUR")).toBe("€2.14");
    expect(formatMoneyMinor("100", "JPY")).toBe("JPY 1.00");
  });
  it("keeps the sign ahead of the symbol", () => {
    expect(formatMoneyMinor("-400", "ILS")).toBe("-₪4.00");
  });
});

describe("splitMoneyMinor", () => {
  it("splits integer and fraction for the balance headline", () => {
    expect(splitMoneyMinor("14250", "ILS")).toEqual(["₪142", ".50"]);
    expect(splitMoneyMinor("0", "ILS")).toEqual(["₪0", ".00"]);
  });
});
