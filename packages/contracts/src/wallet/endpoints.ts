import { z } from "zod";
import { Money, PageQuery, page } from "../common";
import { WalletBalance } from "./balance";
import { WalletEntry } from "./entry";

/**
 * Display-only ILS estimate of the whole wallet (the UI's `≈` headline — never a settled
 * amount): confirmed-available and pending totals converted at cached FX rates. `null` when a
 * held currency has no cached rate; the client then falls back to per-currency figures only.
 */
export const WalletEstimate = z.object({
  available: Money,
  pending: Money,
});
export type WalletEstimate = z.infer<typeof WalletEstimate>;

// GET /wallet — balances for the authenticated member, one entry per currency held, plus the
// display estimate.
export const GetWalletResponse = z.object({
  balances: z.array(WalletBalance),
  estimated: WalletEstimate.nullable(),
});
export type GetWalletResponse = z.infer<typeof GetWalletResponse>;

// GET /wallet/entries — the member's ledger history, newest first (cursor-paginated).
export const ListWalletEntriesQuery = PageQuery;
export type ListWalletEntriesQuery = z.infer<typeof ListWalletEntriesQuery>;

export const ListWalletEntriesResponse = page(WalletEntry);
export type ListWalletEntriesResponse = z.infer<typeof ListWalletEntriesResponse>;
