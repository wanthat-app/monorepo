import {
  GetWalletResponse,
  ListWalletEntriesQuery,
  ListWalletEntriesResponse,
} from "@wanthat/contracts";
import { Hono } from "hono";
import { type Bindings, subFromClaims } from "../claims";
import { moneyJson } from "../http";

/**
 * Wallet reads for the member home (spec 2026-07-07-member-home). STUB: the contract, routes and
 * auth guard are final, but the data is a fixed empty wallet — the ledger aggregation and the FX
 * estimate land with the AliExpress conversion-poller slice (the first writer of wallet entries).
 * Only the internals of these handlers change then; the SPA and the wire shape do not.
 */
export function walletRouter(): Hono<{ Bindings: Bindings }> {
  const wallet = new Hono<{ Bindings: Bindings }>();

  // GET /wallet — per-currency balances + the display-only ILS estimate (`≈` in the UI).
  wallet.get("/", (c) => {
    const sub = subFromClaims(c);
    if (!sub) return c.json({ error: "unauthorized" }, 401);
    const zero = { amountMinor: 0n, currency: "ILS" };
    return moneyJson(
      c,
      GetWalletResponse.parse({ balances: [], estimated: { available: zero, pending: zero } }),
    );
  });

  // GET /wallet/entries — the member's ledger history, newest first (cursor-paginated).
  wallet.get("/entries", (c) => {
    const sub = subFromClaims(c);
    if (!sub) return c.json({ error: "unauthorized" }, 401);
    const query = ListWalletEntriesQuery.safeParse({
      cursor: c.req.query("cursor"),
      limit: c.req.query("limit"),
    });
    if (!query.success) return c.json({ error: "invalid_request" }, 400);
    return moneyJson(c, ListWalletEntriesResponse.parse({ items: [], nextCursor: null }));
  });

  return wallet;
}
