import { z } from "zod";
import { IsoDateTime, Money, RecommendationId, Uuid } from "../common";
import { WalletEntryKind, WalletEntryStatus } from "../wallet";

/**
 * The MEMBER activity feed (GET /activity, app-core): one newest-first stream merging the two
 * things a member does or earns — recommendation creations (DynamoDB `byOwner`) and wallet
 * movements (the Aurora ledger). Distinct from the ADMIN activity feed (`./admin`, audit log).
 * The home page shows the first N (CONFIG `home.recentActivityLimit`, applied server-side when
 * no explicit limit is passed); "see all" pages with the opaque composite cursor.
 */

export const RecommendationCreatedActivity = z.object({
  type: z.literal("recommendation_created"),
  recommendationId: RecommendationId,
  title: z.string(),
  imageUrl: z.string().nullable(),
  at: IsoDateTime,
});

export const WalletEntryActivity = z.object({
  type: z.literal("wallet_entry"),
  id: Uuid,
  kind: WalletEntryKind,
  amount: Money,
  status: WalletEntryStatus,
  recommendationId: RecommendationId.nullable(),
  at: IsoDateTime,
});

export const MemberActivityItem = z.discriminatedUnion("type", [
  RecommendationCreatedActivity,
  WalletEntryActivity,
]);
export type MemberActivityItem = z.infer<typeof MemberActivityItem>;

export const ListMemberActivityQuery = z.object({
  /** Absent → the server applies CONFIG `home.recentActivityLimit` (the home strip's size). */
  limit: z.coerce.number().int().min(1).max(50).optional(),
  cursor: z.string().optional(),
});
export type ListMemberActivityQuery = z.infer<typeof ListMemberActivityQuery>;

export const ListMemberActivityResponse = z.object({
  items: z.array(MemberActivityItem),
  nextCursor: z.string().nullable(),
});
export type ListMemberActivityResponse = z.infer<typeof ListMemberActivityResponse>;
