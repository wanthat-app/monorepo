import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { walletRouter } from "./router";

const app = new Hono();
app.route("/wallet", walletRouter());

const SUB = "11111111-1111-1111-1111-111111111111";
const authed = {
  event: { requestContext: { authorizer: { jwt: { claims: { sub: SUB } } } } },
};

const get = (path: string, env?: object) => app.request(path, { method: "GET" }, env);

describe("GET /wallet", () => {
  it("returns the empty stub wallet with a zero ILS estimate (bigint as wire string)", async () => {
    const res = await get("/wallet", authed);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({
      balances: [],
      estimated: {
        available: { amountMinor: "0", currency: "ILS" },
        pending: { amountMinor: "0", currency: "ILS" },
      },
    });
  });

  it("401s without authorizer claims", async () => {
    expect((await get("/wallet")).status).toBe(401);
  });
});

describe("GET /wallet/entries", () => {
  it("returns an empty page", async () => {
    const res = await get("/wallet/entries?limit=4", authed);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [], nextCursor: null });
  });

  it("400s on an invalid limit", async () => {
    expect((await get("/wallet/entries?limit=oops", authed)).status).toBe(400);
    expect((await get("/wallet/entries?limit=200", authed)).status).toBe(400);
  });

  it("401s without authorizer claims", async () => {
    expect((await get("/wallet/entries")).status).toBe(401);
  });
});
