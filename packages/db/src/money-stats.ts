import type { Kysely } from "kysely";
import type { Database } from "./schema";

/**
 * Platform-wide reward rows for the admin money KPIs (spec 2026-07-13). Row-level fetch is
 * deliberate: the derivation (`@wanthat/domain` `deriveMoneyStats`) needs the lifecycle rows,
 * not aggregates — SQL aggregation is the documented future optimization. Unlike wallet.ts
 * `listEntriesForSub` (naturally bounded per member), this query is platform-wide, so it is
 * capped: newest rows first, so if the cap ever bites, the 30-day operational KPIs stay
 * correct and only the all-time totals under-count — with a loud log. No `cognito_sub` on the
 * way out of this module: the platform aggregation is member-anonymous by construction.
 */
export interface RewardRow {
  kind: "referrer_cashback" | "consumer_reward";
  amountMinor: bigint;
  currency: string;
  orderId: string | null;
  status: "pending" | "confirmed" | "clawback";
  createdAt: Date;
}

/** Far above MVP volume (~10MB of rows) but a hard bound on Lambda memory and Aurora transfer. */
export const REWARD_ROWS_CAP = 100_000;

export async function listRewardRows(
  db: Kysely<Database>,
  cap = REWARD_ROWS_CAP,
): Promise<RewardRow[]> {
  const rows = await db
    .selectFrom("wallet_entry")
    .select(["kind", "amount_minor", "currency", "order_id", "status", "created_at"])
    .where("kind", "in", ["referrer_cashback", "consumer_reward"])
    .orderBy("created_at", "desc")
    .limit(cap)
    .execute();
  if (rows.length === cap) {
    console.warn(
      JSON.stringify({
        level: "warn",
        msg: "listRewardRows hit the row cap - all-time money totals under-count; implement the SQL aggregation",
        cap,
      }),
    );
  }
  return rows.map((r) => ({
    kind: r.kind as RewardRow["kind"],
    amountMinor: BigInt(r.amount_minor),
    currency: r.currency,
    orderId: r.order_id,
    status: r.status,
    createdAt: r.created_at,
  }));
}
