-- Non-destructive, permissioned journal duplicate matching.
--
-- This migration deliberately leaves the legacy match_history table intact for
-- read-only migration/audit. New matches never delete a journal or journal line.

ALTER TABLE "journal_headers"
  ADD COLUMN IF NOT EXISTS "duplicate_of_header_id" uuid;

DO $$ BEGIN
  ALTER TABLE "journal_headers"
    ADD CONSTRAINT "journal_headers_duplicate_of_header_id_fk"
    FOREIGN KEY ("duplicate_of_header_id")
    REFERENCES "journal_headers"("id")
    ON DELETE RESTRICT;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "journal_headers"
    ADD CONSTRAINT "journal_headers_not_own_duplicate_check"
    CHECK ("duplicate_of_header_id" IS NULL OR "duplicate_of_header_id" <> "id");
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "journal_headers_org_duplicate_of_idx"
  ON "journal_headers" ("organization_id", "duplicate_of_header_id");

CREATE TABLE IF NOT EXISTS "journal_duplicate_merges" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" text NOT NULL,
  "canonical_header_id" uuid NOT NULL REFERENCES "journal_headers"("id") ON DELETE RESTRICT,
  "duplicate_header_id" uuid NOT NULL REFERENCES "journal_headers"("id") ON DELETE RESTRICT,
  "duplicate_case_id" uuid REFERENCES "source_match_candidates"("id") ON DELETE SET NULL,
  "pair_key" varchar(73) NOT NULL,
  "state" varchar(24) NOT NULL DEFAULT 'active',
  "reason" text NOT NULL,
  "evidence" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "idempotency_key" varchar(255) NOT NULL,
  "matched_at" timestamptz NOT NULL DEFAULT now(),
  "matched_by" text NOT NULL,
  "reversed_at" timestamptz,
  "reversed_by" text,
  "reversal_reason" text,
  "reversal_idempotency_key" varchar(255),
  CONSTRAINT "journal_duplicate_merges_distinct_headers_check"
    CHECK ("canonical_header_id" <> "duplicate_header_id"),
  CONSTRAINT "journal_duplicate_merges_pair_key_check"
    CHECK (
      "pair_key" =
        LEAST("canonical_header_id"::text, "duplicate_header_id"::text)
        || ':' ||
        GREATEST("canonical_header_id"::text, "duplicate_header_id"::text)
    ),
  CONSTRAINT "journal_duplicate_merges_state_check"
    CHECK ("state" IN ('active', 'reversed', 'quarantined')),
  CONSTRAINT "journal_duplicate_merges_reversal_check"
    CHECK (
      ("state" = 'active' AND "reversed_at" IS NULL AND "reversed_by" IS NULL)
      OR
      ("state" <> 'active' AND "reversed_at" IS NOT NULL)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS "journal_duplicate_merges_org_idempotency_unique"
  ON "journal_duplicate_merges" ("organization_id", "idempotency_key");
CREATE UNIQUE INDEX IF NOT EXISTS "journal_duplicate_merges_org_reversal_idempotency_unique"
  ON "journal_duplicate_merges" ("organization_id", "reversal_idempotency_key")
  WHERE "reversal_idempotency_key" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "journal_duplicate_merges_active_pair_unique"
  ON "journal_duplicate_merges" ("organization_id", "pair_key")
  WHERE "state" = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS "journal_duplicate_merges_active_duplicate_unique"
  ON "journal_duplicate_merges" ("organization_id", "duplicate_header_id")
  WHERE "state" = 'active';
CREATE INDEX IF NOT EXISTS "journal_duplicate_merges_org_canonical_idx"
  ON "journal_duplicate_merges" ("organization_id", "canonical_header_id", "state");
CREATE INDEX IF NOT EXISTS "journal_duplicate_merges_case_idx"
  ON "journal_duplicate_merges" ("duplicate_case_id");

ALTER TABLE "journal_duplicate_merges" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "org_isolation_journal_duplicate_merges" ON "journal_duplicate_merges";
CREATE POLICY "org_isolation_journal_duplicate_merges"
  ON "journal_duplicate_merges"
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

COMMENT ON COLUMN "journal_headers"."duplicate_of_header_id" IS
  'When non-null, this immutable journal is a confirmed duplicate excluded from effective accounting.';
COMMENT ON TABLE "journal_duplicate_merges" IS
  'Auditable, reversible journal duplicate decisions. Neither journal nor its lines are deleted.';
