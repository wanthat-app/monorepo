import type { WalletBalanceWire, WalletEstimateWire } from "../../lib/api";

/** The GET /wallet response shape — also what the stale-cache stores for kind "wallet". */
export interface WalletWire {
  balances: WalletBalanceWire[];
  estimated: WalletEstimateWire | null;
}

export type WalletRender =
  | { kind: "fresh"; data: WalletWire }
  | { kind: "stale"; data: WalletWire }
  | { kind: "skeleton" }
  | { kind: "error" };

/**
 * The balance card's state table (spec 2026-07-21-cold-start-cache): fresh data always wins;
 * a cache hit covers BOTH pending and error (the query keeps retrying silently underneath);
 * without a cache the card behaves exactly as before this feature.
 */
export function selectWalletRender(
  q: { data: WalletWire | undefined; isError: boolean },
  cached: WalletWire | null,
): WalletRender {
  if (q.data) return { kind: "fresh", data: q.data };
  if (cached) return { kind: "stale", data: cached };
  return q.isError ? { kind: "error" } : { kind: "skeleton" };
}
