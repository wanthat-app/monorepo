-- 0003_migrator_role — a dedicated IAM-authenticated role for the db-migrator itself.
--
-- Until now the migrator connected as the MASTER user, read from the cluster's generated Secrets
-- Manager secret — the last in-VPC Secrets Manager read (the other, app-core's ticket key, went
-- asymmetric). This migration is step 1 of retiring that: it creates `wanthat_migrator` so the NEXT
-- deploy can switch the migrator to IAM auth (like app_rw/app_ro/poller_writer) and drop the secret
-- read entirely — after which the VPC needs no secretsmanager interface endpoint.
--
-- This file still runs AS MASTER (the switch happens only after it has been applied — two-deploy
-- sequence). Ownership notes, PostgreSQL 16 semantics:
--  * Master CREATES the role here, so master holds implicit ADMIN OPTION on it (PG16 creator rule)
--    — which is what makes both grants below legal.
--  * Existing tables are OWNED by master; future migrations (run by wanthat_migrator) must be able
--    to ALTER them, so ownership moves to wanthat_migrator. Master stays a member of
--    wanthat_migrator, so master-run operations (and any emergency manual work) keep full access.
--  * Kysely's bookkeeping tables (kysely_migration, kysely_migration_lock) transfer with the same
--    loop — the migrator writes them on every run.
--  * CREATE on the database covers trusted extensions (e.g. pgcrypto, PG13+) in future migrations;
--    a migration ever needing an UNTRUSTED extension is the one case that would still need master.
--
-- NEW-ENVIRONMENT BOOTSTRAP (documented trade-off): a brand-new cluster has no wanthat_migrator
-- until 0001–0003 run, so the very first migration of a NEW env must run as master (one-time manual
-- step / temporarily restoring the master-secret path). Envs are fixed at dev+prod, both migrated.

DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'wanthat_migrator') THEN
    CREATE ROLE wanthat_migrator LOGIN;
  END IF;
END $$;

-- IAM database authentication (same mechanism as the app roles).
GRANT rds_iam TO wanthat_migrator;

-- Master keeps a foot in the door: member of the migrator role (legal: master just created it, so
-- it holds ADMIN OPTION) — needed below for the ownership transfer, and for any manual recovery.
GRANT wanthat_migrator TO CURRENT_USER;

-- Schema + database rights for future DDL (new tables, trusted extensions). The database grant is
-- dynamic — no hardcoded db name to drift from an env's actual database.
GRANT USAGE, CREATE ON SCHEMA public TO wanthat_migrator;
DO $$ BEGIN
  EXECUTE format('GRANT CREATE ON DATABASE %I TO wanthat_migrator', current_database());
END $$;

-- Hand ownership of every master-owned table (app tables + kysely bookkeeping) to the migrator so
-- future ALTERs run without master. Dynamic: no hardcoded table list to rot.
DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tableowner = CURRENT_USER
  LOOP
    EXECUTE format('ALTER TABLE public.%I OWNER TO wanthat_migrator', t.tablename);
  END LOOP;
END $$;
