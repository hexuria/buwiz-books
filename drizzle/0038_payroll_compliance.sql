-- 0038_payroll_compliance.sql
-- Payroll compliance tables (Stage 5a of docs/tax/IMPLEMENTATION-PLAN.md).
--
-- ORDER-INDEPENDENT AND CONVERGENT, for the same reason as 0034: this file runs
-- BEFORE `drizzle-kit push --force` on deploy (push prompts interactively for
-- brand-new tables and hangs a non-TTY deploy) and AFTER the reset+push on
-- db:fresh (which drops the schema, so push creates the tables from the Drizzle
-- mirror — but push also emits DROP CONSTRAINT for every CHECK, which Drizzle
-- cannot express, so this file must reinstall them).
--
-- Hence: bare CREATE TABLE IF NOT EXISTS, then every constraint in its own
-- guarded block. Inline constraints would be silently skipped on a table push
-- already created.

-- ============================================================================
-- Tables (bare — constraints follow)
-- ============================================================================

CREATE TABLE IF NOT EXISTS payroll_previous_employer_2316 (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id           text NOT NULL,
  employee_party_id         uuid NOT NULL,
  taxable_year              integer NOT NULL,
  previous_employer_tin     text,
  previous_employer_name    text NOT NULL,
  taxable_compensation      numeric(20, 8) NOT NULL,
  tax_withheld              numeric(20, 8) NOT NULL,
  non_taxable_compensation  numeric(20, 8),
  mwe_compensation          numeric(20, 8),
  -- The cumulative-average Step 2 divisor contribution. Explicit, never derived
  -- from the employment dates: an employment gap makes the calendar reading
  -- wrong, which is IMPLEMENTATION-PLAN.md blocker B4.
  periods_covered           integer NOT NULL,
  employment_from           date NOT NULL,
  employment_to             date NOT NULL,
  document_id               uuid,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payroll_employee_year_state (
  id                                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id                     text NOT NULL,
  employee_party_id                   uuid NOT NULL,
  taxable_year                        integer NOT NULL,
  withholding_method                  text NOT NULL DEFAULT 'regular',
  latched_reason                      text,
  latched_at_period_end               date,
  ytd_taxable_regular                 numeric(20, 8) NOT NULL DEFAULT 0,
  ytd_taxable_supplementary           numeric(20, 8) NOT NULL DEFAULT 0,
  ytd_non_taxable                     numeric(20, 8) NOT NULL DEFAULT 0,
  ytd_tax_withheld                    numeric(20, 8) NOT NULL DEFAULT 0,
  ytd_13th_month_and_other_benefits   numeric(20, 8) NOT NULL DEFAULT 0,
  ytd_de_minimis_by_type              text,
  periods_elapsed                     integer NOT NULL DEFAULT 0,
  is_pre_migration                    boolean NOT NULL DEFAULT false,
  opening_balance_as_of               date,
  reference_dataset_version           text,
  created_at                          timestamptz NOT NULL DEFAULT now(),
  updated_at                          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payroll_runs (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id            text NOT NULL,
  taxable_year               integer NOT NULL,
  payroll_period             text NOT NULL,
  period_start               date NOT NULL,
  period_end                 date NOT NULL,
  period_index               integer NOT NULL,
  status                     text NOT NULL DEFAULT 'draft',
  is_annualization_run       boolean NOT NULL DEFAULT false,
  import_source              text,
  imported_document_id       uuid,
  reference_dataset_version  text,
  computed_at                timestamptz,
  acknowledged_at            timestamptz,
  acknowledged_by            text,
  locked_at                  timestamptz,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payroll_lines (
  id                                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id                   text NOT NULL,
  payroll_run_id                    uuid NOT NULL,
  employee_party_id                 uuid NOT NULL,
  basic_salary                      numeric(20, 8) NOT NULL DEFAULT 0,
  representation_allowance          numeric(20, 8),
  transportation_allowance          numeric(20, 8),
  cost_of_living_allowance          numeric(20, 8),
  fixed_housing_allowance           numeric(20, 8),
  other_taxable_regular             numeric(20, 8),
  commission                        numeric(20, 8),
  profit_sharing                    numeric(20, 8),
  directors_fees                    numeric(20, 8),
  overtime_pay                      numeric(20, 8),
  hazard_pay                        numeric(20, 8),
  other_taxable_supplementary       numeric(20, 8),
  basic_salary_mwe                  numeric(20, 8),
  holiday_pay_mwe                   numeric(20, 8),
  overtime_pay_mwe                  numeric(20, 8),
  night_shift_differential_mwe      numeric(20, 8),
  hazard_pay_mwe                    numeric(20, 8),
  hazard_pay_dole_certification_ref text,
  thirteenth_month_and_other_benefits numeric(20, 8),
  de_minimis_benefits               numeric(20, 8),
  de_minimis_by_type                text,
  non_taxable_retirement_separation numeric(20, 8),
  other_exempt                      numeric(20, 8),
  sss_employee_share                numeric(20, 8),
  philhealth_employee_share         numeric(20, 8),
  pagibig_employee_share            numeric(20, 8),
  union_dues                        numeric(20, 8),
  reported_tax_withheld             numeric(20, 8),
  computed_tax_withheld             numeric(20, 8),
  variance_amount                   numeric(20, 8),
  variance_acknowledged_at          timestamptz,
  variance_acknowledged_by          text,
  variance_note                     text,
  withholding_path                  text,
  cumulative_divisor                integer,
  created_at                        timestamptz NOT NULL DEFAULT now(),
  updated_at                        timestamptz NOT NULL DEFAULT now()
);

-- ============================================================================
-- Foreign keys
-- ============================================================================

-- The `parties` guard is load-bearing. This file runs BEFORE `drizzle-kit push`
-- on the deploy path, and push is what creates `parties` from the Drizzle
-- schema. On an existing database parties is already there and the constraints
-- attach on this pass; on a genuinely fresh one they attach on the second call,
-- which every build path makes. Without the guard a first deploy to an empty
-- database dies on "relation parties does not exist".
DO $$
DECLARE
  parties_exists boolean := EXISTS (
    SELECT 1 FROM information_schema.tables WHERE table_name = 'parties'
  );
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
    WHERE c.contype = 'f' AND c.conrelid = 'payroll_lines'::regclass AND a.attname = 'payroll_run_id'
  ) THEN
    ALTER TABLE payroll_lines
      ADD CONSTRAINT payroll_lines_run_fk
      FOREIGN KEY (payroll_run_id) REFERENCES payroll_runs(id) ON DELETE CASCADE;
  END IF;

  IF parties_exists THEN
    IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
    WHERE c.contype = 'f' AND c.conrelid = 'payroll_previous_employer_2316'::regclass AND a.attname = 'employee_party_id'
  ) THEN
      ALTER TABLE payroll_previous_employer_2316
        ADD CONSTRAINT payroll_prev_2316_employee_fk
        FOREIGN KEY (employee_party_id) REFERENCES parties(id) ON DELETE CASCADE;
    END IF;

    IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
    WHERE c.contype = 'f' AND c.conrelid = 'payroll_employee_year_state'::regclass AND a.attname = 'employee_party_id'
  ) THEN
      ALTER TABLE payroll_employee_year_state
        ADD CONSTRAINT payroll_year_state_employee_fk
        FOREIGN KEY (employee_party_id) REFERENCES parties(id) ON DELETE CASCADE;
    END IF;

    -- RESTRICT, not CASCADE: an employee with a filed payroll line must not be
    -- deletable out from under a return. NIRC Sec. 235 requires ten years of
    -- retention.
    IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
    WHERE c.contype = 'f' AND c.conrelid = 'payroll_lines'::regclass AND a.attname = 'employee_party_id'
  ) THEN
      ALTER TABLE payroll_lines
        ADD CONSTRAINT payroll_lines_employee_fk
        FOREIGN KEY (employee_party_id) REFERENCES parties(id) ON DELETE RESTRICT;
    END IF;
  ELSE
    RAISE NOTICE 'parties not present yet — payroll employee FKs deferred to the next run';
  END IF;
