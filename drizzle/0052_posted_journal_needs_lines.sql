-- 0052 — a posted journal must have at least one line.
--
-- 0041's balance triggers compare SUM(debit) to SUM(credit); a posted header
-- with ZERO lines passes as 0 = 0 and then appears in the transaction list
-- carrying a total_amount nothing backs (audit diagnostics counted 323 such
-- rows in the accumulated test database). Both 0041 functions gain the
-- emptiness check: posting a header with no lines, and deleting the last
-- line out from under a posted header, now fail at COMMIT.
--
-- Idempotent: CREATE OR REPLACE of the 0041 function names; the deferred
-- constraint triggers keep pointing at them. Existing zero-line rows are
-- data repair — a separately reviewed migration, never this file.

CREATE OR REPLACE FUNCTION assert_journal_balanced() RETURNS trigger AS $$
DECLARE
  target_header uuid;
  header_status text;
  line_count bigint;
  total_debit numeric(20, 8);
  total_credit numeric(20, 8);
BEGIN
  target_header := COALESCE(NEW.journal_header_id, OLD.journal_header_id);

  SELECT status INTO header_status FROM journal_headers WHERE id = target_header;
  -- The header may already be gone on a cascading delete; nothing to assert.
  IF header_status IS NULL OR header_status <> 'posted' THEN
    RETURN NULL;
  END IF;

  SELECT COUNT(*), COALESCE(SUM(debit), 0), COALESCE(SUM(credit), 0)
    INTO line_count, total_debit, total_credit
    FROM journal_lines
   WHERE journal_header_id = target_header;

  IF line_count = 0 THEN
    RAISE EXCEPTION
      'journal % is posted and must keep at least one line',
      target_header
      USING ERRCODE = 'check_violation';
  END IF;

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

CREATE OR REPLACE FUNCTION assert_journal_balanced_on_post() RETURNS trigger AS $$
DECLARE
  line_count bigint;
  total_debit numeric(20, 8);
  total_credit numeric(20, 8);
BEGIN
  IF NEW.status <> 'posted' THEN
    RETURN NULL;
  END IF;

  SELECT COUNT(*), COALESCE(SUM(debit), 0), COALESCE(SUM(credit), 0)
    INTO line_count, total_debit, total_credit
    FROM journal_lines
   WHERE journal_header_id = NEW.id;

  IF line_count = 0 THEN
    RAISE EXCEPTION
      'journal % cannot be posted without lines',
      NEW.id
      USING ERRCODE = 'check_violation';
  END IF;

  IF total_debit <> total_credit THEN
    RAISE EXCEPTION
      'journal % cannot be posted: debits %, credits %, difference %',
      NEW.id, total_debit, total_credit, total_debit - total_credit
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
