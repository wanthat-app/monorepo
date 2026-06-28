import type { ColumnType, Generated } from "kysely";

/**
 * Kysely table interfaces — the typed view of the Postgres schema (ADR-0012).
 * Money columns are typed `never` on update to encode the append-only ledger
 * (ADR-0002): the type system refuses `.set(amount_minor)` on these tables.
 */

export interface CustomerTable {
  id: Generated<string>;
  phone_e164: string;
  email: string;
  first_name: string;
  last_name: string;
  locale: ColumnType<string, string | undefined, string>;
  status: "active" | "suspended";
  created_at: Generated<Date>;
}

export interface LinkTable {
  id: Generated<string>;
  short_id: string;
  owner_customer_id: string;
  affiliate_url: string;
  product_name: string | null;
  image_url: string | null;
  created_at: Generated<Date>;
}

export interface WalletEntryTable {
  id: Generated<string>;
  customer_id: string;
  kind: "referrer_cashback" | "consumer_reward" | "adjustment";
  amount_minor: ColumnType<bigint, bigint, never>;
  currency: ColumnType<string, string | undefined, never>;
  order_id: ColumnType<string | null, string | null, never>;
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
  link: LinkTable;
  wallet_entry: WalletEntryTable;
  audit_log: AuditLogTable;
}
