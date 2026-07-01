import { describe, expect, it } from "vitest";
import { normalizeIsraeliPhone, toE164IL } from "./phone";

describe("normalizeIsraeliPhone", () => {
  const canonical = "+972507058253";

  it.each([
    ["national with trunk 0", "0507058253"],
    ["national without trunk 0", "507058253"],
    ["dashes + trunk 0", "050-705-8253"],
    ["spaces + trunk 0", "050 705 8253"],
    ["parens", "(050) 705-8253"],
    ["country code with +", "+972507058253"],
    ["country code no +", "972507058253"],
    ["country code + trunk 0", "9720507058253"],
    ["international 00 prefix", "00972507058253"],
    ["+972 with trunk 0", "+9720507058253"],
  ])("normalizes %s to E.164", (_label, input) => {
    expect(normalizeIsraeliPhone(input)).toBe(canonical);
  });

  it("toE164IL normalizes then validates against the E.164 schema", () => {
    expect(toE164IL("050-705-8253")).toBe(canonical);
    expect(toE164IL("+972 50 705 8253")).toBe(canonical);
  });
});
