import { describe, expect, it } from "vitest";
import { withAttribution } from "./index";

describe("withAttribution", () => {
  it("appends ref + c for a member, preserving existing query params", () => {
    const url = withAttribution("https://s.click.aliexpress.com/e/_x?aff=1", "rec1", {
      kind: "member",
      sub: "11111111-1111-1111-1111-111111111111",
    });
    const u = new URL(url);
    expect(u.searchParams.get("aff")).toBe("1");
    expect(u.searchParams.get("ref")).toBe("rec1");
    expect(u.searchParams.get("c")).toBe("11111111-1111-1111-1111-111111111111");
    expect(u.searchParams.get("g")).toBeNull();
  });

  it("appends ref + g for a guest and URL-encodes values", () => {
    const u = new URL(
      withAttribution("https://s.click.aliexpress.com/e/_x", "rec 1", {
        kind: "guest",
        guestId: "g&1",
      }),
    );
    expect(u.searchParams.get("ref")).toBe("rec 1");
    expect(u.searchParams.get("g")).toBe("g&1");
    expect(u.searchParams.get("c")).toBeNull();
  });

  it("throws on a malformed stored URL rather than emitting garbage", () => {
    expect(() => withAttribution("not-a-url", "r", { kind: "guest", guestId: "g" })).toThrow();
  });
});
