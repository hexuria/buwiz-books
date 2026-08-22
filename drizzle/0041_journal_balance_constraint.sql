-- 0041_journal_balance_constraint.sql
-- A database-level guarantee that a POSTED journal balances.
--
-- There is no such guarantee anywhere in drizzle/ today. Balance is checked in
-- application code only (src/db/validation/journals.ts), on only some paths —
-- both bill-accrual implementations post without calling it at all — and that
-- check compares JS floats rounded to 2dp against a ledger stored at
-- decimal(20,8), so an amount with more than two decimals can pass validation
-- while the stored journal is out of balance.
--
-- The whole tax subsystem's correctness claim is
-- `Δ control account == Σ tax detail == form total`. That is unenforceable if
-- the underlying journals need not balance.
--
-- WHY A CONSTRAINT TRIGGER RATHER THAN A CHECK. A CHECK sees one row; balance
-- is a property of a header's whole line set. DEFERRABLE INITIALLY DEFERRED
-- means the check fires at COMMIT, so the ordinary insert pattern — header,
-- then lines one at a time — is never transiently invalid.
--
-- SCOPE: posted headers only. Drafts are legitimately unbalanced while being
-- built, and voided headers are excluded from every report anyway.

CREATE OR REPLACE FUNCTION assert_journal_balanced() RETURNS trigger AS $$
DECLARE
  target_header uuid;
  header_status text;
  total_debit numeric(20, 8);
  total_credit numeric(20, 8);
BEGIN
  target_header := COALESCE(NEW.journal_header_id, OLD.journal_header_id);

  SELECT status INTO header_status FROM journal_headers WHERE id = target_header;
  -- The header may already be gone on a cascading delete; nothing to assert.
  IF header_status IS NULL OR header_status <> 'posted' THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE(SUM(debit), 0), COALESCE(SUM(credit), 0)
    INTO total_debit, total_credit
    FROM journal_lines
   WHERE journal_header_id = target_header;

  -- Exact comparison at the stored scale. Rounding to 2dp before comparing is
  -- what lets an 8-decimal imbalance through today.
  IF total_debit <> total_credit THEN
    RAISE EXCEPTION
      'journal % does not balance: debits %, credits %, difference %',
      target_header, total_debit, total_credit, total_debit - total_credit
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Fires on the LINES, because that is what changes. A header flipped to
-- 'posted' after its lines exist is covered by the header trigger below.
DROP TRIGGER IF EXISTS journal_lines_balance_check ON journal_lines;
CREATE CONSTRAINT TRIGGER journal_lines_balance_check
  AFTER INSERT OR UPDATE OR DELETE ON journal_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_journal_balanced();

CREATE OR REPLACE FUNCTION assert_journal_balanced_on_post() RETURNS trigger AS $$
DECLARE
  total_debit numeric(20, 8);
  total_credit numeric(20, 8);
BEGIN
  IF NEW.status <> 'posted' THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE(SUM(debit), 0), COALESCE(SUM(credit), 0)
    INTO total_debit, total_credit
    FROM journal_lines
   WHERE journal_header_id = NEW.id;

  IF total_debit <> total_credit THEN
    RAISE EXCEPTION
      'journal % cannot be posted: debits %, credits %, difference %',
      NEW.id, total_debit, total_credit, total_debit - total_credit
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Catches the other direction: a header promoted to 'posted' whose lines were
-- written earlier and do not balance.
DROP TRIGGER IF EXISTS journal_headers_balance_check ON journal_headers;
CREATE CONSTRAINT TRIGGER journal_headers_balance_check
  AFTER INSERT OR UPDATE OF status ON journal_headers
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_journal_balanced_on_post();
