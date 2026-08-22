-- 0042_journal_amendment_lineage.sql
-- Amend-by-reversal lineage for POSTED journals.
--
-- THE DEFECT THIS CLOSES. A posted journal is freely editable in place today:
-- routes/api/transactions/-_mutations.ts deletes every line and reinserts the
-- replacements with no `status = 'posted'` check, and -_batch.ts bulk-repoints
-- `account_id` on posted lines. The only trace either leaves is an activity-log
-- row. So any tax line the compliance layer writes can be silently mutated or
-- deleted after the fact, and the filed figure and the ledger stop agreeing
-- with nothing in the ledger recording that they ever diverged.
--
-- The correct accounting operation on a posted entry is not mutation — it is a
-- reversal plus a replacement, leaving all three rows permanently readable.
-- These columns record which is which.
--
-- Reports already aggregate `status = 'posted'`, and a reversal is itself
-- posted, so the original and its reversal net to zero without any report
-- needing to learn about amendment.

ALTER TABLE journal_headers
  ADD COLUMN IF NOT EXISTS reverses_header_id uuid,
  ADD COLUMN IF NOT EXISTS replaces_header_id uuid,
  ADD COLUMN IF NOT EXISTS amendment_reason text;

-- Guarded by COLUMN, not by name: drizzle-kit push creates its own FK under a
-- generated name, so a name-based `IF NOT EXISTS` check cannot see it and we
-- end up with two identical constraints (this is how 0034 and 0035 acquired
-- their duplicates).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.key_column_usage k
      JOIN information_schema.table_constraints t
        ON t.constraint_name = k.constraint_name AND t.constraint_schema = k.constraint_schema
     WHERE k.table_name = 'journal_headers'
       AND k.column_name = 'reverses_header_id'
       AND t.constraint_type = 'FOREIGN KEY'
  ) THEN
    ALTER TABLE journal_headers
      ADD CONSTRAINT journal_headers_reverses_header_id_fk
      FOREIGN KEY (reverses_header_id) REFERENCES journal_headers(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.key_column_usage k
      JOIN information_schema.table_constraints t
        ON t.constraint_name = k.constraint_name AND t.constraint_schema = k.constraint_schema
     WHERE k.table_name = 'journal_headers'
       AND k.column_name = 'replaces_header_id'
       AND t.constraint_type = 'FOREIGN KEY'
  ) THEN
    ALTER TABLE journal_headers
      ADD CONSTRAINT journal_headers_replaces_header_id_fk
      FOREIGN KEY (replaces_header_id) REFERENCES journal_headers(id) ON DELETE RESTRICT;
  END IF;
END $$;

-- A header cannot be its own reversal or its own replacement.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'journal_headers_no_self_lineage'
  ) THEN
    ALTER TABLE journal_headers
      ADD CONSTRAINT journal_headers_no_self_lineage
      CHECK (reverses_header_id IS DISTINCT FROM id AND replaces_header_id IS DISTINCT FROM id);
  END IF;
END $$;

-- One reversal per original. Without this, a double-submitted amendment posts
-- two reversals and the original is subtracted twice — the same shape of defect
-- as the bill-void double removal.
CREATE UNIQUE INDEX IF NOT EXISTS journal_headers_one_reversal_per_original
  ON journal_headers (reverses_header_id)
  WHERE reverses_header_id IS NOT NULL AND status <> 'voided';

CREATE INDEX IF NOT EXISTS journal_headers_replaces_header_id_idx
  ON journal_headers (replaces_header_id)
  WHERE replaces_header_id IS NOT NULL;

-- Blocks in-place mutation of a POSTED journal's financial substance at the
-- database level, so a posting path that has not yet been migrated to
-- amend-by-reversal fails loudly rather than silently rewriting history.
--
-- Deliberately NOT frozen: memo, reference_number, status (posted -> voided is
-- legitimate), the duplicate/match pointers, updated_at, and the lineage
-- columns themselves.
CREATE OR REPLACE FUNCTION forbid_posted_journal_mutation() RETURNS trigger AS $$
BEGIN
  IF OLD.status <> 'posted' THEN
    RETURN NEW;
  END IF;

  -- Voiding is the one status change that may accompany anything else.
  IF NEW.status = 'voided' THEN
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

DROP TRIGGER IF EXISTS journal_headers_forbid_posted_mutation ON journal_headers;
CREATE TRIGGER journal_headers_forbid_posted_mutation
  BEFORE UPDATE ON journal_headers
  FOR EACH ROW EXECUTE FUNCTION forbid_posted_journal_mutation();

-- The same protection for the LINES, which is where the real damage was: the
-- mutation path deletes them wholesale and reinserts.
--
-- SCOPE, deliberately narrow. What is frozen is the financial substance of the
-- line — which account, and how much on which side. What stays editable is the
-- analytical tagging (department, location) and the free-text description:
-- re-tagging a posted cost to a different cost centre is a legitimate
-- operation that moves no money, and -_batch.ts's bulk dimension edit does
-- exactly that. Repointing `account_id`, by contrast, moves the amount to a
-- different GL account after the fact, which is the defect.
CREATE OR REPLACE FUNCTION forbid_posted_journal_line_mutation() RETURNS trigger AS $$
DECLARE
  header_status text;
  target_header uuid;
BEGIN
  target_header := COALESCE(NEW.journal_header_id, OLD.journal_header_id);
  SELECT status INTO header_status FROM journal_headers WHERE id = target_header;

  -- Header already gone (cascading delete of a whole journal), or not posted.
  IF header_status IS NULL OR header_status <> 'posted' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'journal % is posted; its lines cannot be deleted — reverse and replace it instead',
      target_header
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.account_id IS DISTINCT FROM OLD.account_id
     OR NEW.debit IS DISTINCT FROM OLD.debit
     OR NEW.credit IS DISTINCT FROM OLD.credit
     OR NEW.journal_header_id IS DISTINCT FROM OLD.journal_header_id THEN
    RAISE EXCEPTION
      'journal % is posted; its lines cannot be re-pointed or re-valued in place — reverse and replace it instead',
      target_header
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- INSERT is absent on purpose: adding lines is how a reversal and its
-- replacement are built, and the balance constraint from 0038 still has to be
-- satisfied at COMMIT, so lines cannot be added to skew an existing journal.
DROP TRIGGER IF EXISTS journal_lines_forbid_posted_mutation ON journal_lines;
CREATE TRIGGER journal_lines_forbid_posted_mutation
  BEFORE UPDATE OR DELETE ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION forbid_posted_journal_line_mutation();
