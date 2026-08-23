-- 0051 — voiding a posted journal may not smuggle a financial rewrite.
--
-- 0042's forbid_posted_journal_mutation exempted the ENTIRE update whenever
-- NEW.status = 'voided': one UPDATE could void a posted journal AND rewrite
-- its date, amount, currency, type, or party in the same statement, leaving
-- the audit trail claiming the journal was merely voided (2026-08 audit,
-- ledger core). The frozen-field check now applies to every update of a
-- posted row, voiding included. A legitimate void — flipping status and
-- stamping voided_at, optionally annotating memo — touches no frozen field
-- and passes exactly as before.
--
-- Idempotent: CREATE OR REPLACE of the same function name; the trigger from
-- 0042 keeps pointing at it.

CREATE OR REPLACE FUNCTION forbid_posted_journal_mutation() RETURNS trigger AS $$
BEGIN
  IF OLD.status <> 'posted' THEN
    RETURN NEW;
  END IF;

  IF NEW.transaction_date IS DISTINCT FROM OLD.transaction_date
     OR NEW.total_amount IS DISTINCT FROM OLD.total_amount
     OR NEW.functional_currency IS DISTINCT FROM OLD.functional_currency
     OR NEW.transaction_currency IS DISTINCT FROM OLD.transaction_currency
     OR NEW.transaction_type IS DISTINCT FROM OLD.transaction_type
     OR NEW.party_id IS DISTINCT FROM OLD.party_id THEN
    RAISE EXCEPTION
      'journal % is posted and cannot be edited in place; reverse and replace it instead',
      OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
