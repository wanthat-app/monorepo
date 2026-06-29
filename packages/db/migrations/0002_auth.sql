-- 0002_auth — link the customer (PII) row to its Cognito user (ADR-0020).
--
-- `cognito_sub` is the stable join key between Cognito and the customer: phone is mutable and is the
-- Cognito sign-in alias, so it cannot be the key. `/auth/register` inserts with
-- ON CONFLICT (cognito_sub) DO NOTHING, so the unique index is what makes that idempotent under
-- retries. Nullable because the column is added to an existing table; Postgres allows many NULLs in a
-- UNIQUE index, and every row is written with a non-null sub going forward.
ALTER TABLE customer ADD COLUMN cognito_sub text;
CREATE UNIQUE INDEX customer_cognito_sub_idx ON customer (cognito_sub);

-- app_rw already holds SELECT/INSERT/UPDATE on customer (0001), which covers the new column.
