import { describe, expect, it } from "vitest";
import { decodeAttribution, withAttribution } from "./index";

const SUB = "11111111-1111-1111-1111-111111111111";
const REC = "abc123DEF45";

// The wire format rides the platform's fixed tracking keys (af/dp) — anything else AliExpress
// drops from custom_parameters (proven on dev 2026-07-10). These tests pin the format:
//   af = <env>:user:<referrerSub>:rec:<recId>   dp = <env>:user:<sub> | <env>:guest:<guestId>
describe("withAttribution", () => {
  it("binds af (env+referrer+rec) and dp (member consumer), preserving existing params", () => {
    const url = withAttribution("https://s.click.aliexpress.com/e/_x?aff=1", {
      env: "dev",
      referrerSub: SUB,
      recommendationId: REC,
      consumer: { kind: "member", sub: "22222222-2222-4222-8222-222222222222" },
    });
    const u = new URL(url);
    expect(u.searchParams.get("aff")).toBe("1");
    expect(u.searchParams.get("af")).toBe(`dev:user:${SUB}:rec:${REC}`);
    expect(u.searchParams.get("dp")).toBe("dev:user:22222222-2222-4222-8222-222222222222");
  });

  it("binds a guest consumer into dp", () => {
    const u = new URL(
      withAttribution("https://s.click.aliexpress.com/e/_x", {
        env: "prod",
        referrerSub: SUB,
        recommendationId: REC,
        consumer: { kind: "guest", guestId: "g-9" },
      }),
    );
    expect(u.searchParams.get("af")).toBe(`prod:user:${SUB}:rec:${REC}`);
    expect(u.searchParams.get("dp")).toBe("prod:guest:g-9");
  });

  it("throws on a malformed stored URL rather than emitting garbage", () => {
    expect(() =>
      withAttribution("not-a-url", {
        env: "dev",
        referrerSub: SUB,
        recommendationId: REC,
        consumer: { kind: "guest", guestId: "g" },
      }),
    ).toThrow();
  });
});

describe("decodeAttribution", () => {
  it("round-trips what withAttribution encodes (member consumer)", () => {
    const u = new URL(
      withAttribution("https://s.click.aliexpress.com/e/_x", {
        env: "dev",
        referrerSub: SUB,
        recommendationId: REC,
        consumer: { kind: "member", sub: "22222222-2222-4222-8222-222222222222" },
      }),
    );
    const echoed = JSON.stringify({
      af: u.searchParams.get("af"),
      dp: u.searchParams.get("dp"),
    });
    expect(decodeAttribution(echoed)).toEqual({
      referrer: { env: "dev", sub: SUB, recommendationId: REC },
      consumer: { env: "dev", kind: "member", id: "22222222-2222-4222-8222-222222222222" },
    });
  });

  it("round-trips a guest click", () => {
    expect(
      decodeAttribution(JSON.stringify({ af: `dev:user:${SUB}:rec:${REC}`, dp: "dev:guest:g-9" })),
    ).toEqual({
      referrer: { env: "dev", sub: SUB, recommendationId: REC },
      consumer: { env: "dev", kind: "guest", id: "g-9" },
    });
  });

  it("decodes the halves independently — a mangled dp never costs the referrer half", () => {
    const out = decodeAttribution(
      JSON.stringify({ af: `dev:user:${SUB}:rec:${REC}`, dp: "garbage" }),
    );
    expect(out.referrer).toEqual({ env: "dev", sub: SUB, recommendationId: REC });
    expect(out.consumer).toBeUndefined();
  });

  it("rejects malformed af values (missing segments, wrong tags)", () => {
    expect(decodeAttribution(JSON.stringify({ af: "dev:user:only-sub" })).referrer).toBeUndefined();
    expect(
      decodeAttribution(JSON.stringify({ af: `dev:guest:${SUB}:rec:${REC}` })).referrer,
    ).toBeUndefined();
    expect(decodeAttribution(JSON.stringify({ af: REC })).referrer).toBeUndefined();
  });

  it("decodes the platform's empty echo, null, bad JSON and non-objects to {}", () => {
    expect(decodeAttribution("{}")).toEqual({});
    expect(decodeAttribution(null)).toEqual({});
    expect(decodeAttribution("not json")).toEqual({});
    expect(decodeAttribution('"a string"')).toEqual({});
    expect(decodeAttribution('{"af":"","dp":""}')).toEqual({});
    expect(decodeAttribution('{"af":{"nested":1}}')).toEqual({});
  });

  it('tolerates numeric echoes (the platform doc example is {"af":0,"dp":1111})', () => {
    // A numeric value cannot match the format — decoded as absent, never a crash.
    expect(decodeAttribution('{"af":0,"dp":1111}')).toEqual({});
  });

  it("ignores the legacy flat keys that never round-tripped", () => {
    expect(decodeAttribution(JSON.stringify({ ref: REC, c: SUB, g: "g-1" }))).toEqual({});
  });
});