END $$;

-- ============================================================================
-- CHECK constraints — Drizzle cannot express these, so they live only here
-- ============================================================================

DO $$
BEGIN
  -- The Step 2 divisor must be a real period count. Zero would make the
  -- cumulative method divide by the employee's own periods alone and silently
  -- drop the prior employer from the denominator while keeping it in the
  -- numerator.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payroll_prev_2316_periods_positive') THEN
    ALTER TABLE payroll_previous_employer_2316
      ADD CONSTRAINT payroll_prev_2316_periods_positive CHECK (periods_covered > 0);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payroll_prev_2316_amounts_non_negative') THEN
    ALTER TABLE payroll_previous_employer_2316
      ADD CONSTRAINT payroll_prev_2316_amounts_non_negative
      CHECK (taxable_compensation >= 0 AND tax_withheld >= 0);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payroll_prev_2316_employment_ordered') THEN
    ALTER TABLE payroll_previous_employer_2316
      ADD CONSTRAINT payroll_prev_2316_employment_ordered
      CHECK (employment_to >= employment_from);
  END IF;

  -- The latch is one-way and its reason is a closed set.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payroll_year_state_method_valid') THEN
    ALTER TABLE payroll_employee_year_state
      ADD CONSTRAINT payroll_year_state_method_valid
      CHECK (withholding_method IN ('regular', 'cumulative_average'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payroll_year_state_latch_reason_valid') THEN
    ALTER TABLE payroll_employee_year_state
      ADD CONSTRAINT payroll_year_state_latch_reason_valid
      CHECK (latched_reason IS NULL OR latched_reason IN (
        'already_latched',
        'regular_below_level_with_supplementary',
        'supplementary_at_or_above_regular',
        'new_hire_with_previous_employer'
      ));
  END IF;

  -- A latched row must say why and when. A latch with no reason cannot be
  -- explained to an examiner two years later.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payroll_year_state_latch_explained') THEN
    ALTER TABLE payroll_employee_year_state
      ADD CONSTRAINT payroll_year_state_latch_explained
      CHECK (
        withholding_method = 'regular'
        OR (latched_reason IS NOT NULL AND latched_at_period_end IS NOT NULL)
      );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payroll_year_state_ytd_non_negative') THEN
    ALTER TABLE payroll_employee_year_state
      ADD CONSTRAINT payroll_year_state_ytd_non_negative
      CHECK (
        ytd_taxable_regular >= 0
        AND ytd_taxable_supplementary >= 0
        AND ytd_non_taxable >= 0
        AND ytd_tax_withheld >= 0
        AND ytd_13th_month_and_other_benefits >= 0
        AND periods_elapsed >= 0
      );
  END IF;

  -- An opening-balance row must carry its as-of date and the dataset version it
  -- was understood under, so an amended prior period recomputes against the
  -- figures as they stood then (DECISIONS D-N5, D7).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payroll_year_state_migration_provenance') THEN
    ALTER TABLE payroll_employee_year_state
      ADD CONSTRAINT payroll_year_state_migration_provenance
      CHECK (
        NOT is_pre_migration
        OR (opening_balance_as_of IS NOT NULL AND reference_dataset_version IS NOT NULL)
      );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payroll_runs_period_valid') THEN
    ALTER TABLE payroll_runs
      ADD CONSTRAINT payroll_runs_period_valid
      CHECK (payroll_period IN ('daily', 'weekly', 'semi_monthly', 'monthly', 'annual'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payroll_runs_status_valid') THEN
    ALTER TABLE payroll_runs
      ADD CONSTRAINT payroll_runs_status_valid
      CHECK (status IN ('draft', 'imported', 'computed', 'acknowledged', 'locked'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payroll_runs_dates_ordered') THEN
    ALTER TABLE payroll_runs
      ADD CONSTRAINT payroll_runs_dates_ordered CHECK (period_end >= period_start);
  END IF;

  -- 1..24 covers semi-monthly; daily and weekly are bounded more loosely on
  -- purpose, since working-day counts vary by employer.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payroll_runs_period_index_positive') THEN
    ALTER TABLE payroll_runs
      ADD CONSTRAINT payroll_runs_period_index_positive
      CHECK (period_index >= 1 AND period_index <= 366);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payroll_lines_path_valid') THEN
    ALTER TABLE payroll_lines
      ADD CONSTRAINT payroll_lines_path_valid
      CHECK (withholding_path IS NULL OR withholding_path IN (
        'regular', 'cumulative_average', 'annualized'
      ));
  END IF;

  -- A cumulative-average line must record the divisor it used. Without it a
  -- filed figure cannot be re-explained, and the divisor is the value most
  -- likely to be questioned.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payroll_lines_divisor_recorded') THEN
    ALTER TABLE payroll_lines
      ADD CONSTRAINT payroll_lines_divisor_recorded
      CHECK (
        withholding_path IS DISTINCT FROM 'cumulative_average'
        OR (cumulative_divisor IS NOT NULL AND cumulative_divisor > 0)
      );
  END IF;

  -- An acknowledged variance must name who acknowledged it. D-N7 makes the
  -- product the control, not the computer of record — an anonymous
  -- acknowledgement is not a control.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payroll_lines_variance_attributed') THEN
    ALTER TABLE payroll_lines
      ADD CONSTRAINT payroll_lines_variance_attributed
      CHECK (
        variance_acknowledged_at IS NULL
        OR (variance_acknowledged_by IS NOT NULL AND variance_note IS NOT NULL)
      );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payroll_lines_basic_non_negative') THEN
    ALTER TABLE payroll_lines
      ADD CONSTRAINT payroll_lines_basic_non_negative CHECK (basic_salary >= 0);
  END IF;
END $$;

-- ============================================================================
-- Indexes
-- ============================================================================

CREATE UNIQUE INDEX IF NOT EXISTS payroll_prev_2316_employee_year_employer
  ON payroll_previous_employer_2316 (organization_id, employee_party_id, taxable_year, previous_employer_name);
CREATE INDEX IF NOT EXISTS payroll_prev_2316_lookup
  ON payroll_previous_employer_2316 (organization_id, employee_party_id, taxable_year);

CREATE UNIQUE INDEX IF NOT EXISTS payroll_employee_year_state_key
  ON payroll_employee_year_state (organization_id, employee_party_id, taxable_year);

CREATE UNIQUE INDEX IF NOT EXISTS payroll_runs_org_period
  ON payroll_runs (organization_id, taxable_year, payroll_period, period_index);
CREATE INDEX IF NOT EXISTS payroll_runs_org_year
  ON payroll_runs (organization_id, taxable_year);

CREATE UNIQUE INDEX IF NOT EXISTS payroll_lines_run_employee
  ON payroll_lines (payroll_run_id, employee_party_id);
CREATE INDEX IF NOT EXISTS payroll_lines_org_employee
  ON payroll_lines (organization_id, employee_party_id);
