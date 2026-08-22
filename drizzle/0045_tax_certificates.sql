-- 0045_tax_certificates.sql
-- Received BIR Form 2307 certificates — Stage 3a.
--
-- Stage 1 deliberately deferred `tax_certificates` "until its consumer stage".
-- This is that stage: a customer who withholds expanded withholding tax from a
-- payment to us issues a 2307, and that certificate is the ONLY evidence
-- supporting the creditable withholding tax we claim against our income tax.
--
-- WHY THE CERTIFICATE IS THE RECORD, NOT THE JOURNAL. Without the physical
-- 2307, the BIR disallows the credit outright regardless of what our books
-- say — so the ledger entry and the certificate are two different facts and
-- both have to be tracked. A CWT receivable with no certificate behind it is
-- an asset that will be written off at assessment, which is exactly the case
-- the `certificate_status` column exists to make visible before then.
--
-- DUPLICATE CLAIMS ARE THE EXPENSIVE FAILURE. Claiming the same certificate
-- twice overstates the credit and understates tax due. The natural key is
-- (payor TIN, certificate number, period) and it is enforced by a unique index
-- rather than by application discipline.

CREATE TABLE IF NOT EXISTS tax_certificates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,

  -- 'received_2307' today; 'issued_2307' arrives with Stage 3b.
  certificate_type text NOT NULL DEFAULT 'received_2307',

  -- The party that withheld FROM us and issued the certificate.
  payor_party_id uuid,
  payor_tin text NOT NULL,
  payor_registered_name text NOT NULL,

  certificate_number text,

  -- The quarter the certificate covers. 2307 is issued per quarter.
  period_start date NOT NULL,
  period_end date NOT NULL,

  -- Alphanumeric Tax Code — decides the rate and the SAWT column.
  atc text NOT NULL,
  income_payment numeric(20, 8) NOT NULL,
  tax_withheld numeric(20, 8) NOT NULL,

  -- Whether the paper certificate is actually in hand. A claim without one is
  -- disallowed at assessment no matter what the ledger says.
  certificate_status text NOT NULL DEFAULT 'pending',

  -- The journal that recognised the CWT receivable, once posted.
  journal_header_id uuid,

  document_id uuid,
  notes text,

  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tax_certificates_type_check') THEN
    ALTER TABLE tax_certificates ADD CONSTRAINT tax_certificates_type_check
      CHECK (certificate_type IN ('received_2307', 'issued_2307'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tax_certificates_status_check') THEN
    ALTER TABLE tax_certificates ADD CONSTRAINT tax_certificates_status_check
      CHECK (certificate_status IN ('pending', 'received', 'lost', 'disputed'));
  END IF;

  -- Amounts are never negative. A "negative certificate" is a correction and
  -- belongs as its own reversing row, not as a sign flip that would net away
  -- silently in every SAWT total.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tax_certificates_amounts_check') THEN
    ALTER TABLE tax_certificates ADD CONSTRAINT tax_certificates_amounts_check
      CHECK (income_payment >= 0 AND tax_withheld >= 0);
  END IF;

  -- Tax withheld cannot exceed the payment it was withheld from. This catches
  -- a transposed data entry that would otherwise inflate a credit.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tax_certificates_withheld_le_payment') THEN
    ALTER TABLE tax_certificates ADD CONSTRAINT tax_certificates_withheld_le_payment
      CHECK (tax_withheld <= income_payment);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tax_certificates_period_check') THEN
    ALTER TABLE tax_certificates ADD CONSTRAINT tax_certificates_period_check
      CHECK (period_end >= period_start);
  END IF;
END $$;

-- Guarded by COLUMN, not by name: drizzle-kit push creates its own FK under a
-- generated name, which a name-based check cannot see.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.key_column_usage k
      JOIN information_schema.table_constraints t
        ON t.constraint_name = k.constraint_name AND t.constraint_schema = k.constraint_schema
     WHERE k.table_name = 'tax_certificates' AND k.column_name = 'payor_party_id'
       AND t.constraint_type = 'FOREIGN KEY'
  ) THEN
    ALTER TABLE tax_certificates ADD CONSTRAINT tax_certificates_payor_party_id_fk
      FOREIGN KEY (payor_party_id) REFERENCES parties(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.key_column_usage k
      JOIN information_schema.table_constraints t
        ON t.constraint_name = k.constraint_name AND t.constraint_schema = k.constraint_schema
     WHERE k.table_name = 'tax_certificates' AND k.column_name = 'journal_header_id'
       AND t.constraint_type = 'FOREIGN KEY'
  ) THEN
    ALTER TABLE tax_certificates ADD CONSTRAINT tax_certificates_journal_header_id_fk
      FOREIGN KEY (journal_header_id) REFERENCES journal_headers(id) ON DELETE RESTRICT;
  END IF;
END $$;

-- The natural key. Claiming one certificate twice overstates the credit and
-- understates tax due — enforced here rather than left to application code.
-- Scoped to certificates that HAVE a number; a certificate captured before its
-- number is known is legitimate and must not collide with another such row.
CREATE UNIQUE INDEX IF NOT EXISTS tax_certificates_natural_key
  ON tax_certificates (organization_id, payor_tin, certificate_number, period_start, period_end)
  WHERE certificate_number IS NOT NULL;

CREATE INDEX IF NOT EXISTS tax_certificates_org_period
  ON tax_certificates (organization_id, period_start, period_end);

CREATE INDEX IF NOT EXISTS tax_certificates_org_status
  ON tax_certificates (organization_id, certificate_status);
