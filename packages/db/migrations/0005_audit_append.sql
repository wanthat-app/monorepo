-- 0005 audit_append — first implementation of the hash-chained audit log (0001; ADR-0005 §14),
-- plus user deletion/registration becoming audit events and a registration backfill.
--
-- audit_append is THE append path: it serialises writers with an advisory lock (the chain must
-- never fork), reads the previous entry_hash, and chains
--   entry_hash = sha256(prev_hash | payload | created_at)
-- via pgcrypto (enabled in 0001). SECURITY DEFINER (owner: wanthat_migrator) so callers need no
-- table-level INSERT; app_rw (registration writer) gets EXECUTE. app_ro does NOT - admin
-- deletions go through admin_delete_customer below, which calls it in definer context.
-- poller_writer keeps its direct INSERT grant for now; it moves onto audit_append with the
-- poller slice.
CREATE OR REPLACE FUNCTION audit_append(p_payload jsonb, p_at timestamptz DEFAULT now())
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_prev text;
  v_hash text;
  v_id   bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('audit_log'));
  SELECT entry_hash INTO v_prev FROM audit_log ORDER BY id DESC LIMIT 1;
  v_hash := encode(
    digest(coalesce(v_prev, '') || '|' || p_payload::text || '|' || p_at::text, 'sha256'),
    'hex'
  );
  INSERT INTO audit_log (prev_hash, entry_hash, payload, created_at)
  VALUES (v_prev, v_hash, p_payload, p_at)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION audit_append(jsonb, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit_append(jsonb, timestamptz) TO app_rw;
-- audit_append inserts as its owner, so the owner (not the caller) needs the sequence.
-- wanthat_migrator owns the table + sequence already (0003); nothing further to grant.

-- Two-arg admin_delete_customer: same guard/outcome contract as 0004, plus the delete now
-- appends a user_deleted audit row (the deleted identity + acting admin) atomically. The 0004
-- one-arg overload is deliberately LEFT IN PLACE so the running admin-api keeps working during
-- the migrate-then-deploy window (DataStack migrates before AdminStack updates the Lambda);
-- a later cleanup migration drops it.
CREATE OR REPLACE FUNCTION admin_delete_customer(p_customer_id uuid, p_actor text)
RETURNS TABLE (outcome text, phone text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row customer%ROWTYPE;
BEGIN
  IF EXISTS (SELECT 1 FROM wallet_entry w WHERE w.customer_id = p_customer_id) THEN
    RETURN QUERY SELECT 'has_wallet_history'::text, NULL::text;
    RETURN;
  END IF;

  DELETE FROM customer c WHERE c.id = p_customer_id RETURNING c.* INTO v_row;
  IF v_row.id IS NULL THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::text;
    RETURN;
  END IF;

  PERFORM audit_append(jsonb_build_object(
    'type',       'user_deleted',
    'customerId', v_row.id,
    'phone',      v_row.phone_e164,
    'firstName',  v_row.first_name,
    'lastName',   v_row.last_name,
    'email',      v_row.email,
    'actor',      p_actor
  ));

  RETURN QUERY SELECT 'deleted'::text, v_row.phone_e164;
END;
$$;

REVOKE ALL ON FUNCTION admin_delete_customer(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_delete_customer(uuid, text) TO app_ro;

-- Backfill: one user_registered row per existing customer, at their true registration time,
-- in deterministic order (created_at, id) so the chain seeds identically on every environment.
-- created_at carries feed ordering; chain integrity is by id order, so historical timestamps
-- do not break it. Runs once (the migrator tracks applied migrations).
DO $$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT id, phone_e164, first_name, last_name, email, created_at
    FROM customer ORDER BY created_at, id
  LOOP
    PERFORM audit_append(jsonb_build_object(
      'type',       'user_registered',
      'customerId', c.id,
      'phone',      c.phone_e164,
      'firstName',  c.first_name,
      'lastName',   c.last_name,
      'email',      c.email,
      'backfilled', true
    ), c.created_at);
  END LOOP;
END $$;
