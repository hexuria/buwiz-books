-- 0047_tax_stage_remainder.sql
-- Remaining Stage 1/3b/4/6/7 persist tables that the engines already assume.
--
--   org_tax_year_elections     8% / percentage / VAT election for a taxable year
--   org_tax_registrations      dated VAT / TWA facts (never a boolean on the org)
--   filing_deadline_overrides  global official date moves (RMC etc.)
--   tax_withholding_payments   Stage 3b: we withheld from a supplier
--   tax_computed_returns       saved 2550Q / 2551Q / 1601-EQ working returns

CREATE TABLE IF NOT EXISTS org_tax_year_elections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  taxable_year integer NOT NULL,
  regime text NOT NULL,
  elected_via_form text,
  irrevocable boolean NOT NULL DEFAULT true,
  has_compensation_income boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS org_tax_year_elections_org_year
  ON org_tax_year_elections (organization_id, taxable_year);

CREATE TABLE IF NOT EXISTS org_tax_registrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  regime_kind text NOT NULL,
  value text NOT NULL,
  effective_from date NOT NULL,
  effective_to date,
  source_event text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS org_tax_registrations_org_kind
  ON org_tax_registrations (organization_id, regime_kind, effective_from);

-- GLOBAL. Official deadline moves are not tenant data.
CREATE TABLE IF NOT EXISTS filing_deadline_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  form_code text NOT NULL,
  period_start date,
  period_end date,
  due_date date NOT NULL,
  citation text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS filing_deadline_overrides_natural_key
  ON filing_deadline_overrides (form_code, period_start, period_end);

CREATE TABLE IF NOT EXISTS tax_withholding_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  payee_party_id uuid,
  payee_tin text NOT NULL,
  payee_registered_name text NOT NULL,
  period_start date NOT NULL,
  period_end date NOT NULL,
  atc text NOT NULL,
  income_payment numeric(20, 8) NOT NULL,
  tax_withheld numeric(20, 8) NOT NULL,
  certificate_issued boolean NOT NULL DEFAULT false,
  certificate_number text,
  journal_header_id uuid,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tax_withholding_payments_org_period
  ON tax_withholding_payments (organization_id, period_start, period_end);

CREATE TABLE IF NOT EXISTS tax_computed_returns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  form_code text NOT NULL,
  period_start date NOT NULL,
  period_end date NOT NULL,
  payload jsonb NOT NULL,
  blocking_issue_count integer NOT NULL DEFAULT 0,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS tax_computed_returns_natural_key
  ON tax_computed_returns (organization_id, form_code, period_start, period_end);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'org_tax_year_elections_regime_check') THEN
    ALTER TABLE org_tax_year_elections
      ADD CONSTRAINT org_tax_year_elections_regime_check
      CHECK (regime IN ('vat', 'percentage_tax', 'eight_percent'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'org_tax_year_elections_year_check') THEN
    ALTER TABLE org_tax_year_elections
      ADD CONSTRAINT org_tax_year_elections_year_check
      CHECK (taxable_year BETWEEN 2000 AND 2100);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'org_tax_registrations_kind_check') THEN
    ALTER TABLE org_tax_registrations
      ADD CONSTRAINT org_tax_registrations_kind_check
      CHECK (regime_kind IN ('vat', 'twa', 'percentage_tax', 'eight_percent'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'org_tax_registrations_range_check') THEN
    ALTER TABLE org_tax_registrations
      ADD CONSTRAINT org_tax_registrations_range_check
      CHECK (effective_to IS NULL OR effective_to >= effective_from);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tax_withholding_payments_amounts_check') THEN
    ALTER TABLE tax_withholding_payments
      ADD CONSTRAINT tax_withholding_payments_amounts_check
      CHECK (income_payment >= 0 AND tax_withheld >= 0 AND tax_withheld <= income_payment);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tax_withholding_payments_period_check') THEN
    ALTER TABLE tax_withholding_payments
      ADD CONSTRAINT tax_withholding_payments_period_check
      CHECK (period_end >= period_start);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tax_computed_returns_form_check') THEN
    ALTER TABLE tax_computed_returns
      ADD CONSTRAINT tax_computed_returns_form_check
      CHECK (form_code IN ('2550Q', '2551Q', '1601C', '1601EQ', '0619E', 'QAP', 'SLSP'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.key_column_usage k
      JOIN information_schema.table_constraints t
        ON t.constraint_name = k.constraint_name AND t.constraint_schema = k.constraint_schema
     WHERE k.table_name = 'tax_withholding_payments' AND k.column_name = 'journal_header_id'
       AND t.constraint_type = 'FOREIGN KEY'
  ) THEN
    ALTER TABLE tax_withholding_payments
      ADD CONSTRAINT tax_withholding_payments_journal_header_id_fk
      FOREIGN KEY (journal_header_id) REFERENCES journal_headers(id) ON DELETE RESTRICT;
  END IF;
END $$;
