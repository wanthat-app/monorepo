-- 0004 admin_delete_customer — the users page's guarded hard delete, as a SECURITY DEFINER
-- function instead of a new role.
--
-- Why not a role: migrations run as wanthat_migrator (0003), which owns the tables but holds no
-- CREATEROLE — `CREATE ROLE admin_api` fails with "permission denied to create role" (this bit a
-- deploy). Migrations can therefore never mint roles; anything role-shaped must be expressible as
-- grants on what already exists, or as owner-privileged functions like this one.
--
-- The function runs with its owner's rights (wanthat_migrator owns customer per 0003), performs
-- the wallet-history guard and the delete in ONE statement-level transaction (no TOCTOU between
-- guard and delete), and is the only mutation exposed to app_ro — the admin role stays read-only
-- at the table level. The wallet_entry FK independently refuses orphaning if the guard is ever
-- bypassed.
CREATE OR REPLACE FUNCTION admin_delete_customer(p_customer_id uuid)
RETURNS TABLE (outcome text, phone text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_phone text;
BEGIN
  IF EXISTS (SELECT 1 FROM wallet_entry w WHERE w.customer_id = p_customer_id) THEN
    RETURN QUERY SELECT 'has_wallet_history'::text, NULL::text;
    RETURN;
  END IF;

  DELETE FROM customer c WHERE c.id = p_customer_id RETURNING c.phone_e164 INTO v_phone;
  IF v_phone IS NULL THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::text;
    RETURN;
  END IF;

  RETURN QUERY SELECT 'deleted'::text, v_phone;
END;
$$;

-- Only the admin surface may call it.
REVOKE ALL ON FUNCTION admin_delete_customer(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_delete_customer(uuid) TO app_ro;
