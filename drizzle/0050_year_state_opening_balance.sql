-- 0050_year_state_opening_balance.sql
-- Immutable OPENING columns on payroll_employee_year_state.
--
-- The compute engine now rebuilds year state by REPLAYING the year's computed
-- runs (the persisted YTD columns are derived output, freely rewritten on
-- every compute). An organization migrating mid-year has history that exists
-- in no payroll_lines row — Ms. Grace's eleven periods before go-live — and
-- that history must be an INPUT the replay starts from, never something the
-- next recompute can overwrite. Hence dedicated opening_* columns: written
-- once by an import/migration path, read as the replay base, untouched by
-- the engine's own persistence.

ALTER TABLE payroll_employee_year_state
  ADD COLUMN IF NOT EXISTS opening_periods_elapsed integer,
  ADD COLUMN IF NOT EXISTS opening_ytd_taxable_regular numeric(20, 8),
  ADD COLUMN IF NOT EXISTS opening_ytd_taxable_supplementary numeric(20, 8),
  ADD COLUMN IF NOT EXISTS opening_ytd_tax_withheld numeric(20, 8);
