import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted fake so the vi.mock factory can close over it (vitest hoists vi.mock above imports).
const { fake } = vi.hoisted(() => ({
  fake: {
    recommendations: { listByOwner: vi.fn() },
  },
}));

vi.mock("./context", () => ({ getContext: () => fake }));

import { userRecommendationsRouter } from "./user-recommendations";

const app = new Hono();
app.route("/admin/users", userRecommendationsRouter());

const SUB = "11111111-1111-1111-1111-111111111111";
const NOW = "2026-07-10T10:00:00.000Z";

const STORED_REC = {
  recommendationId: "abc123DEF45",
  ownerId: SUB,
  storeId: "aliexpress",
  storeProductId: "1005006123456789",
  affiliateUrl: "https://s.click.aliexpress.com/e/_secret", // must NEVER reach the wire
  title: "Feeder",
  imageUrl: "https://img/x.jpg",
  price: { amountMinor: "125", currency: "USD" },
  commissionBps: 300,
  cashback: { referrerBps: 6000, consumerBps: 2000 },
  review: null,
  referrerFirstName: "דניס",
  clicks: 3,
  conversions: 1,
  createdAt: NOW,
  updatedAt: NOW,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /admin/users/:sub/recommendations", () => {
  it("lists the member's recommendations WITHOUT the affiliate URL", async () => {
    fake.recommendations.listByOwner.mockResolvedValue({ items: [STORED_REC], lastKey: undefined });
    const res = await app.request(`/admin/users/${SUB}/recommendations`);
    expect(res.status).toBe(200);
    expect(fake.recommendations.listByOwner).toHaveBeenCalledWith(SUB, 20, undefined);
    const body = (await res.json()) as { items: Array<Record<string, unknown>> };
    expect(body.items).toEqual([
      {
        recommendationId: "abc123DEF45",
        storeId: "aliexpress",
        storeProductId: "1005006123456789",
        title: "Feeder",
        imageUrl: "https://img/x.jpg",
        price: { amountMinor: "125", currency: "USD" },
        commissionBps: 300,
        cashback: { referrerBps: 6000, consumerBps: 2000 },
        review: null,
        clicks: 3,
        conversions: 1,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ]);
    // The standing rule, asserted explicitly: no affiliate URL (and no owner echo) on any wire.
    expect(JSON.stringify(body)).not.toContain("affiliateUrl");
    expect(JSON.stringify(body)).not.toContain("s.click.aliexpress.com");
  });

  it("round-trips the cursor and 404s a malformed sub", async () => {
    fake.recommendations.listByOwner.mockResolvedValue({
      items: [],
      lastKey: { recommendationId: "x", ownerId: SUB, createdAt: NOW },
    });
    const first = await app.request(`/admin/users/${SUB}/recommendations`);
    const { nextCursor } = (await first.json()) as { nextCursor: string };
    expect(typeof nextCursor).toBe("string");

    await app.request(`/admin/users/${SUB}/recommendations?cursor=${nextCursor}`);
    expect(fake.recommendations.listByOwner).toHaveBeenLastCalledWith(SUB, 20, {
      recommendationId: "x",
      ownerId: SUB,
      createdAt: NOW,
    });

    expect((await app.request("/admin/users/not-a-uuid/recommendations")).status).toBe(404);
  });
});
