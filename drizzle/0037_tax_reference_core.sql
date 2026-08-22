-- 0037_tax_reference_core.sql
-- Philippine BIR tax reference core (Stage 1 of docs/tax/IMPLEMENTATION-PLAN.md).
--
-- ORDER-INDEPENDENT AND CONVERGENT BY CONSTRUCTION. This file runs in two
-- different positions and must produce the same schema in both:
--
--   deploy / make migrate : BEFORE `drizzle-kit push --force`. Required — with
--     unmanaged tables present (app_manual_migrations), push prompts
--     interactively for brand-new tables ("created or renamed?") and hangs a
--     non-TTY deploy. deploy.yml documents this for the AI tables; the same
--     applies here. See IMPLEMENTATION-PLAN.md blocker B2.
--
--   db:fresh / db:test:fresh : AFTER the reset+push. Those paths DROP the
--     schema first, so push creates the tables from the Drizzle mirror in
--     src/db/schema/tax-reference.ts — but Drizzle cannot express CHECK
--     constraints, so this file must still run to install them.
--
-- Hence: tables are created bare with CREATE TABLE IF NOT EXISTS, and every
-- constraint is added in its own guarded block. `CREATE TABLE IF NOT EXISTS`
-- with inline constraints would silently skip them on a table push already
-- created — the exact failure this structure avoids.
--
-- TENANCY. The three tax_* catalog tables are GLOBAL: no organization_id,
-- deliberately excluded from RLS, exactly like review_rule_definitions.
-- Statutory rates are not tenant data, and a per-org copy is the drift bug
-- IMPLEMENTATION-PLAN.md blocker B11 describes. org_tax_profiles and
-- org_tax_branches are org-scoped and get policies in rls_policies.sql.

-- ============================================================================
-- Tables (bare — constraints follow)
-- ============================================================================

-- The dataset version stamped onto filings and opening-balance intakes, so an
-- amended prior-period return recomputes against the figures as they were
-- understood when it was first filed (DECISIONS D-N5, D7).
CREATE TABLE IF NOT EXISTS tax_reference_datasets (
  version          text PRIMARY KEY,
  published_at     timestamptz NOT NULL DEFAULT now(),
  -- NULL until a human confirms the rows against primary sources. Surfaced as
  -- a staleness warning; the monthly reference sweep proposes updates.
  last_verified_at timestamptz,
  source_note      text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- Withholding tax on compensation brackets. BOTH annexes are seeded: RR
-- 11-2018's own Illustrations 6-15 (our golden vectors) compute under Annex D,
-- so seeding only Annex E red-builds the vector suite and invites "fixing" the
-- live 2026 constants. See IMPLEMENTATION-PLAN.md blocker B3.
CREATE TABLE IF NOT EXISTS tax_withholding_tables (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_version text NOT NULL,
  annex           text NOT NULL,
  payroll_period  text NOT NULL,
  bracket_index   integer NOT NULL,
  -- Bracket floor in pesos; selection is `floor_amount <= compensation`, so the
  -- ceiling is implicit in the next bracket.
  floor_amount    numeric(20, 8) NOT NULL,
  prescribed_tax  numeric(20, 8) NOT NULL,
  -- Basis points, so the rate is exact integer data (1500 = 15%).
  rate_bps        integer NOT NULL,
  effective_from  date NOT NULL,
  effective_to    date,
  citation        text NOT NULL
);

-- De minimis ceilings. Three limit SHAPES plus an uncapped case, because the
-- eleven RR 29-2025 benefits do not share one: government VL/SL monetization
-- has no ceiling, and the OT/night-shift meal allowance is a percentage of the
-- regional SMW, which makes this table depend on the DOLE wage data.
--
-- permitted_forms carries what an amount-only table cannot: RR 4-2025 changed
-- the permitted FORM of employee achievement awards (adding cash and gift
-- certificates) while leaving the amount at P10,000. See DECISIONS A6.
CREATE TABLE IF NOT EXISTS tax_de_minimis_ceilings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_version text NOT NULL,
  benefit_type    text NOT NULL,
  limit_kind      text NOT NULL,
  -- NULL only when limit_kind = 'uncapped'.
  limit_amount    numeric(20, 8),
  -- NULL means no form restriction; a non-empty array restricts the benefit.
  permitted_forms text[],
  effective_from  date NOT NULL,
  effective_to    date,
  citation        text NOT NULL
);

