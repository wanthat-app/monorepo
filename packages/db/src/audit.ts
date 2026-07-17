import { type Kysely, sql } from "kysely";
import type { Database } from "./schema";

/**
 * The shared audit-chain primitive. `audit_append` (0005, SECURITY DEFINER, advisory-lock
 * serialized) is the ONLY way rows enter the hash-chained `audit_log` — callers hold EXECUTE
 * on the function, never INSERT on the table. Shared by the conversion writer (chaining every
 * landed ledger row) and the audit-writer service (the generic audit event path).
 */

/** Chain one payload into audit_log — the ONLY way rows enter it (advisory-lock serialized). */
export async function appendAudit(db: Kysely<Database>, payload: unknown): Promise<void> {
  await sql`select audit_append(${JSON.stringify(payload)}::jsonb, now())`.execute(db);
}
