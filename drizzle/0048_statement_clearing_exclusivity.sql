-- 0048_statement_clearing_exclusivity.sql
-- A database-level guarantee that a journal line is cleared by AT MOST ONE
-- representation.
--
-- A ledger line can be claimed two ways: the 1:1
-- statement_lines.matched_journal_line_id column, or a split row in
-- statement_line_matches. Each side already has its own unique index
-- (statement_lines_matched_journal_line_unique,
-- statement_line_matches_journal_line_unique) — but the two indexes live on
-- two different tables, so nothing stops the SAME journal line being claimed
-- once on each side. computeFinalizeBalances sums the 1:1 side and the split
-- side independently, so a line claimed by both is counted twice and a
-- reconciliation that is genuinely out of balance can finalize cleanly. The
-- 2026-08 audit rated this the critical reconciliation finding.
--
-- WHY A CONSTRAINT TRIGGER RATHER THAN A UNIQUE INDEX. Uniqueness here spans
-- two tables; no index can express it. DEFERRABLE INITIALLY DEFERRED means
-- the check fires at COMMIT, so application code that moves a line between
-- representations inside one transaction (delete the split rows, then set the
-- 1:1 column) is never transiently invalid.
--
-- Idempotent: safe to re-run (CREATE OR REPLACE + DROP TRIGGER IF EXISTS),
-- matching every other file applied by scripts/apply-tax-foundation.ts.

CREATE OR REPLACE FUNCTION assert_clearing_exclusive_from_statement_line() RETURNS trigger AS $$
BEGIN
  IF NEW.matched_journal_line_id IS NULL THEN
    RETURN NULL;
  END IF;

  IF EXISTS (
    SELECT 1 FROM statement_line_matches slm
    WHERE slm.journal_line_id = NEW.matched_journal_line_id
  ) THEN
    RAISE EXCEPTION
      'journal line % is already cleared by a split match; a ledger line can be cleared exactly once',
      NEW.matched_journal_line_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION assert_clearing_exclusive_from_split_match() RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM statement_lines sl
    WHERE sl.matched_journal_line_id = NEW.journal_line_id
  ) THEN
    RAISE EXCEPTION
      'journal line % is already cleared 1:1 by a statement line; a ledger line can be cleared exactly once',
      NEW.journal_line_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS statement_lines_clearing_exclusive ON statement_lines;
CREATE CONSTRAINT TRIGGER statement_lines_clearing_exclusive
  AFTER INSERT OR UPDATE OF matched_journal_line_id ON statement_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION assert_clearing_exclusive_from_statement_line();

DROP TRIGGER IF EXISTS statement_line_matches_clearing_exclusive ON statement_line_matches;
CREATE CONSTRAINT TRIGGER statement_line_matches_clearing_exclusive
  AFTER INSERT OR UPDATE OF journal_line_id ON statement_line_matches
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION assert_clearing_exclusive_from_split_match();