-- The filing identity. A sidecar on auth_organizations modelled on
-- organization_secrets — NOT auth_organizations.metadata, which is an
-- unconstrained text JSON blob that Better Auth returns to browser clients and
-- which is an exportable entity. See DECISIONS D5.
CREATE TABLE IF NOT EXISTS org_tax_profiles (
  organization_id           text PRIMARY KEY,
  -- 9 digits, stored without separators.
  tin                       text,
  -- Stored at 5 digits (eBIRForms v7.9.6.0, RMC 36-2026). The alphalist .DAT
  -- layouts still specify 4; the encoder truncates and logs. See DECISIONS A5.
  branch_code               text NOT NULL DEFAULT '00000',
  rdo_code                  text,
  registered_name           text,
  -- Drives PENALTY computation under EOPT, not just reporting: Micro and Small
  -- get 10% surcharge instead of 25%, 6% interest instead of 12%, and 50% of
  -- the normal compromise penalty.
  taxpayer_classification   text,
  -- Determines the eFPS staggered offset: A=+15d down to E=+11d from month end,
  -- and only for the monthly withholding forms (RR 26-2002).
  efps_enrolled             boolean NOT NULL DEFAULT false,
  efps_industry_group       text,
  is_nga                    boolean NOT NULL DEFAULT false,
  fiscal_year_end_month     integer NOT NULL DEFAULT 12,
  -- RR 7-2024 requires system-generated invoices to print these on the face.
  -- Stored now, enforced if/when PH invoice issuance ships (DECISIONS D6b).
  accn                      text,
  approved_series_from      text,
  approved_series_to        text,
  approved_series_date      date,
  -- Prior periods are explicitly "filed outside buwiz"; the first computed
  -- return is the first FULL period after this date (DECISIONS D7).
  books_as_of               date,
  -- Pins reference data for reproducibility; NULL means "latest".
  reference_dataset_version text,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);

