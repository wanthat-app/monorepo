import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted fakes so the vi.mock factory can close over them (vitest hoists vi.mock above imports).
const { fake } = vi.hoisted(() => ({
  fake: {
    unattributedOrders: { listByState: vi.fn(), claim: vi.fn(), dismiss: vi.fn(), get: vi.fn() },
    recommendations: { get: vi.fn() },
  },
}));

vi.mock("./context", () => ({ getContext: () => fake }));

import { unattributedRouter } from "./unattributed";

const app = new Hono();
app.route("/admin/orders/unattributed", unattributedRouter());

const NOW = "2026-07-10T15:00:00.000Z";
const ITEM = {
  orderId: "1121635427126421",
  reason: "no_ref",
  orderStatus: "Payment Completed",
  commissionMinor: "37",
  currency: "USD",
  occurredAt: "2026-07-09T05:17:21.000Z",
  productId: "1005004280800180",
  productTitle: "8K HDMI Cable",
  productImageUrl: "https://ae-pic-a1.aliexpress-media.com/kf/img.jpg",
  productDetailUrl: "https://www.aliexpress.com/item/1005004280800180.html",
  productCount: 1,
  paidAmountMinor: "535",
  commissionRate: "7.00%",
  subOrderId: "1121635427136421",
  firstSeenAt: NOW,
  lastSeenAt: NOW,
  state: "open",
  claim: null,
  settledAt: null,
};

const VIEW = {
  orderId: ITEM.orderId,
  reason: "no_ref",
  orderStatus: "Payment Completed",
  amount: { amountMinor: "37", currency: "USD" },
  product: {
    productId: ITEM.productId,
    title: ITEM.productTitle,
    imageUrl: ITEM.productImageUrl,
    detailUrl: ITEM.productDetailUrl,
    count: 1,
  },
  paidAmount: { amountMinor: "535", currency: "USD" },
  commissionRate: "7.00%",
  subOrderId: ITEM.subOrderId,
  occurredAt: ITEM.occurredAt,
  firstSeenAt: NOW,
  lastSeenAt: NOW,
  state: "open",
  claim: null,
  settledAt: null,
};

const adminEnv = {
  event: {
    requestContext: {
      authorizer: { jwt: { claims: { email: "dennis@wanthat.app", "cognito:groups": "[admin]" } } },
    },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /admin/orders/unattributed", () => {
  it("lists the requested state as views (amount from the stored strings)", async () => {
    fake.unattributedOrders.listByState.mockResolvedValue({ items: [ITEM], lastKey: undefined });
    const res = await app.request("/admin/orders/unattributed?state=open", {}, adminEnv);
    expect(res.status).toBe(200);
    expect(fake.unattributedOrders.listByState).toHaveBeenCalledWith("open", 50, undefined);
    expect(await res.json()).toEqual({ items: [VIEW], nextCursor: null });
  });

  it("defaults to open, round-trips the cursor, 400s an invalid state", async () => {
    fake.unattributedOrders.listByState.mockResolvedValue({
      items: [],
      lastKey: { orderId: "x", state: "open", firstSeenAt: NOW },
    });
    const first = await app.request("/admin/orders/unattributed", {}, adminEnv);
    expect(fake.unattributedOrders.listByState).toHaveBeenCalledWith("open", 50, undefined);
    const { nextCursor } = (await first.json()) as { nextCursor: string };
    expect(typeof nextCursor).toBe("string");

    await app.request(`/admin/orders/unattributed?cursor=${nextCursor}`, {}, adminEnv);
    expect(fake.unattributedOrders.listByState).toHaveBeenLastCalledWith("open", 50, {
      orderId: "x",
      state: "open",
      firstSeenAt: NOW,
    });

    expect((await app.request("/admin/orders/unattributed?state=nope", {}, adminEnv)).status).toBe(
      400,
    );
  });
});

describe("GET /admin/orders/unattributed/:orderId", () => {
  it("answers the full detail view; 404 when unknown", async () => {
    fake.unattributedOrders.get.mockResolvedValueOnce(ITEM);
    const res = await app.request(`/admin/orders/unattributed/${ITEM.orderId}`, {}, adminEnv);
    expect(res.status).toBe(200);
    expect(fake.unattributedOrders.get).toHaveBeenCalledWith(ITEM.orderId);
    expect(await res.json()).toEqual({ item: VIEW });

    fake.unattributedOrders.get.mockResolvedValueOnce(undefined);
    expect((await app.request("/admin/orders/unattributed/nope", {}, adminEnv)).status).toBe(404);
  });
});

describe("POST /admin/orders/unattributed/:orderId/claim", () => {
  const claim = (body: unknown) =>
    app.request(
      `/admin/orders/unattributed/${ITEM.orderId}/claim`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      adminEnv,
    );

  it("validates the recommendation exists, claims with the admin's email as actor", async () => {
    fake.recommendations.get.mockResolvedValue({ recommendationId: "abc123DEF45" });
    fake.unattributedOrders.claim.mockResolvedValue({
      ...ITEM,
      state: "claimed",
      claim: { recommendationId: "abc123DEF45", claimedBy: "dennis@wanthat.app", claimedAt: NOW },
    });
    const res = await claim({ recommendationId: "abc123DEF45" });
    expect(res.status).toBe(200);
    expect(fake.unattributedOrders.claim).toHaveBeenCalledWith(
      ITEM.orderId,
      { recommendationId: "abc123DEF45", claimedBy: "dennis@wanthat.app" },
      expect.any(String),
    );
    const body = (await res.json()) as { item: { state: string } };
    expect(body.item.state).toBe("claimed");
  });

  it("404s an unknown recommendation without touching the item", async () => {
    fake.recommendations.get.mockResolvedValue(undefined);
    expect((await claim({ recommendationId: "abc123DEF45" })).status).toBe(404);
    expect(fake.unattributedOrders.claim).not.toHaveBeenCalled();
  });

  it("409s a conflicting claim (settled/dismissed/missing/no commission)", async () => {
    fake.recommendations.get.mockResolvedValue({ recommendationId: "abc123DEF45" });
    fake.unattributedOrders.claim.mockResolvedValue(undefined);
    expect((await claim({ recommendationId: "abc123DEF45" })).status).toBe(409);
  });

  it("400s a malformed body", async () => {
    expect((await claim({})).status).toBe(400);
  });
});

describe("POST /admin/orders/unattributed/:orderId/dismiss", () => {
  it("dismisses and answers the new state; 409 on conflict", async () => {
    fake.unattributedOrders.dismiss.mockResolvedValueOnce({ ...ITEM, state: "dismissed" });
    const ok = await app.request(
      `/admin/orders/unattributed/${ITEM.orderId}/dismiss`,
      { method: "POST" },
      adminEnv,
    );
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { item: { state: string } }).item.state).toBe("dismissed");

    fake.unattributedOrders.dismiss.mockResolvedValueOnce(undefined);
    const conflict = await app.request(
      `/admin/orders/unattributed/${ITEM.orderId}/dismiss`,
      { method: "POST" },
      adminEnv,
    );
    expect(conflict.status).toBe(409);
  });
});
