-- 0044_payroll_acknowledgement_note.sql
-- The REASON a client's payroll figures stand despite a variance.
--
-- D-N7: the product files the CLIENT's figure, records the variance and the
-- client's acknowledgement immutably, and refuses to advance while an
-- unacknowledged blocking variance exists. `payroll_runs` recorded WHO
-- acknowledged and WHEN, but not WHY.
--
-- The why is the part that matters under assessment. "The engine said 1,500
-- and we withheld 1,200" is a finding; "we withheld 1,200 because the employee
-- started mid-month and the register prorated" is the answer to it. Without
-- somewhere to put that, the acknowledgement is a click with no content and
-- the audit trail cannot explain itself years later.

ALTER TABLE payroll_runs
  ADD COLUMN IF NOT EXISTS acknowledgement_note text;

-- An acknowledgement must carry all three facts or none. A row with a
-- timestamp and no reason is the empty-click case this column exists to
-- prevent; a reason with no acknowledger is unattributable.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'payroll_runs_acknowledgement_complete'
  ) THEN
    ALTER TABLE payroll_runs
      ADD CONSTRAINT payroll_runs_acknowledgement_complete
      CHECK (
        (acknowledged_at IS NULL AND acknowledged_by IS NULL AND acknowledgement_note IS NULL)
        OR
        (acknowledged_at IS NOT NULL AND acknowledged_by IS NOT NULL
         AND acknowledgement_note IS NOT NULL AND length(trim(acknowledgement_note)) > 0)
      );
  END IF;
END $$;
