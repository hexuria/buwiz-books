-- Migration: cleared/uncleared reconciliation snapshot columns (audit Bucket B #17).
-- Written at finalize time:
--   cleared_balance  = statement opening + net of MATCHED (cleared) bank activity
--   uncleared_total  = net of posted GL activity NOT cleared by the reconciliation
--                      (outstanding checks / deposits in transit — timing differences)
-- Nullable; historical finalized reconciliations simply have no snapshot.
ALTER TABLE reconciliations ADD COLUMN IF NOT EXISTS cleared_balance numeric(15, 2);
ALTER TABLE reconciliations ADD COLUMN IF NOT EXISTS uncleared_total numeric(15, 2);
