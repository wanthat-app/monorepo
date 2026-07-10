import type { AliExpressOrder } from "@wanthat/aliexpress";
import { describe, expect, it, vi } from "vitest";
import { type AttributionDeps, parseGmt8, resolveOrder } from "./attribution";

const SUB_REFERRER = "22222222-2222-2222-2222-222222222222";
const SUB_MEMBER = "11111111-1111-1111-1111-111111111111";
const SUB_GUEST = "33333333-3333-3333-3333-333333333333";

const REC = {
  recommendationId: "abc123DEF45",
  ownerId: SUB_REFERRER,
  cashback: { referrerBps: 5000, consumerBps: 2500 },
};

// The af/dp wire format (see @wanthat/domain): env-prefixed, colon-delimited.
const AF = `dev:user:${SUB_REFERRER}:rec:abc123DEF45`;
const params = (over: { af?: string | null; dp?: string } = {}): string =>
  JSON.stringify({ af: over.af === undefined ? AF : over.af, ...(over.dp ? { dp: over.dp } : {}) });

const deps = (over: Partial<AttributionDeps> = {}): AttributionDeps => ({
  recommendations: { get: vi.fn(async () => REC as never) },
  guests: { get: vi.fn(async () => undefined) },
  env: "dev",
  fallbackSplit: vi.fn(async () => ({ referrerBps: 4000, consumerBps: 1000 })),
  now: () => new Date("2026-07-10T10:00:00.000Z"),
  ...over,
});

const order = (over: Partial<AliExpressOrder> = {}): AliExpressOrder => ({
  orderId: "8123456789",
  status: "Payment Completed",
  customParameters: params({ dp: `dev:user:${SUB_MEMBER}` }),
  commissionMinor: "124",
  commissionCurrency: "USD",
  orderTimeGmt8: "2026-07-10 18:00:00",
  ...over,
});

