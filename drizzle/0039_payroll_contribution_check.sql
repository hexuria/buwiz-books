-- 0039_payroll_contribution_check.sql
-- Expected statutory contributions on a payroll line, and the variance against
-- what the register reported.
--
-- CLOSES A HOLE IN THE VERIFIER. The withholding computation nets the EMPLOYEE
-- share off gross compensation before selecting the bracket, and until now it
-- netted whatever the register said. So a register built on a wrong SSS
-- deduction produced a wrong taxable base, a wrong tax — and a variance of
-- ZERO, because our computation used the same wrong input. The two errors
-- cancelled and the run reported clean.
--
-- Convergent and order-independent, same as 0034 and 0035: bare ALTER ... ADD
-- COLUMN IF NOT EXISTS, and every CHECK in its own guarded block because
-- drizzle-kit push drops CHECK constraints it cannot express.

ALTER TABLE payroll_lines
  ADD COLUMN IF NOT EXISTS expected_sss_employee_share numeric(20, 8),
  ADD COLUMN IF NOT EXISTS expected_philhealth_employee_share numeric(20, 8),
  ADD COLUMN IF NOT EXISTS expected_pagibig_employee_share numeric(20, 8),
  ADD COLUMN IF NOT EXISTS expected_sss_employer_share numeric(20, 8),
  ADD COLUMN IF NOT EXISTS expected_philhealth_employer_share numeric(20, 8),
  ADD COLUMN IF NOT EXISTS expected_pagibig_employer_share numeric(20, 8),
  -- Employee-side total: expected minus reported. Non-zero means the register's
  -- own deductions disagree with the statutory schedule, which makes the
  -- taxable base wrong independently of any arithmetic error in the tax.
  ADD COLUMN IF NOT EXISTS contribution_variance_amount numeric(20, 8),
  -- Why the check did or did not run. An unchecked line must not look like a
  -- clean one.
  ADD COLUMN IF NOT EXISTS contribution_check_status text,
  -- The monthly basic salary the PhilHealth base was taken from. Recorded
  -- because it is a NARROWER figure than compensation and the most common
  -- source of a wrong premium — a filed number should be re-explainable.
  ADD COLUMN IF NOT EXISTS philhealth_base_used numeric(20, 8);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'payroll_lines_contribution_check_status_valid'
  ) THEN
    ALTER TABLE payroll_lines
      ADD CONSTRAINT payroll_lines_contribution_check_status_valid
      CHECK (contribution_check_status IS NULL OR contribution_check_status IN (
        -- Compared against the statutory schedule.
        'checked',
        -- SSS, PhilHealth and Pag-IBIG are MONTHLY obligations. On a
        -- semi-monthly or weekly run a single period is a fraction of the
        -- monthly amount, and employers split it by differing conventions, so
        -- a per-period comparison would manufacture variances that are not
        -- errors. Skipped until the convention is settled per org.
        'skipped_non_monthly',
        -- The register reported no contribution figures at all, so there is
        -- nothing to compare against — distinct from agreeing.
        'skipped_not_reported'
      ));
  END IF;

  -- A checked line must carry the expectations it was checked against.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'payroll_lines_contribution_check_complete'
  ) THEN
    ALTER TABLE payroll_lines
      ADD CONSTRAINT payroll_lines_contribution_check_complete
      CHECK (
        contribution_check_status IS DISTINCT FROM 'checked'
        OR (
          expected_sss_employee_share IS NOT NULL
          AND expected_philhealth_employee_share IS NOT NULL
          AND expected_pagibig_employee_share IS NOT NULL
          AND contribution_variance_amount IS NOT NULL
        )
      );
  END IF;
END $$;
