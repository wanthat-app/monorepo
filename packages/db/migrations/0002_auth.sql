-- 0002_auth — link the customer (PII) row to its Cognito user (ADR-0020).
--
-- `cognito_sub` is the stable join key between Cognito and the customer: phone is mutable and is the
-- Cognito sign-in alias, so it cannot be the key. `/auth/register` inserts with
-- ON CONFLICT (cognito_sub) DO NOTHING, so the unique index is what makes that idempotent under
-- retries. NOT NULL by design (fail-fast, ADR-0020): every customer is provisioned with its Cognito
-- `sub` at registration, so a row that lacks one is a bug — the DB rejects it at INSERT and the
-- registration retries, rather than silently persisting an unlinkable PII row. Safe to add NOT NULL
-- with no default/backfill because `customer` has no rows yet (0001 creates the table empty).
ALTER TABLE customer ADD COLUMN cognito_sub text NOT NULL;
CREATE UNIQUE INDEX customer_cognito_sub_idx ON customer (cognito_sub);

-- app_rw already holds SELECT/INSERT/UPDATE on customer (0001), which covers the new column.