-- Registered branches. Shipped now because it is a column today and a migration
-- over live filing data later; per-branch return SPLITTING is post-v1 and v1
-- computes head-office consolidated (DECISIONS D5).
CREATE TABLE IF NOT EXISTS org_tax_branches (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      text NOT NULL,
  branch_code          text NOT NULL,
  name                 text,
  rdo_code             text,
  is_withholding_agent boolean NOT NULL DEFAULT false,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

-- ============================================================================
-- Indexes (idempotent on their own)
-- ============================================================================
CREATE UNIQUE INDEX IF NOT EXISTS tax_withholding_tables_natural_key
  ON tax_withholding_tables (dataset_version, annex, payroll_period, bracket_index);
CREATE INDEX IF NOT EXISTS tax_withholding_tables_lookup
  ON tax_withholding_tables (payroll_period, effective_from, effective_to);

CREATE UNIQUE INDEX IF NOT EXISTS tax_de_minimis_ceilings_natural_key
  ON tax_de_minimis_ceilings (dataset_version, benefit_type, effective_from);
CREATE INDEX IF NOT EXISTS tax_de_minimis_ceilings_lookup
  ON tax_de_minimis_ceilings (benefit_type, effective_from, effective_to);

CREATE UNIQUE INDEX IF NOT EXISTS org_tax_branches_org_code_unique
  ON org_tax_branches (organization_id, branch_code);

-- ============================================================================
-- Foreign keys and CHECK constraints
-- ============================================================================
-- Guarded individually because CREATE TABLE IF NOT EXISTS skips inline
-- constraints when the table already exists — which it does on every path
-- where drizzle-kit push ran first. Drizzle cannot express CHECK constraints
-- at all, so this block is the only thing that installs them.
DO $$
BEGIN
  -- ── Foreign keys ──
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
    WHERE c.contype = 'f' AND c.conrelid = 'tax_withholding_tables'::regclass AND a.attname = 'dataset_version'
  ) THEN
    ALTER TABLE tax_withholding_tables
      ADD CONSTRAINT tax_withholding_tables_dataset_fk
      FOREIGN KEY (dataset_version) REFERENCES tax_reference_datasets(version) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
    WHERE c.contype = 'f' AND c.conrelid = 'tax_de_minimis_ceilings'::regclass AND a.attname = 'dataset_version'
  ) THEN
    ALTER TABLE tax_de_minimis_ceilings
      ADD CONSTRAINT tax_de_minimis_ceilings_dataset_fk
      FOREIGN KEY (dataset_version) REFERENCES tax_reference_datasets(version) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
    WHERE c.contype = 'f' AND c.conrelid = 'org_tax_profiles'::regclass AND a.attname = 'organization_id'
  ) THEN
    ALTER TABLE org_tax_profiles
      ADD CONSTRAINT org_tax_profiles_organization_fk
      FOREIGN KEY (organization_id) REFERENCES auth_organizations(id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
    WHERE c.contype = 'f' AND c.conrelid = 'org_tax_profiles'::regclass AND a.attname = 'reference_dataset_version'
  ) THEN
    ALTER TABLE org_tax_profiles
      ADD CONSTRAINT org_tax_profiles_dataset_fk
      FOREIGN KEY (reference_dataset_version) REFERENCES tax_reference_datasets(version) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
    WHERE c.contype = 'f' AND c.conrelid = 'org_tax_branches'::regclass AND a.attname = 'organization_id'
  ) THEN
    ALTER TABLE org_tax_branches
      ADD CONSTRAINT org_tax_branches_organization_fk
      FOREIGN KEY (organization_id) REFERENCES auth_organizations(id) ON DELETE CASCADE;
  END IF;

  -- ── Withholding table domain checks ──
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tax_withholding_tables_annex_check') THEN
    ALTER TABLE tax_withholding_tables
      ADD CONSTRAINT tax_withholding_tables_annex_check CHECK (annex IN ('D', 'E'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tax_withholding_tables_period_check') THEN
    ALTER TABLE tax_withholding_tables
      ADD CONSTRAINT tax_withholding_tables_period_check
      CHECK (payroll_period IN ('daily', 'weekly', 'semi_monthly', 'monthly', 'annual'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tax_withholding_tables_rate_check') THEN
    ALTER TABLE tax_withholding_tables
      ADD CONSTRAINT tax_withholding_tables_rate_check
      CHECK (rate_bps >= 0 AND rate_bps <= 10000);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tax_withholding_tables_range_check') THEN
    ALTER TABLE tax_withholding_tables
      ADD CONSTRAINT tax_withholding_tables_range_check
      CHECK (effective_to IS NULL OR effective_to >= effective_from);
  END IF;

  -- ── De minimis domain checks ──
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tax_de_minimis_ceilings_kind_check') THEN
    ALTER TABLE tax_de_minimis_ceilings
      ADD CONSTRAINT tax_de_minimis_ceilings_kind_check
      CHECK (limit_kind IN (
        'peso_per_month', 'peso_per_semester', 'peso_per_year',
        'days_per_year', 'pct_of_regional_smw', 'uncapped'
      ));
  END IF;

  -- An uncapped row carrying an amount, or a capped row missing one, is a data
  -- bug that would silently tax an exempt benefit.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tax_de_minimis_ceilings_amount_check') THEN
    ALTER TABLE tax_de_minimis_ceilings
      ADD CONSTRAINT tax_de_minimis_ceilings_amount_check
      CHECK (
        (limit_kind = 'uncapped' AND limit_amount IS NULL)
        OR (limit_kind <> 'uncapped' AND limit_amount IS NOT NULL)
      );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tax_de_minimis_ceilings_range_check') THEN
    ALTER TABLE tax_de_minimis_ceilings
      ADD CONSTRAINT tax_de_minimis_ceilings_range_check
      CHECK (effective_to IS NULL OR effective_to >= effective_from);
  END IF;

  -- ── Filing identity domain checks ──
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'org_tax_profiles_branch_code_check') THEN
    ALTER TABLE org_tax_profiles
      ADD CONSTRAINT org_tax_profiles_branch_code_check CHECK (branch_code ~ '^[0-9]{5}$');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'org_tax_profiles_tin_check') THEN
    ALTER TABLE org_tax_profiles
      ADD CONSTRAINT org_tax_profiles_tin_check CHECK (tin IS NULL OR tin ~ '^[0-9]{9}$');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'org_tax_profiles_classification_check') THEN
    ALTER TABLE org_tax_profiles
      ADD CONSTRAINT org_tax_profiles_classification_check
      CHECK (taxpayer_classification IS NULL
             OR taxpayer_classification IN ('micro', 'small', 'medium', 'large'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'org_tax_profiles_efps_group_check') THEN
    ALTER TABLE org_tax_profiles
      ADD CONSTRAINT org_tax_profiles_efps_group_check
      CHECK (efps_industry_group IS NULL OR efps_industry_group IN ('A', 'B', 'C', 'D', 'E'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'org_tax_profiles_fiscal_month_check') THEN
    ALTER TABLE org_tax_profiles
      ADD CONSTRAINT org_tax_profiles_fiscal_month_check
      CHECK (fiscal_year_end_month BETWEEN 1 AND 12);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'org_tax_branches_code_check') THEN
    ALTER TABLE org_tax_branches
      ADD CONSTRAINT org_tax_branches_code_check CHECK (branch_code ~ '^[0-9]{5}$');
  END IF;
END $$;

-- ============================================================================
-- Additive: non-amount qualifying conditions (2026-08-17)
-- ============================================================================
-- The employee achievement award's exemption is subject to three cumulative
-- conditions — form, occasion, and an established written non-discriminatory
-- plan. RR 4-2025 relaxed only the form limb. A permitted-forms list alone
-- over-exempts, so the other conditions need somewhere to live.
ALTER TABLE tax_de_minimis_ceilings
  ADD COLUMN IF NOT EXISTS qualifying_conditions text[];
