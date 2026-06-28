import { z } from "zod";
import { PageQuery, page } from "../common";
import { WalletBalance } from "./balance";
import { WalletEntry } from "./entry";

// GET /wallet — balances for the authenticated member, one entry per currency held.
export const GetWalletResponse = z.object({ balances: z.array(WalletBalance) });
export type GetWalletResponse = z.infer<typeof GetWalletResponse>;

// GET /wallet/entries — the member's ledger history, newest first (cursor-paginated).
export const ListWalletEntriesQuery = PageQuery;
export type ListWalletEntriesQuery = z.infer<typeof ListWalletEntriesQuery>;

export const ListWalletEntriesResponse = page(WalletEntry);
export type ListWalletEntriesResponse = z.infer<typeof ListWalletEntriesResponse>;
