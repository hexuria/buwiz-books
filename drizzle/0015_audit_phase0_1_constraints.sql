-- Migration: per-organization uniqueness for invoice + transaction numbers
-- Audit fixes #3 and #8. Generated to match the schema changes in
-- src/db/schema/invoices.ts and src/db/schema/journals.ts.
--
-- ⚠️  PRECONDITION: adding these UNIQUE constraints FAILS if duplicate
--     (organization_id, number) pairs already exist (the legacy count(*)+1 import
--     numbering could produce them). Run the dedupe checks below FIRST and resolve any
--     rows they return before applying the ADD CONSTRAINT statements.

BEGIN;

-- ── Preflight: find collisions that would block the constraints ──────────────
-- SELECT organization_id, invoice_number, count(*)
--   FROM invoices GROUP BY 1,2 HAVING count(*) > 1;
-- SELECT organization_id, transaction_number, count(*)
--   FROM journal_headers WHERE transaction_number IS NOT NULL
--   GROUP BY 1,2 HAVING count(*) > 1;

-- ── invoices: swap global unique(invoice_number) → unique(org, invoice_number) ──
ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_invoice_number_unique;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'invoices_org_invoice_number_unique'
  ) THEN
    ALTER TABLE invoices
      ADD CONSTRAINT invoices_org_invoice_number_unique
      UNIQUE (organization_id, invoice_number);
  END IF;
END $$;

-- ── journal_headers: add unique(org, transaction_number) ─────────────────────
-- NULL transaction_number is allowed and treated as distinct by Postgres, so rows
-- without an allocated number don't collide.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'journal_headers_org_transaction_number_unique'
  ) THEN
    ALTER TABLE journal_headers
      ADD CONSTRAINT journal_headers_org_transaction_number_unique
      UNIQUE (organization_id, transaction_number);
  END IF;
END $$;

COMMIT;
