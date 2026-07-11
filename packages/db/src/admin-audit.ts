import { type Kysely, sql } from "kysely";
import type { Database } from "./schema";

/**
 * Admin-side audit appends. admin-api connects as `app_ro`, which has no EXECUTE on
 * audit_append (0005) — its appends go through narrow SECURITY DEFINER wrappers that fix the
 * payload shape server-side (0007), so the admin role can record exactly these events and
 * nothing else.
 */

export interface ConfigChangeAudit {
  /** The runtime-config key that was written. */
  key: string;
  /** The new value, as applied. */
  value: unknown;
  /** The effective value before the write (the stored value, or the key's default). */
  previous: unknown;
  /** The acting admin — email from the ID-token claims, falling back to username/sub. */
  actor: string;
}

/** Chain a config_changed event into audit_log via admin_audit_config_change (0007). */
export async function appendConfigChangeAudit(
  db: Kysely<Database>,
  event: ConfigChangeAudit,
): Promise<void> {
  await sql`
    select admin_audit_config_change(
      ${event.key},
      ${JSON.stringify(event.value ?? null)}::jsonb,
      ${JSON.stringify(event.previous ?? null)}::jsonb,
      ${event.actor}
    )
  `.execute(db);
}
