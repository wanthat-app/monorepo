-- 0011 scrub_audit_pii — remove member PII from historical user_registered audit payloads
-- (spec docs/superpowers/specs/2026-07-18-audit-pii-free-deleted-user-flow-design.md).
-- The audit log is hash-chained (0005: entry_hash = sha256(prev|payload|epoch)), so editing
-- any payload cascades: EVERY row's hash is recomputed in id order with 0005's exact formula.
-- Idempotent: a re-run rewrites identical payloads to identical hashes. The log is tiny
-- (pre-release), so a full re-chain is milliseconds. Runs as wanthat_migrator, which OWNS
-- audit_log — the UPDATE works despite the revoked table grants (append-only still holds for
-- every service role).
DO $$
DECLARE
  v_prev text := NULL;
  v_payload jsonb;
  v_hash text;
  r record;
BEGIN
  -- Same lock audit_append takes: no append may interleave with the rewrite.
  PERFORM pg_advisory_xact_lock(hashtext('audit_log'));
  FOR r IN SELECT id, payload, created_at FROM audit_log ORDER BY id LOOP
    v_payload := CASE
      WHEN r.payload->>'type' = 'user_registered'
        THEN jsonb_build_object('type', 'user_registered', 'sub', r.payload->>'sub')
      ELSE r.payload
    END;
    v_hash := encode(
      digest(
        coalesce(v_prev, '') || '|' || v_payload::text || '|' || extract(epoch from r.created_at)::text,
        'sha256'
      ),
      'hex'
    );
    UPDATE audit_log SET payload = v_payload, prev_hash = v_prev, entry_hash = v_hash
    WHERE id = r.id;
    v_prev := v_hash;
  END LOOP;
END $$;
