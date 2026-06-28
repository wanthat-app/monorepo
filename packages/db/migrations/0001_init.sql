-- 0001 init — core schema + per-function roles/grants (ADR-0002, ADR-0012).
-- Aurora holds only PII (customer) + money (wallet ledger + audit log) per ADR-0003;
-- product, recommendation, and guest_attribution live in DynamoDB, not here.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE customer (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_e164  text NOT NULL UNIQUE,
  email       text,
  first_name  text NOT NULL,
  last_name   text NOT NULL,
  locale      text NOT NULL,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now() -- maintained by the app on mutation
);

-- Append-only money ledger. A balance is SUM(amount_minor) over confirmed entries.
-- recommendation_id is a soft ref to the recommendation (DynamoDB) the conversion was
-- attributed to (ADR-0008); no FK — it crosses stores.
CREATE TABLE wallet_entry (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id       uuid NOT NULL REFERENCES customer (id),
  kind              text NOT NULL CHECK (kind IN ('referrer_cashback', 'consumer_reward', 'adjustment')),
  amount_minor      bigint NOT NULL,
  currency          text NOT NULL,
  order_id          text,
  recommendation_id text,
  status            text NOT NULL CHECK (status IN ('pending', 'confirmed', 'clawback')),
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX wallet_entry_customer_idx ON wallet_entry (customer_id);
-- Poller idempotency: at most one entry per (order_id, kind).
CREATE UNIQUE INDEX wallet_entry_order_kind_idx
  ON wallet_entry (order_id, kind) WHERE order_id IS NOT NULL;

-- Hash-chained, append-only audit log (tamper-evidence; ADR-0005 §14).
CREATE TABLE audit_log (
  id         bigserial PRIMARY KEY,
  prev_hash  text,
  entry_hash text NOT NULL,
  payload    jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---- Per-function login roles (ADR-0002), authenticated via IAM. ----
--   app_rw        : Lambdalith — read/write app data, READ-ONLY on money tables
--   app_ro        : admin read — read everything
--   poller_writer : conversion poller-writer — APPEND-ONLY on money tables
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_rw') THEN CREATE ROLE app_rw LOGIN; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_ro') THEN CREATE ROLE app_ro LOGIN; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'poller_writer') THEN CREATE ROLE poller_writer LOGIN; END IF;
END $$;

-- Enable IAM database authentication for each login role.
GRANT rds_iam TO app_rw, app_ro, poller_writer;
GRANT USAGE ON SCHEMA public TO app_rw, app_ro, poller_writer;

-- app_rw: full on customer (PII); read-only on money tables.
GRANT SELECT, INSERT, UPDATE ON customer TO app_rw;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_rw;
GRANT SELECT ON wallet_entry, audit_log TO app_rw;

-- app_ro: read everything.
GRANT SELECT ON ALL TABLES IN SCHEMA public TO app_ro;

-- poller_writer: append-only on money tables (no UPDATE/DELETE), read for reconciliation.
GRANT SELECT, INSERT ON wallet_entry, audit_log TO poller_writer;
GRANT USAGE, SELECT ON SEQUENCE audit_log_id_seq TO poller_writer;
GRANT SELECT ON customer TO poller_writer;

-- Belt-and-braces: money tables are never mutable/deletable by any app role.
REVOKE UPDATE, DELETE ON wallet_entry, audit_log FROM app_rw, app_ro, poller_writer;
