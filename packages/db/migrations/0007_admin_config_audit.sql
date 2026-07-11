-- 0007 admin_audit_config_change — runtime-config edits become audit events (hash-chained
-- audit_log, ADR-0005 §14). admin-api connects as app_ro, which deliberately holds no EXECUTE
-- on audit_append (0005): appends by the admin role go through narrow SECURITY DEFINER
-- functions that fix the payload shape server-side (the admin_delete_customer precedent), so
-- app_ro can record exactly this event and nothing else. The definer (the migration role,
-- which owns audit_append) chains {type: 'config_changed', key, value, previous, actor}.
CREATE OR REPLACE FUNCTION admin_audit_config_change(
  p_key      text,
  p_value    jsonb,
  p_previous jsonb,
  p_actor    text
)
RETURNS bigint
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT audit_append(jsonb_build_object(
    'type',     'config_changed',
    'key',      p_key,
    'value',    p_value,
    'previous', p_previous,
    'actor',    p_actor
  ));
$$;

REVOKE ALL ON FUNCTION admin_audit_config_change(text, jsonb, jsonb, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_audit_config_change(text, jsonb, jsonb, text) TO app_ro;
