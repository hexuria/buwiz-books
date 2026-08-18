-- 0043_payroll_run_journal_link.sql
-- Links a payroll run to the journal it posted.
--
-- `payroll_runs` records the computation but had no pointer to the resulting
-- ledger entry, so nothing could tell a posted run from an unposted one and a
-- second posting would silently double the period's payroll expense. The bill
-- and invoice paths carry exactly this column for exactly this reason.

ALTER TABLE payroll_runs
  ADD COLUMN IF NOT EXISTS journal_header_id uuid;

-- Guarded by COLUMN, not by name: drizzle-kit push creates its own FK under a
-- generated name, and a name-based check cannot see it — that is how 0034 and
-- 0035 ended up with duplicate constraints.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.key_column_usage k
      JOIN information_schema.table_constraints t
        ON t.constraint_name = k.constraint_name AND t.constraint_schema = k.constraint_schema
     WHERE k.table_name = 'payroll_runs'
       AND k.column_name = 'journal_header_id'
       AND t.constraint_type = 'FOREIGN KEY'
  ) THEN
    ALTER TABLE payroll_runs
      ADD CONSTRAINT payroll_runs_journal_header_id_fk
      FOREIGN KEY (journal_header_id) REFERENCES journal_headers(id) ON DELETE RESTRICT;
  END IF;
END $$;

-- One run per journal and one journal per run. Without this a retried posting
-- that raced past the application check would leave two payroll journals for
-- one period, each individually balanced and jointly double-counting.
CREATE UNIQUE INDEX IF NOT EXISTS payroll_runs_journal_header_id_unique
  ON payroll_runs (journal_header_id)
  WHERE journal_header_id IS NOT NULL;
