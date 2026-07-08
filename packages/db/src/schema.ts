import type { ColumnType, Generated } from "kysely";

/**
 * Kysely table interfaces — the typed view of the Postgres schema (ADR-0012).
 * Aurora holds **money only** — the wallet ledger + hash-chained audit log, keyed directly by
 * the Cognito `sub` (ADR-0006 decision 4, ADR-0020 as amended). Customer PII lives in Cognito
 * user attributes; products, recommendations, and guest_attribution live in DynamoDB (ADR-0003).
 * Money columns are typed `never` on update to encode the append-only ledger (ADR-0002): the
 * type system refuses `.set(...)` on those tables.
 */

export interface WalletEntryTable {
  id: Generated<string>;
  // The Cognito sub of the member this money belongs to (ADR-0020: sub is the canonical id).
  // No FK — the user store is Cognito; a deleted account leaves its rows keyed by an orphaned
  // sub (pseudonymous history, ADR-0006 decision 8).
  cognito_sub: ColumnType<string, string, never>;
  kind: "referrer_cashback" | "consumer_reward" | "adjustment" | "withdrawal";
  amount_minor: ColumnType<bigint, bigint, never>;
  currency: ColumnType<string, string, never>;
  order_id: ColumnType<string | null, string | null, never>;
  // Soft ref to the recommendation (in DynamoDB) the conversion was attributed to (ADR-0008).
  recommendation_id: ColumnType<string | null, string | null, never>;
  status: ColumnType<"pending" | "confirmed" | "clawback", string, never>;
  created_at: Generated<Date>;
}

export interface AuditLogTable {
  id: Generated<string>;
  prev_hash: string | null;
  entry_hash: string;
  payload: ColumnType<unknown, string, never>;
  created_at: Generated<Date>;
}

export interface Database {
  wallet_entry: WalletEntryTable;
  audit_log: AuditLogTable;
}
