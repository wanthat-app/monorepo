-- 0008 service_role_grants — least-privilege grants for the four per-function service roles of
-- the compute-topology refactor (the audit-writer split): wallet_reader (app-core, ledger
-- reads), ledger_reader (admin-api, ledger + audit-feed reads), ledger_writer (the conversion
-- writer, append-only money), audit_writer (the audit-writer Lambda, audit appends only).
--
-- REMEMBER (0004/0006's lesson): migrations run as wanthat_migrator, which has NO CREATEROLE —
-- a CREATE ROLE here fails the deploy. The roles are created OUT-OF-BAND by an operator
-- (runbook R1 in infra/lib/README.md: CREATE ROLE ... LOGIN + GRANT rds_iam + schema USAGE),
-- and R1 must have run in an environment BEFORE this migration deploys there, or it fails with
-- "role does not exist". This migration only GRANTs/REVOKEs on the pre-existing roles.
--
-- The legacy roles (app_rw / app_ro / poller_writer) are deliberately untouched: the deployed
-- Lambdas still connect as them until CDK flips grantConnect + DB_USER per service. A later
-- cleanup migration REVOKEs their privileges ahead of runbook R2 (DROP ROLE).

-- wallet_reader: the member wallet surface — balance + history are SELECTs over the ledger.
GRANT SELECT ON wallet_entry TO wallet_reader;

-- ledger_reader: the admin surface — money stats over the ledger + the audit-log activity feed.
GRANT SELECT ON wallet_entry, audit_log TO ledger_reader;

-- ledger_writer: the conversion writer — append-only money (INSERT; dedup needs the SELECT).
GRANT SELECT, INSERT ON wallet_entry TO ledger_writer;

-- The audit chain is entered ONLY via audit_append (0005, SECURITY DEFINER, advisory-lock
-- serialized): ledger_writer chains every landed ledger row, audit_writer is the generic audit
-- event path. Deliberately NO direct INSERT on audit_log for anyone — the function's definer
-- (wanthat_migrator) owns the table.
GRANT EXECUTE ON FUNCTION audit_append(jsonb, timestamptz) TO ledger_writer, audit_writer;

-- Belt-and-braces (0001/0006 pattern): the ledger and the audit chain are append-only — never
-- mutable or deletable by any service role.
REVOKE UPDATE, DELETE ON wallet_entry, audit_log
  FROM wallet_reader, ledger_reader, ledger_writer, audit_writer;
