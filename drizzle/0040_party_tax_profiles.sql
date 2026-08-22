-- 0040_party_tax_profiles.sql
-- Philippine tax identity for employees and payees.
--
-- Convergent and order-independent like its siblings: bare CREATE TABLE IF NOT
-- EXISTS, foreign keys guarded BY COLUMN (drizzle-kit push creates its own
-- under a generated name, so a name guard adds a duplicate), CHECK constraints
-- guarded by name because Drizzle cannot express them and this file is their
-- only author.

CREATE TABLE IF NOT EXISTS party_tax_profiles (
  id                             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id                text NOT NULL,
  party_id                       uuid NOT NULL,
  tin                            text,
  branch_code                    text DEFAULT '00000',
  rdo_code                       text,
  last_name                      text,
  first_name                     text,
  middle_name                    text,
  registered_name                text,
  address_line1                  text,
  address_line2                  text,
  city                           text,
  province                       text,
  zip_code                       text,
  payee_type                     text,
  status_code                    text,
  is_employee                    boolean NOT NULL DEFAULT false,
  birth_date                     date,
  date_hired                     date,
  date_separated                 date,
  is_minimum_wage_earner         boolean NOT NULL DEFAULT false,
  region_code                    text,
  substituted_filing_eligible    boolean NOT NULL DEFAULT false,
  is_payee                       boolean NOT NULL DEFAULT false,
  default_atc                    text,
  sworn_declaration_year         text,
  sworn_declaration_received_at  date,
  is_vat_registered              boolean NOT NULL DEFAULT false,
  created_at                     timestamptz NOT NULL DEFAULT now(),
  updated_at                     timestamptz NOT NULL DEFAULT now()
);

DO $$
DECLARE
  parties_exists boolean := EXISTS (
    SELECT 1 FROM information_schema.tables WHERE table_name = 'parties'
  );
BEGIN
  IF parties_exists AND NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
    WHERE c.contype = 'f' AND c.conrelid = 'party_tax_profiles'::regclass AND a.attname = 'party_id'
  ) THEN
    ALTER TABLE party_tax_profiles
      ADD CONSTRAINT party_tax_profiles_party_fk
      FOREIGN KEY (party_id) REFERENCES parties(id) ON DELETE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  -- A TIN is nine digits with no separators and no branch code. Storing it
  -- formatted is how "123-456-789-0000" reaches a .DAT field expecting nine
  -- characters and shifts every field after it.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'party_tax_profiles_tin_format') THEN
    ALTER TABLE party_tax_profiles
      ADD CONSTRAINT party_tax_profiles_tin_format
      CHECK (tin IS NULL OR tin ~ '^[0-9]{9}$');
  END IF;

  -- Stored as five digits (eBIRForms v7.9.6.0), truncated to four at .DAT
  -- generation because the published alphalist layouts still specify four.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'party_tax_profiles_branch_code_format'
  ) THEN
    ALTER TABLE party_tax_profiles
      ADD CONSTRAINT party_tax_profiles_branch_code_format
      CHECK (branch_code IS NULL OR branch_code ~ '^[0-9]{5}$');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'party_tax_profiles_status_code_valid') THEN
    ALTER TABLE party_tax_profiles
      ADD CONSTRAINT party_tax_profiles_status_code_valid
      CHECK (status_code IS NULL OR status_code IN (
        'resident_citizen', 'resident_alien',
        'non_resident_alien_etb', 'non_resident_alien_netb',
        'domestic_corporation', 'resident_foreign_corporation',
        'non_resident_foreign_corporation'
      ));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'party_tax_profiles_payee_type_valid') THEN
    ALTER TABLE party_tax_profiles
      ADD CONSTRAINT party_tax_profiles_payee_type_valid
      CHECK (payee_type IS NULL OR payee_type IN (
        'individual', 'corporate', 'general_professional_partnership',
        'government', 'cooperative', 'tax_exempt'
      ));
  END IF;

  -- A named person needs SOMETHING to be named by. An alphalist row with no
  -- name is rejected, and RMC 5-2014 bans lumped entries, so a blank profile
  -- must fail here rather than at submission.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'party_tax_profiles_named') THEN
    ALTER TABLE party_tax_profiles
      ADD CONSTRAINT party_tax_profiles_named
      CHECK (last_name IS NOT NULL OR registered_name IS NOT NULL);
  END IF;

  -- An employee needs a hire date: it decides whether a mid-year hire's prior
  -- 2316 is required, which the cumulative-average method depends on.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'party_tax_profiles_employee_hired') THEN
    ALTER TABLE party_tax_profiles
      ADD CONSTRAINT party_tax_profiles_employee_hired
      CHECK (NOT is_employee OR date_hired IS NOT NULL);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'party_tax_profiles_employment_ordered') THEN
    ALTER TABLE party_tax_profiles
      ADD CONSTRAINT party_tax_profiles_employment_ordered
      CHECK (date_separated IS NULL OR date_hired IS NULL OR date_separated >= date_hired);
  END IF;

  -- An MWE's exemption is regional: the statutory minimum wage comes from that
  -- region's wage order, and the de minimis meal-allowance ceiling is a
  -- percentage of it. Without a region the status cannot be justified.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'party_tax_profiles_mwe_region') THEN
    ALTER TABLE party_tax_profiles
      ADD CONSTRAINT party_tax_profiles_mwe_region
      CHECK (NOT is_minimum_wage_earner OR region_code IS NOT NULL);
  END IF;

  -- A sworn declaration is only meaningful with the year it covers: it gates
  -- the 5%-versus-10% professional-fee rate for that taxable year alone.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'party_tax_profiles_sworn_declaration') THEN
    ALTER TABLE party_tax_profiles
      ADD CONSTRAINT party_tax_profiles_sworn_declaration
      CHECK (sworn_declaration_received_at IS NULL OR sworn_declaration_year IS NOT NULL);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS party_tax_profiles_party
  ON party_tax_profiles (organization_id, party_id);
CREATE INDEX IF NOT EXISTS party_tax_profiles_tin
  ON party_tax_profiles (organization_id, tin);
