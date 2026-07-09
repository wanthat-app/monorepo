import { ResolveResponse } from "@wanthat/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolve, type ResolveDeps } from "./resolve";

const NOW = "2026-07-01T00:00:00.000Z";
const ITEM = {
  recommendationId: "abc123DEF45",
  ownerId: "sub-1",
  storeId: "aliexpress",
  storeProductId: "1005006123456789",
  affiliateUrl: "https://s.click.aliexpress.com/e/_x?aff=1",
  title: "Feeder",
  imageUrl: null,
  price: { amountMinor: "2500", currency: "USD" },
  commissionBps: 800,
  cashback: { referrerBps: 5000, consumerBps: 2500 },
  review: null,
  referrerFirstName: null,
  clicks: 0,
  conversions: 0,
  createdAt: NOW,
  updatedAt: NOW,
};
const SUB = "11111111-1111-1111-1111-111111111111";

const makeDeps = (overrides: Partial<ResolveDeps> = {}): ResolveDeps => ({
  recommendations: { get: vi.fn(async () => ITEM) } as never,
  verifyBearer: vi.fn(async (auth?: string) => (auth === "Bearer good" ? SUB : null)),
  ...overrides,
});

const call = (deps: ResolveDeps, opts: { auth?: string; body?: unknown } = {}) =>
  resolve(
    {
      headers: opts.auth ? { authorization: opts.auth } : {},
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    },
    "abc123DEF45",
    deps,
  );

let logSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  logSpy.mockRestore();
});

const clickEvents = () =>
  logSpy.mock.calls
    .map((c) => String(c[0]))
    .filter((l) => l.includes('"click"'))
    .map((l) => JSON.parse(l) as { type: string; consumer: string; recommendationId: string });

describe("resolve", () => {
  it("redirects a verified member with ref + c and emits a member click", async () => {
    const res = await call(makeDeps(), { auth: "Bearer good", body: {} });
    expect(res.statusCode).toBe(200);
    const parsed = ResolveResponse.parse(JSON.parse(res.body));
    if (parsed.outcome !== "redirect") throw new Error("expected redirect");
    const u = new URL(parsed.url);
    expect(u.searchParams.get("aff")).toBe("1"); // stored params preserved
    expect(u.searchParams.get("ref")).toBe("abc123DEF45");
    expect(u.searchParams.get("c")).toBe(SUB);
    expect(u.searchParams.get("g")).toBeNull();
    expect(clickEvents()).toEqual([
      expect.objectContaining({ type: "click", consumer: "member" }),
    ]);
  });

  it("redirects a guest with ref + g and emits a guest click", async () => {
    const res = await call(makeDeps(), { body: { guestId: "g-123" } });
    const parsed = ResolveResponse.parse(JSON.parse(res.body));
    if (parsed.outcome !== "redirect") throw new Error("expected redirect");
    const u = new URL(parsed.url);
    expect(u.searchParams.get("g")).toBe("g-123");
    expect(u.searchParams.get("c")).toBeNull();
    expect(clickEvents()).toEqual([expect.objectContaining({ consumer: "guest" })]);
  });

  it("answers authRequired (never 401) with no identity, still emitting the click", async () => {
    const res = await call(makeDeps(), { body: {} });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ outcome: "authRequired" });
    expect(clickEvents()).toEqual([expect.objectContaining({ consumer: "none" })]);
  });

  it("answers authRequired for an invalid token, and no body at all counts as empty", async () => {
    const res = await call(makeDeps(), { auth: "Bearer expired" });
    expect(JSON.parse(res.body)).toEqual({ outcome: "authRequired" });
  });

  it("downgrades an invalid token to the guest in the body", async () => {
    const res = await call(makeDeps(), { auth: "Bearer expired", body: { guestId: "g-9" } });
    const parsed = JSON.parse(res.body) as { outcome: string; url: string };
    expect(parsed.outcome).toBe("redirect");
    expect(new URL(parsed.url).searchParams.get("g")).toBe("g-9");
  });

  it("400s malformed JSON and a guestId failing the contract, without a click", async () => {
    const deps = makeDeps();
    const bad = await resolve({ body: "{not json" }, "abc123DEF45", deps);
    expect(bad.statusCode).toBe(400);
    const badGuest = await call(deps, { body: { guestId: 42 } });
    expect(badGuest.statusCode).toBe(400);
    expect(clickEvents()).toEqual([]);
  });

  it("404s an unknown recommendation without a click", async () => {
    const deps = makeDeps({ recommendations: { get: vi.fn(async () => undefined) } as never });
    const res = await call(deps, { auth: "Bearer good", body: {} });
    expect(res.statusCode).toBe(404);
    expect(clickEvents()).toEqual([]);
  });

  it("decodes a base64 body (API Gateway may encode)", async () => {
    const res = await resolve(
      {
        body: Buffer.from(JSON.stringify({ guestId: "g-64" })).toString("base64"),
        isBase64Encoded: true,
      },
      "abc123DEF45",
      makeDeps(),
    );
    const parsed = JSON.parse(res.body) as { url: string };
    expect(new URL(parsed.url).searchParams.get("g")).toBe("g-64");
  });
});
