import type { Kysely } from "kysely";
import type { Database } from "./schema";

/**
 * Audit-log read access for the admin activity feed (ADR-0003: audit_log is Aurora/money-side).
 * Read-only — every append goes through the audit_append SQL function (0005). Payloads are
 * free-form jsonb; mapping/tolerant-parsing is the caller's job (admin-api), so this layer
 * returns rows verbatim.
 */

export interface AuditLogEntry {
  id: string;
  payload: unknown;
  createdAt: Date;
}

export interface AuditLogPage {
  entries: AuditLogEntry[];
  total: number;
}

export interface ListAuditLogInput {
  /** 1-based. */
  page: number;
  pageSize: number;
}

/** Page through audit_log newest first (`created_at DESC, id DESC` — id breaks timestamp ties). */
export async function listAuditLog(
  db: Kysely<Database>,
  input: ListAuditLogInput,
): Promise<AuditLogPage> {
  const [rows, count] = await Promise.all([
    db
      .selectFrom("audit_log")
      .select(["id", "payload", "created_at"])
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .limit(input.pageSize)
      .offset((input.page - 1) * input.pageSize)
      .execute(),
    db
      .selectFrom("audit_log")
      .select((eb) => eb.fn.countAll<string>().as("count"))
      .executeTakeFirst(),
  ]);

  return {
    entries: rows.map((r) => ({
      id: String(r.id),
      payload: r.payload,
      createdAt: r.created_at,
    })),
    total: Number(count?.count ?? 0),
  };
}
