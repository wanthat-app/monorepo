-- 0010 drop admin_audit_config_change — the topology refactor replaced the narrow SECURITY
-- DEFINER wrapper (0007) with TypeScript payload shaping in the audit-writer service, which
-- appends through audit_append as the audit_writer role (0008). Nothing calls the wrapper
-- anymore: its sole caller (admin-api as app_ro) is gone, and app_ro itself is retired by the
-- role-bootstrap's R2 step (which runs BEFORE this migration on the deploy — DROP OWNED there
-- already cleared app_ro's EXECUTE grant on this function). wanthat_migrator owns the function
-- (it ran 0007), so the migrator can drop it — no master step needed.
DROP FUNCTION admin_audit_config_change(text, jsonb, jsonb, text);
