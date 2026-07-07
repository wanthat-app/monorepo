-- 0004 admin_api role — a dedicated login role for admin-api (ADR-0002 least-privilege).
-- Until now admin-api connected as app_ro (read-only). The admin users page adds one narrow
-- mutation: hard-deleting a customer that has no money history. The role therefore gets
-- app_ro's read surface plus DELETE on customer only — money tables stay immutable for it
-- (same belt-and-braces REVOKE as 0001).
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'admin_api') THEN CREATE ROLE admin_api LOGIN; END IF;
END $$;

GRANT rds_iam TO admin_api;
GRANT USAGE ON SCHEMA public TO admin_api;

-- Read everything (the stats surface), delete customers (guarded in-handler: refused while any
-- wallet_entry references the row; the FK makes that a hard guarantee besides).
GRANT SELECT ON ALL TABLES IN SCHEMA public TO admin_api;
GRANT DELETE ON customer TO admin_api;

-- Money tables are never mutable/deletable by any app role.
REVOKE UPDATE, DELETE ON wallet_entry, audit_log FROM admin_api;
