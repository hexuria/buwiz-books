-- 0053_statement_clearing_commit_state.sql
-- Two corrections to 0048's clearing-exclusivity backstop.
--
-- 1. EXISTING ROWS. 0048 installed write-time triggers and never looked at
--    the rows already in the tables, so a journal line cleared by BOTH
--    representations before 0048 survived it — and computeFinalizeBalances
--    still counts it twice. This file refuses to finish while such a line
--    exists, with the count and the way to list them, instead of reporting
--    success over a double-counted cleared balance. The check runs FIRST and
--    touches nothing, so a refusal changes nothing.
--
--    To list the lines: `bun run db:audit:diagnostics` (read-only; check
--    double_cleared_journal_lines). Each needs a person to decide which claim
--    is real; a finalized reconciliation involved must be reopened first.
--
-- 2. COMMIT-TIME STATE. A deferred constraint trigger fires at COMMIT but
--    receives the NEW tuple captured by the write that queued it. 0048 judged
--    that tuple, so a transaction whose FINAL state was valid could be
--    refused: S1 → line A, then S1 → line B, then a split claiming A failed
--    on the stale "S1 → A" event. Both functions now re-read the row as it
--    stands when the check runs (and pass when the row is gone).
--
-- Idempotent: the check is read-only and the functions are CREATE OR
-- REPLACE; the triggers 0048 created keep pointing at them by name.

DO $$
DECLARE
  overlap_count integer;
BEGIN
  SELECT count(DISTINCT sl.matched_journal_line_id) INTO overlap_count
  FROM statement_lines sl
  JOIN statement_line_matches slm ON slm.journal_line_id = sl.matched_journal_line_id
  WHERE sl.matched_journal_line_id IS NOT NULL;

  IF overlap_count > 0 THEN
    RAISE EXCEPTION
      '% journal line(s) are cleared by both representations (1:1 and split); each is counted twice in the cleared balance. List them with `bun run db:audit:diagnostics` (double_cleared_journal_lines), resolve each, then re-run.',
      overlap_count
      USING ERRCODE = 'check_violation';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION assert_clearing_exclusive_from_statement_line() RETURNS trigger AS $$
DECLARE
  current_line statement_lines.matched_journal_line_id%TYPE;
BEGIN
  -- The row as it stands now, not as the queuing write left it.
  SELECT sl.matched_journal_line_id INTO current_line
  FROM statement_lines sl
  WHERE sl.id = NEW.id;

  IF current_line IS NULL THEN
    RETURN NULL;
  END IF;

  IF EXISTS (
    SELECT 1 FROM statement_line_matches slm
    WHERE slm.journal_line_id = current_line
  ) THEN
    RAISE EXCEPTION
      'journal line % is already cleared by a split match; a ledger line can be cleared exactly once',
      current_line
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION assert_clearing_exclusive_from_split_match() RETURNS trigger AS $$
DECLARE
  current_line statement_line_matches.journal_line_id%TYPE;
BEGIN
  -- The split row as it stands now; a row deleted later in the same
  -- transaction claims nothing.
  SELECT slm.journal_line_id INTO current_line
  FROM statement_line_matches slm
  WHERE slm.id = NEW.id;

  IF current_line IS NULL THEN
    RETURN NULL;
  END IF;

  IF EXISTS (
    SELECT 1 FROM statement_lines sl
    WHERE sl.matched_journal_line_id = current_line
  ) THEN
    RAISE EXCEPTION
      'journal line % is already cleared 1:1 by a statement line; a ledger line can be cleared exactly once',
      current_line
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
