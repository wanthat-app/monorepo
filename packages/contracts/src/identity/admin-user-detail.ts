import { z } from "zod";
import { Bps, IsoDateTime } from "../common";
import { ListWalletEntriesResponse, WalletBalance } from "../wallet";
import { AdminUserItem } from "./admin-users";

/**
 * Admin user detail surface: one member's identity (Cognito, served by the non-VPC
 * admin-credentials function), their recommendations (DynamoDB) and their wallet (Aurora as
 * `app_ro`, both served by admin-api). Read-only — moderation stays on the existing routes.
 */

// GET /admin/users/{sub} — one member by canonical id (Cognito ListUsers `sub =` filter).
export const GetAdminUserResponse = z.object({
  user: AdminUserItem,
});
export type GetAdminUserResponse = z.infer<typeof GetAdminUserResponse>;

/** A price/amount in plain wire form (decimal string of minor units) — no bigint leg. */
const AmountWire = z.object({
  amountMinor: z.string().regex(/^-?\d+$/),
  currency: z.string().regex(/^[A-Z]{3}$/),
});

/**
 * One recommendation as the ADMIN sees it. Deliberately NOT the stored projection:
 * `affiliateUrl` never leaves the backend on any API (standing rule) and the owner is implied
 * by the route. The economics shown are the snapshot LOCKED at creation (ADR-0008).
 */
export const AdminUserRecommendationItem = z.object({
  recommendationId: z.string(),
  storeId: z.string(),
  storeProductId: z.string(),
  title: z.string(),
  imageUrl: z.string().nullable(),
  price: AmountWire.nullable(),
  commissionBps: z.number().int(),
  cashback: z.object({ referrerBps: Bps, consumerBps: Bps }),
  review: z
    .object({ rating: z.number().int().min(1).max(5).optional(), text: z.string() })
    .nullable(),
  clicks: z.number().int(),
  conversions: z.number().int(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type AdminUserRecommendationItem = z.infer<typeof AdminUserRecommendationItem>;

// GET /admin/users/{sub}/recommendations — newest first, cursor-paginated.
export const ListAdminUserRecommendationsResponse = z.object({
  items: z.array(AdminUserRecommendationItem),
  nextCursor: z.string().nullable(),
});
export type ListAdminUserRecommendationsResponse = z.infer<
  typeof ListAdminUserRecommendationsResponse
>;

// GET /admin/users/{sub}/wallet — the member's balances + first page of ledger history.
// Money rides the standard wallet wire (bigint in code, decimal string on the wire).
export const AdminUserWalletResponse = z.object({
  balances: z.array(WalletBalance),
  entries: ListWalletEntriesResponse,
});
export type AdminUserWalletResponse = z.infer<typeof AdminUserWalletResponse>;
