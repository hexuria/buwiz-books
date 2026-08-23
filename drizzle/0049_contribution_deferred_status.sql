-- 0049_contribution_deferred_status.sql
-- Adds 'deferred_month_end' to the contribution-check status vocabulary.
--
-- SSS, PhilHealth and Pag-IBIG are MONTHLY obligations. Semi-monthly payroll
-- (the most common PH cadence) used to record 'skipped_non_monthly' on every
-- half, which wrote NULL expected employer shares and posted ZERO employer
-- contribution expense. The check now runs over the month's combined halves
-- on the run that completes the month; the opening half records
-- 'deferred_month_end' so a pending check never reads as a skipped one.
--
-- Idempotent: drop-and-recreate keyed on the constraint name, matching every
-- other file applied by scripts/apply-tax-foundation.ts.

ALTER TABLE payroll_lines
  DROP CONSTRAINT IF EXISTS payroll_lines_contribution_check_status_valid;

ALTER TABLE payroll_lines
  ADD CONSTRAINT payroll_lines_contribution_check_status_valid
  CHECK (contribution_check_status IS NULL OR contribution_check_status IN (
    'checked',
    'skipped_non_monthly',
    'skipped_not_reported',
    'deferred_month_end'
  ));
