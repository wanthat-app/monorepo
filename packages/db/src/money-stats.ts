import type { Kysely } from "kysely";
import type { Database } from "./schema";

/**
 * Platform-wide reward rows for the admin money KPIs (spec 2026-07-13). Fetch-all is deliberate:
 * MVP volumes are bounded (same justification as wallet.ts `listEntriesForSub`) and the
 * derivation (`@wanthat/domain` `deriveMoneyStats`) needs the lifecycle rows, not aggregates —
 * SQL aggregation is the documented future optimization. No `cognito_sub` on the way out of
 * this module: the platform aggregation is member-anonymous by construction.
 */
export interface RewardRow {
  kind: "referrer_cashback" | "consumer_reward";
  amountMinor: bigint;
  currency: string;
  orderId: string | null;
  status: "pending" | "confirmed" | "clawback";
  createdAt: Date;
}

export async function listRewardRows(db: Kysely<Database>): Promise<RewardRow[]> {
  const rows = await db
    .selectFrom("wallet_entry")
    .select(["kind", "amount_minor", "currency", "order_id", "status", "created_at"])
    .where("kind", "in", ["referrer_cashback", "consumer_reward"])
    .execute();
  return rows.map((r) => ({
    kind: r.kind as RewardRow["kind"],
    amountMinor: BigInt(r.amount_minor),
    currency: r.currency,
    orderId: r.order_id,
    status: r.status,
    createdAt: r.created_at,
  }));
}
