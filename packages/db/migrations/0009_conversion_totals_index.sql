-- 0009 conversion_totals_index — the derived conversions projection (refactor PR-6).
--
-- The recommendation's `conversions` stat (DynamoDB) stopped being an incremented counter and
-- became a projection DERIVED from the ledger: after each batch the writer answers, per touched
-- recommendation, the absolute `count(DISTINCT order_id)` of its `referrer_cashback` rows, and
-- the settlement applies that as an idempotent SET. That query filters on `recommendation_id`
-- within one kind, so give it a partial index (0001's naming style, `wallet_entry_*_idx`) —
-- partial on kind because only `referrer_cashback` rows ever feed the stat (one per order per
-- status; consumer/adjustment/withdrawal rows are irrelevant to it).
CREATE INDEX wallet_entry_recommendation_referrer_idx
  ON wallet_entry (recommendation_id) WHERE kind = 'referrer_cashback';
