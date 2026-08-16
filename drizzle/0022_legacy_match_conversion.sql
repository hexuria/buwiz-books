-- Durable, idempotent conversion/quarantine ledger for destructive legacy
-- match_history rows. Invalid snapshots cannot be represented by
-- journal_duplicate_merges because that table correctly requires two existing
-- journal-header foreign keys.

CREATE TABLE IF NOT EXISTS "legacy_match_conversion_records" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" text NOT NULL,
  "legacy_match_history_id" uuid NOT NULL
    REFERENCES "match_history"("id") ON DELETE RESTRICT,
  "status" varchar(24) NOT NULL,
  "journal_duplicate_merge_id" uuid
    REFERENCES "journal_duplicate_merges"("id") ON DELETE RESTRICT,
  "snapshot_duplicate_header_id" uuid,
  "snapshot_digest" varchar(64) NOT NULL,
  "validator_version" varchar(64) NOT NULL,
  "reason_codes" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "details" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "processed_at" timestamptz NOT NULL DEFAULT now(),
  "processed_by" text NOT NULL,
  "reviewed_at" timestamptz,
  "reviewed_by" text,
  "review_note" text,
  CONSTRAINT "legacy_match_conversion_records_status_check"
    CHECK ("status" IN ('converted', 'quarantined')),
  CONSTRAINT "legacy_match_conversion_records_digest_check"
    CHECK ("snapshot_digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "legacy_match_conversion_records_disposition_check"
    CHECK (
      (
        "status" = 'converted'
        AND "journal_duplicate_merge_id" IS NOT NULL
        AND jsonb_array_length("reason_codes") = 0
      )
      OR
      (
        "status" = 'quarantined'
        AND "journal_duplicate_merge_id" IS NULL
        AND jsonb_array_length("reason_codes") > 0
      )
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS "legacy_match_conversion_records_history_unique"
  ON "legacy_match_conversion_records" ("legacy_match_history_id");
CREATE INDEX IF NOT EXISTS "legacy_match_conversion_records_org_status_idx"
  ON "legacy_match_conversion_records" ("organization_id", "status", "processed_at");

ALTER TABLE "legacy_match_conversion_records" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "org_isolation_legacy_match_conversion_records"
  ON "legacy_match_conversion_records";
CREATE POLICY "org_isolation_legacy_match_conversion_records"
  ON "legacy_match_conversion_records"
  FOR ALL
  USING (
    current_setting('app.current_organization_id', true) = ''
    OR current_setting('app.current_organization_id', true) IS NULL
    OR "organization_id" = current_setting('app.current_organization_id', true)
  )
  WITH CHECK (
    current_setting('app.current_organization_id', true) = ''
    OR current_setting('app.current_organization_id', true) IS NULL
    OR "organization_id" = current_setting('app.current_organization_id', true)
  );

COMMENT ON TABLE "legacy_match_conversion_records" IS
  'Durable conversion or manual-quarantine result for each active destructive match_history row.';
