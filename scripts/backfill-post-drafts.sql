-- ============================================================================
-- Backfill: post historical DRAFT transactions so they appear in reports.
-- ============================================================================
-- WHY: before the auto-post fix, manual/CSV-import/reconciliation-created
-- transactions were written as `draft` with no UI to post them, so they never
-- showed in the P&L / Balance Sheet / Trial Balance / Cash Flow (which count
-- `posted` only). This one-time backfill posts the stranded drafts.
--
-- SAFETY:
--   • Only BALANCED drafts (sum(debit) = sum(credit)) are posted. Unbalanced
--     drafts are LEFT AS-IS and reported for manual review — never post a
--     broken entry.
--   • Sets posted_at = now() (does not fabricate a historical timestamp; the
--     transaction_date is unchanged, so period placement is correct).
--   • Idempotent: re-running only affects rows still in `draft`.
--   • Suppressed duplicate journals are never posted or included in the
--     actionable draft counts.
--   • Wrapped in a transaction — inspect the "BEFORE"/"AFTER" notices, and if
--     anything looks wrong, it rolls back on error.
--
-- RUN (against the target DB — take a backup first on production):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/backfill-post-drafts.sql
-- ============================================================================

BEGIN;

-- ── BEFORE: what exists ──────────────────────────────────────────────────────
DO $$
DECLARE
  bal int;
  unbal int;
  zero_line int;
  locked int;
BEGIN
  SELECT
    count(*) FILTER (
      WHERE line_count >= 2
        AND round(deb,2) = round(cred,2)
        AND (closed_through IS NULL OR transaction_date > closed_through)
    ),
    count(*) FILTER (WHERE line_count > 0 AND round(deb,2) <> round(cred,2)),
    count(*) FILTER (WHERE line_count = 0),
    count(*) FILTER (
      WHERE closed_through IS NOT NULL AND transaction_date <= closed_through
    )
  INTO bal, unbal, zero_line, locked
  FROM (
    SELECT h.id, h.transaction_date, o.closed_through,
           count(l.id) AS line_count,
           coalesce(sum(l.debit),0)  AS deb,
           coalesce(sum(l.credit),0) AS cred
    FROM journal_headers h
    LEFT JOIN journal_lines l ON l.journal_header_id = h.id
    LEFT JOIN auth_organizations o ON o.id = h.organization_id
    WHERE h.status = 'draft'
      AND h.duplicate_of_header_id IS NULL
    GROUP BY h.id, o.closed_through
  ) s;
  RAISE NOTICE
    'BEFORE: % balanced open-period draft(s) will be posted; % unbalanced, % zero-line, and % locked-period draft(s) will be SKIPPED.',
    bal, unbal, zero_line, locked;
END $$;

-- ── POST the balanced drafts ─────────────────────────────────────────────────
WITH balanced AS (
  SELECT h.id
  FROM journal_headers h
  JOIN journal_lines l ON l.journal_header_id = h.id
  LEFT JOIN auth_organizations o ON o.id = h.organization_id
  WHERE h.status = 'draft'
    AND h.duplicate_of_header_id IS NULL
  GROUP BY h.id, o.closed_through
  HAVING count(l.id) >= 2
     AND round(coalesce(sum(l.debit),0), 2) = round(coalesce(sum(l.credit),0), 2)
     AND (o.closed_through IS NULL OR h.transaction_date > o.closed_through)
)
UPDATE journal_headers h
SET status = 'posted',
    posted_at = now(),
    updated_at = now()
FROM balanced b
WHERE h.id = b.id;

-- ── AFTER: report remaining unbalanced drafts (need manual attention) ────────
DO $$
DECLARE
  remaining int;
BEGIN
  SELECT count(*) INTO remaining
  FROM journal_headers
  WHERE status = 'draft'
    AND duplicate_of_header_id IS NULL;
  RAISE NOTICE 'AFTER: % draft(s) remain (unbalanced — review these manually).', remaining;
END $$;

-- Review the notices above, then:
COMMIT;

-- To list the unbalanced drafts that were skipped:
--   SELECT h.id, h.transaction_number, h.transaction_date, h.source,
--          round(coalesce(sum(l.debit),0),2)  AS debits,
--          round(coalesce(sum(l.credit),0),2) AS credits
--   FROM journal_headers h
--   LEFT JOIN journal_lines l ON l.journal_header_id = h.id
--   WHERE h.status = 'draft'
--     AND h.duplicate_of_header_id IS NULL
--   GROUP BY h.id;