describe("resolveOrder", () => {
  it("resolves a member order: snapshot split, both parties, pending", async () => {
    const out = await resolveOrder(order(), deps());
    if (out.outcome !== "resolved") throw new Error("expected resolved");
    const { resolved, gross, consumer } = out.write;
    expect(resolved.orderId).toBe("8123456789");
    expect(resolved.recommendationId).toBe("abc123DEF45");
    expect(resolved.status).toBe("pending");
    // gross 124 x 50% -> 62 referrer; x 25% -> 31 consumer
    expect(resolved.referrer).toEqual({
      sub: SUB_REFERRER,
      reward: { amountMinor: 62n, currency: "USD" },
    });
    expect(resolved.consumer).toEqual({
      sub: SUB_MEMBER,
      reward: { amountMinor: 31n, currency: "USD" },
    });
    expect(resolved.occurredAt).toBe("2026-07-10T10:00:00.000Z"); // 18:00 GMT+8 = 10:00 UTC
    expect(gross).toEqual({ amountMinor: 124n, currency: "USD" });
    expect(consumer).toBe("member");
  });

  it("maps a claimed guest to its sub, an unclaimed guest to a null party (still kind guest)", async () => {
    const claimed = await resolveOrder(
      order({ customParameters: params({ dp: "dev:guest:g-1" }) }),
      deps({ guests: { get: vi.fn(async () => ({ guestId: "g-1", sub: SUB_GUEST }) as never) } }),
    );
    if (claimed.outcome !== "resolved") throw new Error("expected resolved");
    expect(claimed.write.resolved.consumer?.sub).toBe(SUB_GUEST);
    expect(claimed.write.consumer).toBe("guest");

    const unclaimed = await resolveOrder(
      order({ customParameters: params({ dp: "dev:guest:g-2" }) }),
      deps(),
    );
    if (unclaimed.outcome !== "resolved") throw new Error("expected resolved");
    expect(unclaimed.write.resolved.consumer).toBeNull();
    expect(unclaimed.write.consumer).toBe("guest");
  });

  it("referrer-only, malformed member sub and foreign-env consumer degrade to consumer none", async () => {
    const refOnly = await resolveOrder(order({ customParameters: params() }), deps());
    if (refOnly.outcome !== "resolved") throw new Error("expected resolved");
    expect(refOnly.write.resolved.consumer).toBeNull();
    expect(refOnly.write.consumer).toBe("none");

    const badSub = await resolveOrder(
      order({ customParameters: params({ dp: "dev:user:not-a-uuid" }) }),
      deps(),
    );
    if (badSub.outcome !== "resolved") throw new Error("expected resolved");
    expect(badSub.write.resolved.consumer).toBeNull();
    expect(badSub.write.consumer).toBe("none");

    // A prod consumer on a dev order: the click halves disagree — drop the consumer, not the order.
    const foreign = await resolveOrder(
      order({ customParameters: params({ dp: `prod:user:${SUB_MEMBER}` }) }),
      deps(),
    );
    if (foreign.outcome !== "resolved") throw new Error("expected resolved");
    expect(foreign.write.resolved.consumer).toBeNull();
    expect(foreign.write.consumer).toBe("none");
  });

  it("credits the af referrer sub at the config split when the recommendation is gone", async () => {
    const out = await resolveOrder(
      order(),
      deps({ recommendations: { get: vi.fn(async () => undefined) } }),
    );
    if (out.outcome !== "resolved") throw new Error("expected resolved");
    // gross 124 at the FALLBACK split: x 40% -> 49 referrer; x 10% -> 12 consumer
    expect(out.write.resolved.recommendationId).toBe("abc123DEF45"); // preserved from the click
    expect(out.write.resolved.referrer).toEqual({
      sub: SUB_REFERRER,
      reward: { amountMinor: 49n, currency: "USD" },
    });
    expect(out.write.resolved.consumer).toEqual({
      sub: SUB_MEMBER,
      reward: { amountMinor: 12n, currency: "USD" },
    });
  });

  it("a zero consumer share yields no consumer party", async () => {
    const out = await resolveOrder(
      order(),
      deps({
        recommendations: {
          get: vi.fn(
            async () => ({ ...REC, cashback: { referrerBps: 5000, consumerBps: 0 } }) as never,
          ),
        },
      }),
    );
    if (out.outcome !== "resolved") throw new Error("expected resolved");
    expect(out.write.resolved.consumer).toBeNull();
    expect(out.write.consumer).toBe("member"); // the KIND still reflects the click
  });

  it("maps statuses: confirmed and clawback variants, unknown -> untracked", async () => {
    const confirmed = await resolveOrder(
      order({ status: "Buyer Confirmed Goods Receipt" }),
      deps(),
    );
    if (confirmed.outcome !== "resolved") throw new Error("expected resolved");
    expect(confirmed.write.resolved.status).toBe("confirmed");

    const finished = await resolveOrder(order({ status: "Order Completed" }), deps());
    if (finished.outcome !== "resolved") throw new Error("expected resolved");
    expect(finished.write.resolved.status).toBe("confirmed");

    const invalid = await resolveOrder(order({ status: "Order Invalid" }), deps());
    if (invalid.outcome !== "resolved") throw new Error("expected resolved");
    expect(invalid.write.resolved.status).toBe("clawback");

    const weird = await resolveOrder(order({ status: "Mystery State" }), deps());
    expect(weird).toEqual({ outcome: "untracked", reason: "unknown_status" });
  });

  it("untracks: no params, bad JSON, foreign env, gone rec + bad sub, no commission", async () => {
    expect(await resolveOrder(order({ customParameters: null }), deps())).toEqual({
      outcome: "untracked",
      reason: "no_ref",
    });
    expect(await resolveOrder(order({ customParameters: "not json" }), deps())).toEqual({
      outcome: "untracked",
      reason: "no_ref",
    });
    // Another env's click on the shared retailer account — not ours to credit.
    expect(
      await resolveOrder(
        order({ customParameters: params({ af: `prod:user:${SUB_REFERRER}:rec:abc123DEF45` }) }),
        deps(),
      ),
    ).toEqual({ outcome: "untracked", reason: "foreign_env" });
    // Recommendation gone AND the fallback sub is not a well-formed uuid: nothing to credit.
    expect(
      await resolveOrder(
        order({ customParameters: params({ af: "dev:user:mangled:rec:abc123DEF45" }) }),
        deps({ recommendations: { get: vi.fn(async () => undefined) } }),
      ),
    ).toEqual({ outcome: "untracked", reason: "unknown_ref" });
    expect(await resolveOrder(order({ commissionMinor: null }), deps())).toEqual({
      outcome: "untracked",
      reason: "no_commission",
    });
  });

  it("falls back to now for an unparseable order time", async () => {
    const out = await resolveOrder(order({ orderTimeGmt8: "whenever" }), deps());
    if (out.outcome !== "resolved") throw new Error("expected resolved");
    expect(out.write.resolved.occurredAt).toBe("2026-07-10T10:00:00.000Z");
  });
});

describe("parseGmt8", () => {
  it("converts the platform clock to ISO UTC", () => {
    expect(parseGmt8("2026-07-10 18:00:00")).toBe("2026-07-10T10:00:00.000Z");
    expect(parseGmt8("nonsense")).toBeNull();
    expect(parseGmt8(null)).toBeNull();
  });
});
