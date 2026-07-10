import { describe, expect, it } from "vitest";
import { decodeAttribution, withAttribution } from "./index";

// The wire keys are the platform's fixed tracking names (af/cn/cv) — anything else AliExpress
// drops from custom_parameters (proven on dev 2026-07-10). These tests pin the mapping.
describe("withAttribution", () => {
  it("appends af (ref) + cn (member sub), preserving existing query params", () => {
    const url = withAttribution("https://s.click.aliexpress.com/e/_x?aff=1", "rec1", {
      kind: "member",
      sub: "11111111-1111-1111-1111-111111111111",
    });
    const u = new URL(url);
    expect(u.searchParams.get("aff")).toBe("1");
    expect(u.searchParams.get("af")).toBe("rec1");
    expect(u.searchParams.get("cn")).toBe("11111111-1111-1111-1111-111111111111");
    expect(u.searchParams.get("cv")).toBeNull();
  });

  it("appends af (ref) + cv (guest id) and URL-encodes values", () => {
    const u = new URL(
      withAttribution("https://s.click.aliexpress.com/e/_x", "rec 1", {
        kind: "guest",
        guestId: "g&1",
      }),
    );
    expect(u.searchParams.get("af")).toBe("rec 1");
    expect(u.searchParams.get("cv")).toBe("g&1");
    expect(u.searchParams.get("cn")).toBeNull();
  });

  it("throws on a malformed stored URL rather than emitting garbage", () => {
    expect(() => withAttribution("not-a-url", "r", { kind: "guest", guestId: "g" })).toThrow();
  });
});

describe("decodeAttribution", () => {
  it("round-trips what withAttribution encodes (member)", () => {
    expect(
      decodeAttribution(
        JSON.stringify({ af: "abc123DEF45", cn: "11111111-1111-1111-1111-111111111111" }),
      ),
    ).toEqual({ ref: "abc123DEF45", c: "11111111-1111-1111-1111-111111111111", g: undefined });
  });

  it("round-trips a guest click", () => {
    expect(decodeAttribution(JSON.stringify({ af: "abc123DEF45", cv: "g-9" }))).toEqual({
      ref: "abc123DEF45",
      c: undefined,
      g: "g-9",
    });
  });

  it('stringifies numeric echoes (the platform doc example is {"af":0,"dp":1111})', () => {
    expect(decodeAttribution('{"af":12345}').ref).toBe("12345");
  });

  it("decodes the platform's empty echo, null, bad JSON and non-objects to {}", () => {
    expect(decodeAttribution("{}")).toEqual({ ref: undefined, c: undefined, g: undefined });
    expect(decodeAttribution(null)).toEqual({});
    expect(decodeAttribution("not json")).toEqual({});
    expect(decodeAttribution('"a string"')).toEqual({});
    expect(decodeAttribution('{"af":""}').ref).toBeUndefined();
    expect(decodeAttribution('{"af":{"nested":1}}').ref).toBeUndefined();
  });

  it("ignores the legacy ref/c/g keys the platform never round-tripped", () => {
    expect(decodeAttribution(JSON.stringify({ ref: "r", c: "s", g: "g" }))).toEqual({
      ref: undefined,
      c: undefined,
      g: undefined,
    });
  });
});
