import { describe, expect, it } from "vitest";
import { normalizePhone } from "./phone";

describe("normalizePhone", () => {
  it.each([
    // Israel (launch market) — national with/without separators, and international.
    ["IL national + trunk 0", "0507058253", "IL", "+972507058253"],
    ["IL dashes + trunk 0", "050-705-8253", "IL", "+972507058253"],
    ["IL spaces + trunk 0", "050 705 8253", "IL", "+972507058253"],
    ["IL international with +", "+972 50 705 8253", "IL", "+972507058253"],
    ["IL international, no default country", "+972507058253", undefined, "+972507058253"],
    // Other countries — proves it's universal, not IL-coded.
    ["US national", "(213) 373-4253", "US", "+12133734253"],
    ["US international, no default", "+1 213-373-4253", undefined, "+12133734253"],
    ["UK national trunk 0", "07400 123456", "GB", "+447400123456"],
  ])("normalizes %s -> E.164", (_label, input, country, expected) => {
    expect(normalizePhone(input, country as never)).toBe(expected);
  });

  it("returns null for invalid input (validates, not just formats)", () => {
    expect(normalizePhone("0", "IL")).toBeNull();
    expect(normalizePhone("123", "IL")).toBeNull();
    expect(normalizePhone("", "IL")).toBeNull();
    expect(normalizePhone("not a phone", "IL")).toBeNull();
    expect(normalizePhone("0507058253")).toBeNull(); // national input needs a default country
  });
});
