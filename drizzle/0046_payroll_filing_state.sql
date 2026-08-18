-- 0046_payroll_filing_state.sql
-- Filing state on a payroll run: the snapshot it was filed from, and the BIR
-- reference it was filed under.
--
-- `filing-period.ts` models the state machine and `filing-snapshot.ts` produces
-- the snapshot, but a payroll run had nowhere to record either — so a period
-- could be "filed" only in someone's memory. These three columns are what make
-- the filed state durable and auditable.
--
-- WHY THE CHECKSUM LIVES HERE rather than only in a snapshot table: it is the
-- link between the run and the immutable figures it reported. Losing it means
-- a filed period can no longer prove what it said.

ALTER TABLE payroll_runs
  ADD COLUMN IF NOT EXISTS snapshot_checksum text,
  ADD COLUMN IF NOT EXISTS snapshot_taken_at timestamptz,
  ADD COLUMN IF NOT EXISTS filing_reference text,
  ADD COLUMN IF NOT EXISTS filed_at timestamptz;

-- A snapshot is a checksum AND a time, or neither. Half a snapshot record
-- cannot prove anything, and the half that survives reads as if it could.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'payroll_runs_snapshot_complete'
  ) THEN
    ALTER TABLE payroll_runs
      ADD CONSTRAINT payroll_runs_snapshot_complete
      CHECK (
        (snapshot_checksum IS NULL AND snapshot_taken_at IS NULL)
        OR (snapshot_checksum IS NOT NULL AND snapshot_taken_at IS NOT NULL)
      );
  END IF;

  -- Likewise for the filing itself.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'payroll_runs_filing_complete'
  ) THEN
    ALTER TABLE payroll_runs
      ADD CONSTRAINT payroll_runs_filing_complete
      CHECK (
        (filing_reference IS NULL AND filed_at IS NULL)
        OR (filing_reference IS NOT NULL AND filed_at IS NOT NULL)
      );
  END IF;

  -- A period cannot be filed without the snapshot it was filed FROM. This is
  -- the same rule filing-period.ts enforces in application code; having it in
  -- the database means a path that bypasses that module still cannot produce
  -- a filed period with nothing behind it.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'payroll_runs_filed_needs_snapshot'
  ) THEN
    ALTER TABLE payroll_runs
      ADD CONSTRAINT payroll_runs_filed_needs_snapshot
      CHECK (filing_reference IS NULL OR snapshot_checksum IS NOT NULL);
  END IF;
END $$;

-- One filing reference per organization: the BIR issues one per submission, so
-- two runs claiming the same reference means one of them is not what it says.
CREATE UNIQUE INDEX IF NOT EXISTS payroll_runs_filing_reference_unique
  ON payroll_runs (organization_id, filing_reference)
  WHERE filing_reference IS NOT NULL;
