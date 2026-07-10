import {
  Bps,
  GetWalletResponse,
  ListWalletEntriesQuery,
  ListWalletEntriesResponse,
  type WalletBalance,
  type WalletEstimate,
} from "@wanthat/contracts";
import { listEntriesForSub, listWalletHistory, type WalletHistoryCursor } from "@wanthat/db";
import { convertMinor, deriveBalances } from "@wanthat/domain";
import { Hono } from "hono";
import { type Bindings, subFromClaims } from "../claims";
import { getContext } from "../context";
import { moneyJson } from "../http";

/**
 * Wallet reads for the member home (spec 2026-07-10-conversion-poller-wallet §5). Balances are
 * DERIVED per request from the member's slice of the append-only ledger (`deriveBalances`,
 * exact bigint math) — nothing is stored; the ledger is the only truth (ADR-0002). The `≈₪`
 * headline is a display-only estimate off the cached USD→ILS rate (ADR-0017: hold the settlement
 * currency, convert at display/withdrawal) and is null until a rate is cached.
 */

/** Rewards settle in USD (ADR-0017); ILS is the Israeli MVP's display currency. */
const SETTLEMENT_CURRENCY = "USD";
const DISPLAY_CURRENCY = "ILS";

/** A held amount of exactly nothing, in the display currency. */
const ZERO_ILS = { amountMinor: 0n, currency: DISPLAY_CURRENCY };

/**
 * The display estimate for the USD balance: available and total-pending (both roles) converted
 * with `convertMinor` (cached rate minus the CONFIG conversion commission). No USD held (the
 * empty ledger included) estimates to a hard zero — nothing converts to nothing at any rate —
 * so the SPA hero always has a number to render. Null ONLY when USD is held but no rate is
 * cached yet: the amount is genuinely unknowable and the SPA falls back to per-currency figures.
 */
async function ilsEstimate(balances: WalletBalance[]): Promise<WalletEstimate | null> {
  const usd = balances.find((b) => b.available.currency === SETTLEMENT_CURRENCY);
  if (!usd) return { available: ZERO_ILS, pending: ZERO_ILS };
  const ctx = getContext();
  const [rate, commissionBps] = await Promise.all([
    ctx.fx.get(SETTLEMENT_CURRENCY, DISPLAY_CURRENCY),
    ctx.config.get("fx.conversionCommissionBps"),
  ]);
  if (!rate) return null;
  const bps = Bps.parse(commissionBps);
  const pendingTotal = usd.asRecommender.pending.amountMinor + usd.asBuyer.pending.amountMinor;
  return {
    available: {
      amountMinor: convertMinor(usd.available.amountMinor, rate.rate, bps),
      currency: DISPLAY_CURRENCY,
    },
    pending: {
      amountMinor: convertMinor(pendingTotal, rate.rate, bps),
      currency: DISPLAY_CURRENCY,
    },
  };
}

const cursorOf = (cursor: WalletHistoryCursor | null): string | null =>
  cursor
    ? Buffer.from(
        JSON.stringify({ createdAt: cursor.createdAt.toISOString(), id: cursor.id }),
      ).toString("base64url")
    : null;

const keyOf = (cursor: string | undefined): WalletHistoryCursor | undefined => {
  if (!cursor) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const { createdAt, id } = parsed as { createdAt?: unknown; id?: unknown };
    if (typeof createdAt !== "string" || typeof id !== "string") return undefined;
    const at = new Date(createdAt);
    return Number.isNaN(at.getTime()) ? undefined : { createdAt: at, id };
  } catch {
    return undefined;
  }
};

export function walletRouter(): Hono<{ Bindings: Bindings }> {
  const wallet = new Hono<{ Bindings: Bindings }>();

  // GET /wallet — per-currency balances + the display-only ILS estimate (`≈` in the UI).
  wallet.get("/", async (c) => {
    const sub = subFromClaims(c);
    if (!sub) return c.json({ error: "unauthorized" }, 401);
    const ctx = getContext();
    const balances = deriveBalances(await listEntriesForSub(ctx.db, sub));
    return moneyJson(
      c,
      GetWalletResponse.parse({ balances, estimated: await ilsEstimate(balances) }),
    );
  });

  // GET /wallet/entries — the member's ledger history, newest first (cursor-paginated). The
  // cursor is the base64url keyset key `(createdAt, id)`; a malformed one reads from the top.
  wallet.get("/entries", async (c) => {
    const sub = subFromClaims(c);
    if (!sub) return c.json({ error: "unauthorized" }, 401);
    const query = ListWalletEntriesQuery.safeParse({
      cursor: c.req.query("cursor"),
      limit: c.req.query("limit"),
    });
    if (!query.success) return c.json({ error: "invalid_request" }, 400);
    const ctx = getContext();
    const page = await listWalletHistory(ctx.db, sub, query.data.limit, keyOf(query.data.cursor));
    return moneyJson(
      c,
      ListWalletEntriesResponse.parse({
        items: page.items.map((e) => ({
          id: e.id,
          kind: e.kind,
          amount: { amountMinor: e.amountMinor, currency: e.currency },
          status: e.status,
          recommendationId: e.recommendationId,
          createdAt: e.createdAt.toISOString(),
        })),
        nextCursor: cursorOf(page.nextCursor),
      }),
    );
  });

  return wallet;
}
