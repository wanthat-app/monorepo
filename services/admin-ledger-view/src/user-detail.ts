/**
 * Admin user detail — the WALLET tab only (Aurora as `ledger_reader`: balances DERIVED from the
 * ledger exactly like the member's own GET /wallet, plus the newest history page). Read-only by
 * construction — ledger_reader holds SELECT and nothing else (0008). The identity route
 * (GET /admin/users/{sub}) and the recommendations tab are served by the non-VPC admin-console
 * (refactor PR-5: this function reads Aurora records and nothing more).
 */
import { AdminUserWalletResponse, moneyJson, Uuid } from "@wanthat/contracts";
import { listEntriesForSub, listWalletHistory } from "@wanthat/db";
import { deriveBalances } from "@wanthat/domain";
import { Hono } from "hono";
import { getContext } from "./context";
import type { Bindings } from "./guard";

const WALLET_ENTRIES_PAGE = 20;

export function userDetailRouter(): Hono<{ Bindings: Bindings }> {
  const router = new Hono<{ Bindings: Bindings }>();

  // GET /:sub/wallet — balances derived from the member's ledger slice + the newest history page.
  router.get("/:sub/wallet", async (c) => {
    const sub = Uuid.safeParse(c.req.param("sub"));
    if (!sub.success) return c.json({ error: "not_found" }, 404);
    const ctx = getContext();
    const [rows, history] = await Promise.all([
      listEntriesForSub(ctx.db, sub.data),
      listWalletHistory(ctx.db, sub.data, WALLET_ENTRIES_PAGE),
    ]);
    return moneyJson(
      AdminUserWalletResponse.parse({
        balances: deriveBalances(rows),
        entries: {
          items: history.items.map((e) => ({
            id: e.id,
            kind: e.kind,
            amount: { amountMinor: e.amountMinor, currency: e.currency },
            status: e.status,
            recommendationId: e.recommendationId,
            createdAt: e.createdAt.toISOString(),
          })),
          nextCursor: history.nextCursor
            ? Buffer.from(
                JSON.stringify({
                  createdAt: history.nextCursor.createdAt.toISOString(),
                  id: history.nextCursor.id,
                }),
              ).toString("base64url")
            : null,
        },
      }),
    );
  });

  return router;
}
