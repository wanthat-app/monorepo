import type { ColumnType, Generated } from "kysely";

/**
 * Kysely table interfaces — the typed view of the Postgres schema (ADR-0012).
 * Aurora holds only **PII (customer) + money (wallet ledger + audit log)** (ADR-0003);
 * products, recommendations, and guest_attribution live in DynamoDB. Money columns are
 * typed `never` on update to encode the append-only ledger (ADR-0002): the type system
 * refuses `.set(amount_minor)` on those tables.
 */

export interface CustomerTable {
  id: Generated<string>;
  phone_e164: string;
  email: string | null;
  first_name: string;
  last_name: string;
  locale: string;
  status: "active" | "suspended";
  // Stable link to the Cognito user (the `sub` claim). Phone is mutable + the sign-in alias, so it
  // is unsuitable as the join key; this is the canonical identity anchor for /me (0002_auth, ADR-0020).
  // NOT NULL (fail-fast): set at registration, so the type forbids inserting a customer without a sub.
  cognito_sub: string;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface WalletEntryTable {
  id: Generated<string>;
  customer_id: string;
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
  customer: CustomerTable;
  wallet_entry: WalletEntryTable;
  audit_log: AuditLogTable;
}
