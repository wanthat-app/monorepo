-- 0006 money_only — Aurora goes money-only (ADR-0006 decision 4, amending ADR-0003 + ADR-0020).
--
-- All customer PII now lives in Cognito user attributes; nothing on the authentication path
-- touches Aurora. The ledger is keyed by the Cognito `sub` DIRECTLY (ADR-0020 as amended):
-- there is no customer row to resolve through, so the `customer` table is dropped along with
-- everything that existed solely to serve it (the admin hard-delete functions of 0004/0005).
--
-- Pre-release drop-and-recreate: dev data is wiped (the pool and recommendations are empty) and
-- prod has no users, so `wallet_entry` is recreated empty rather than migrated. `audit_log` is
-- untouched — it is the append-only hash chain (ADR-0005 §14) and has no customer column;
-- historical payloads keep their old `customerId` fields as inert data.
--
-- REMEMBER (0004's lesson): migrations run as wanthat_migrator, which has no CREATEROLE — only
-- grants on the roles master created in 0001 (app_rw / app_ro / poller_writer).

-- The admin hard-delete functions existed solely to delete customer rows under a wallet-history
-- guard. Account removal is now AdminDeleteUser + the DynamoDB recommendation erasure
-- (admin-credentials, ADR-0006 decision 8), and the guard is moot: a deleted account's ledger
-- rows deliberately remain, keyed by a now-orphaned sub — pseudonymous money history.
DROP FUNCTION admin_delete_customer(uuid);
DROP FUNCTION admin_delete_customer(uuid, text);

-- Re-key the ledger. wallet_entry goes first (it holds the FK into customer), then the PII table
-- itself. The recreated table is identical to 0001's except `customer_id uuid REFERENCES customer`
-- becomes `cognito_sub text` — no FK: the user store is Cognito, which no SQL constraint can
-- reach. Everything in 0001's ledger contract still holds: each row is one immutable event, a
-- reward advances pending → confirmed → clawback as SEPARATE rows per (order_id, kind), the
-- balance is derived (never stored), recommendation_id is a soft cross-store ref (ADR-0008), and
-- adjustment/withdrawal are standalone events with order_id NULL.
DROP TABLE wallet_entry;
DROP TABLE customer;

CREATE TABLE wallet_entry (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The Cognito sub of the member this money belongs to (ADR-0020: sub is the canonical id).
  cognito_sub       text NOT NULL,
  kind              text NOT NULL CHECK (kind IN ('referrer_cashback', 'consumer_reward', 'adjustment', 'withdrawal')),
  amount_minor      bigint NOT NULL,
  currency          text NOT NULL,
  order_id          text,
  recommendation_id text,
  status            text NOT NULL CHECK (status IN ('pending', 'confirmed', 'clawback')),
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX wallet_entry_sub_idx ON wallet_entry (cognito_sub);
-- Poller idempotency + lifecycle (0001, unchanged): at most one row per (order_id, kind, status),
-- so a reward advances through states as distinct append-only rows while a re-read of an
-- unchanged order no-ops. Standalone events (order_id NULL) are exempt.
CREATE UNIQUE INDEX wallet_entry_order_kind_status_idx
  ON wallet_entry (order_id, kind, status) WHERE order_id IS NOT NULL;

-- Grants — 0001's pattern; DROP TABLE took the old grants with it. app_rw (app-core, now the
-- wallet service) reads the ledger; app_ro (admin) reads everything; poller_writer stays the
-- sole money writer, append-only.
GRANT SELECT ON wallet_entry TO app_rw, app_ro;
GRANT SELECT, INSERT ON wallet_entry TO poller_writer;
-- Belt-and-braces (0001): the ledger is never mutable/deletable by any app role.
REVOKE UPDATE, DELETE ON wallet_entry FROM app_rw, app_ro, poller_writer;

-- audit_append hygiene: app_rw's only audited event (user_registered, written by
-- /auth/register) died with the customer table — registration no longer touches Aurora
-- (ADR-0006 decision 3) — so its EXECUTE grant goes. The poller-writer takes it instead: 0005
-- parked "poller_writer moves onto audit_append with the poller slice", and this re-key is the
-- moment its grant surface is being restated anyway. Its direct INSERT on audit_log (0001)
-- remains until the conversion slice switches it over.
REVOKE EXECUTE ON FUNCTION audit_append(jsonb, timestamptz) FROM app_rw;
GRANT EXECUTE ON FUNCTION audit_append(jsonb, timestamptz) TO poller_writer;
