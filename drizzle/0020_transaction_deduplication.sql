-- Transaction deduplication foundations.
--
-- This migration keeps the 0019 compatibility columns while separating provider
-- revisions, candidate/source lineage, and durable semantic duplicate cases.

-- Canonicalize identical document bytes before making the hash lookup race-safe.
-- The retained row favors already-enriched OCR/cache data, then the oldest row.
DROP INDEX IF EXISTS "idx_documents_org_content_hash";

UPDATE "documents"
SET "content_hash" = NULLIF(lower(btrim("content_hash")), '')
WHERE "content_hash" IS NOT NULL;

CREATE TEMP TABLE "transaction_dedup_document_map" AS
WITH ranked_documents AS (
  SELECT
    "id",
    first_value("id") OVER (
      PARTITION BY "organization_id", "content_hash"
      ORDER BY
        ("ai_transaction_cache" IS NOT NULL) DESC,
        ("metadata" IS NOT NULL) DESC,
        ("ocr_bounding_boxes" IS NOT NULL) DESC,
        "created_at" ASC,
        "id" ASC
    ) AS canonical_document_id,
    row_number() OVER (
      PARTITION BY "organization_id", "content_hash"
      ORDER BY
        ("ai_transaction_cache" IS NOT NULL) DESC,
        ("metadata" IS NOT NULL) DESC,
        ("ocr_bounding_boxes" IS NOT NULL) DESC,
        "created_at" ASC,
        "id" ASC
    ) AS document_rank
  FROM "documents"
  WHERE "content_hash" IS NOT NULL
)
SELECT
  "id" AS duplicate_document_id,
  canonical_document_id
FROM ranked_documents
WHERE document_rank > 1;

UPDATE "document_attachments" AS attachment
SET "document_id" = document_map.canonical_document_id
FROM "transaction_dedup_document_map" AS document_map
WHERE attachment."document_id" = document_map.duplicate_document_id;

DELETE FROM "document_attachments"
WHERE "id" IN (
  SELECT "id"
  FROM (
    SELECT
      "id",
      row_number() OVER (
        PARTITION BY "organization_id", "document_id", "linkable_type", "linkable_id"
        ORDER BY "created_at" ASC, "id" ASC
      ) AS attachment_rank
    FROM "document_attachments"
  ) AS ranked_attachments
  WHERE attachment_rank > 1
);

UPDATE "document_suggestions" AS suggestion
SET "document_id" = document_map.canonical_document_id
FROM "transaction_dedup_document_map" AS document_map
WHERE suggestion."document_id" = document_map.duplicate_document_id;

UPDATE "reconciliations" AS reconciliation
SET "statement_document_id" = document_map.canonical_document_id
FROM "transaction_dedup_document_map" AS document_map
WHERE reconciliation."statement_document_id" = document_map.duplicate_document_id;

INSERT INTO "source_record_documents" (
  "source_record_id",
  "document_id",
  "organization_id",
  "relationship",
  "created_at"
)
SELECT
  source_document."source_record_id",
  document_map.canonical_document_id,
  source_document."organization_id",
  source_document."relationship",
  source_document."created_at"
FROM "source_record_documents" AS source_document
INNER JOIN "transaction_dedup_document_map" AS document_map
  ON document_map.duplicate_document_id = source_document."document_id"
ON CONFLICT ("source_record_id", "document_id") DO NOTHING;

DELETE FROM "source_record_documents" AS source_document
USING "transaction_dedup_document_map" AS document_map
WHERE source_document."document_id" = document_map.duplicate_document_id;

DELETE FROM "documents" AS document
USING "transaction_dedup_document_map" AS document_map
WHERE document."id" = document_map.duplicate_document_id;

CREATE UNIQUE INDEX "idx_documents_org_content_hash"
  ON "documents" ("organization_id", "content_hash")
  WHERE "content_hash" IS NOT NULL;

DROP TABLE "transaction_dedup_document_map";

ALTER TABLE "source_records"
  ADD COLUMN IF NOT EXISTS "parent_source_record_id" uuid
    REFERENCES "source_records"("id") ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "record_state" varchar(24) NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS "economic_event_class" varchar(32) NOT NULL DEFAULT 'other',
  ADD COLUMN IF NOT EXISTS "direction" varchar(16) NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS "original_amount" numeric(20,8),
  ADD COLUMN IF NOT EXISTS "original_currency" varchar(3),
  ADD COLUMN IF NOT EXISTS "functional_amount" numeric(20,8),
  ADD COLUMN IF NOT EXISTS "functional_currency" varchar(3),
  ADD COLUMN IF NOT EXISTS "effective_date" date,
  ADD COLUMN IF NOT EXISTS "normalized_party" varchar(255),
  ADD COLUMN IF NOT EXISTS "normalized_reference" varchar(255),
  ADD COLUMN IF NOT EXISTS "source_account_ref" varchar(255),
  ADD COLUMN IF NOT EXISTS "matcher_input_hash" varchar(64),
  ADD COLUMN IF NOT EXISTS "matcher_version" integer NOT NULL DEFAULT 1;

UPDATE "source_records"
SET
  "original_amount" = COALESCE("original_amount", "amount"),
  "original_currency" = COALESCE("original_currency", upper("currency")),
  "effective_date" = COALESCE("effective_date", "transaction_date")
WHERE
  "original_amount" IS NULL
  OR "original_currency" IS NULL
  OR "effective_date" IS NULL;

DO $$ BEGIN
  ALTER TABLE "source_records"
    ADD CONSTRAINT "source_records_record_state_check"
    CHECK ("record_state" IN ('active', 'rejected', 'superseded')) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "source_records"
    ADD CONSTRAINT "source_records_direction_check"
    CHECK ("direction" IN ('inflow', 'outflow', 'neutral', 'unknown')) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "source_records"
    ADD CONSTRAINT "source_records_economic_event_class_check"
    CHECK (
      "economic_event_class" IN (
        'purchase',
        'sale',
        'bill_accrual',
        'bill_payment',
        'invoice_accrual',
        'invoice_payment',
        'transfer',
        'payroll',
        'other'
      )
    ) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "source_records_parent_idx"
  ON "source_records" ("parent_source_record_id");
CREATE INDEX IF NOT EXISTS "source_records_duplicate_lookup_idx"
  ON "source_records" (
    "organization_id",
    "original_currency",
    "original_amount",
    "direction",
    "effective_date"
  )
  WHERE "record_state" = 'active';

CREATE TABLE IF NOT EXISTS "source_record_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" text NOT NULL
    REFERENCES "auth_organizations"("id") ON DELETE CASCADE,
  "source_record_id" uuid NOT NULL
    REFERENCES "source_records"("id") ON DELETE CASCADE,
  "ingestion_event_id" uuid
    REFERENCES "ingestion_events"("id") ON DELETE SET NULL,
  "external_version" varchar(128) NOT NULL,
  "payload_hash" varchar(64),
  "provider_status" varchar(64),
  "raw_data" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "occurred_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "source_record_versions_source_version_unique"
  ON "source_record_versions" ("source_record_id", "external_version");
CREATE INDEX IF NOT EXISTS "source_record_versions_org_created_idx"
  ON "source_record_versions" ("organization_id", "created_at");
CREATE INDEX IF NOT EXISTS "source_record_versions_ingestion_event_idx"
  ON "source_record_versions" ("ingestion_event_id");

INSERT INTO "source_record_versions" (
  "organization_id",
  "source_record_id",
  "ingestion_event_id",
  "external_version",
  "provider_status",
  "raw_data",
  "created_at"
)
SELECT
  "organization_id",
  "id",
  "ingestion_event_id",
  "external_version",
  "provider_status",
  "raw_data",
  "created_at"
FROM "source_records"
ON CONFLICT ("source_record_id", "external_version") DO NOTHING;

-- Older provider-version rows remain available for audit but stop competing as
-- current logical records. Fresh installs have no rows to update.
WITH ranked_provider_records AS (
  SELECT
    "id",
    row_number() OVER (
      PARTITION BY "organization_id", "source_id", "external_id"
      ORDER BY "updated_at" DESC, "created_at" DESC, "id" DESC
    ) AS record_rank
  FROM "source_records"
  WHERE "source_id" IS NOT NULL AND "external_id" IS NOT NULL
)
UPDATE "source_records"
SET "record_state" = 'superseded'
WHERE "id" IN (
  SELECT "id"
  FROM ranked_provider_records
  WHERE record_rank > 1
);

-- Provider versions now live in source_record_versions. Keeping the legacy
-- version-shaped source-record uniqueness would prevent one logical record
-- from returning to a previously observed provider version.
DROP INDEX IF EXISTS "source_records_org_source_external_version_unique";
DROP INDEX IF EXISTS "source_records_org_source_external_unique";

CREATE UNIQUE INDEX "source_records_org_source_external_unique"
  ON "source_records" ("organization_id", "source_id", "external_id")
  WHERE
    "source_id" IS NOT NULL
    AND "external_id" IS NOT NULL
    AND "record_state" <> 'superseded';

ALTER TABLE "transaction_candidates"
  ADD COLUMN IF NOT EXISTS "request_idempotency_key" varchar(255);
CREATE UNIQUE INDEX IF NOT EXISTS "transaction_candidates_org_request_idempotency_unique"
  ON "transaction_candidates" ("organization_id", "request_idempotency_key")
  WHERE "request_idempotency_key" IS NOT NULL;

CREATE TABLE IF NOT EXISTS "transaction_candidate_sources" (
  "organization_id" text NOT NULL
    REFERENCES "auth_organizations"("id") ON DELETE CASCADE,
  "candidate_id" uuid NOT NULL
    REFERENCES "transaction_candidates"("id") ON DELETE CASCADE,
  "source_record_id" uuid NOT NULL
    REFERENCES "source_records"("id") ON DELETE RESTRICT,
  "relationship" varchar(24) NOT NULL DEFAULT 'origin',
  "is_primary" boolean NOT NULL DEFAULT false,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("candidate_id", "source_record_id"),
  CONSTRAINT "transaction_candidate_sources_relationship_check"
    CHECK ("relationship" IN ('origin', 'supporting', 'corroborating'))
);
CREATE UNIQUE INDEX IF NOT EXISTS "transaction_candidate_sources_primary_unique"
  ON "transaction_candidate_sources" ("candidate_id")
  WHERE "is_primary" = true;
CREATE INDEX IF NOT EXISTS "transaction_candidate_sources_org_source_idx"
  ON "transaction_candidate_sources" ("organization_id", "source_record_id");

INSERT INTO "transaction_candidate_sources" (
  "organization_id",
  "candidate_id",
  "source_record_id",
  "relationship",
  "is_primary",
  "created_at"
)
SELECT
  "organization_id",
  "id",
  "source_record_id",
  'origin',
  true,
  "created_at"
FROM "transaction_candidates"
WHERE "source_record_id" IS NOT NULL
ON CONFLICT ("candidate_id", "source_record_id") DO NOTHING;

ALTER TABLE "source_match_candidates"
  ADD COLUMN IF NOT EXISTS "match_class" varchar(24) NOT NULL DEFAULT 'duplicate',
  ADD COLUMN IF NOT EXISTS "disposition" varchar(16) NOT NULL DEFAULT 'blocking',
  ADD COLUMN IF NOT EXISTS "score" numeric(5,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "signals" jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS "algorithm_version" integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "left_input_hash" varchar(64),
  ADD COLUMN IF NOT EXISTS "right_input_hash" varchar(64),
  ADD COLUMN IF NOT EXISTS "lock_version" integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "resolution_action" varchar(32),
  ADD COLUMN IF NOT EXISTS "canonical_candidate_id" uuid
    REFERENCES "transaction_candidates"("id") ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "canonical_journal_header_id" uuid
    REFERENCES "journal_headers"("id") ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "resolution_reason" text,
  ADD COLUMN IF NOT EXISTS "resolution_idempotency_key" varchar(255),
  ADD COLUMN IF NOT EXISTS "updated_at" timestamptz NOT NULL DEFAULT now();

UPDATE "source_match_candidates"
SET
  "score" = LEAST(100, GREATEST(0, round(COALESCE("confidence", 0) * 100, 2))),
  "match_class" = CASE WHEN "match_type" = 'related' THEN 'related' ELSE 'duplicate' END;

CREATE UNIQUE INDEX IF NOT EXISTS "source_match_candidates_org_resolution_idempotency_unique"
  ON "source_match_candidates" ("organization_id", "resolution_idempotency_key")
  WHERE "resolution_idempotency_key" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "source_match_candidates_left_source_idx"
  ON "source_match_candidates" ("left_source_record_id");
CREATE INDEX IF NOT EXISTS "source_match_candidates_right_source_idx"
  ON "source_match_candidates" ("right_source_record_id");

DO $$ BEGIN
  ALTER TABLE "source_match_candidates"
    ADD CONSTRAINT "source_match_candidates_canonical_pair_check"
    CHECK ("left_source_record_id" < "right_source_record_id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "source_match_candidates"
    ADD CONSTRAINT "source_match_candidates_score_range_check"
    CHECK ("score" >= 0 AND "score" <= 100) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "source_match_candidates"
    ADD CONSTRAINT "source_match_candidates_match_class_check"
    CHECK ("match_class" IN ('duplicate', 'related')) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "source_match_candidates"
    ADD CONSTRAINT "source_match_candidates_disposition_check"
    CHECK ("disposition" IN ('blocking', 'shadow')) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "source_match_candidates"
    ADD CONSTRAINT "source_match_candidates_resolution_action_check"
    CHECK (
      "resolution_action" IS NULL
      OR "resolution_action" IN (
        'consolidate_candidates',
        'attach_to_posted',
        'keep_separate',
        'merge_posted',
        'reject_source'
      )
    ) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "ledger_source_links_origin_source_unique"
  ON "ledger_source_links" ("organization_id", "source_record_id")
  WHERE "relationship" = 'origin';

-- Existing organizations observe matches in shadow mode during calibration.
-- Configs initialized later inherit enforce mode from the rule definition.
UPDATE "review_rule_definitions"
SET
  "default_config" = jsonb_build_object(
    'mode', 'enforce',
    'matchWindowDays', 3,
    'blockingScore', 70,
    'shadowScore', 50,
    'algorithmVersion', 1
  ),
  "formula_version" = GREATEST("formula_version", 2)
WHERE "key" = 'possible_duplicate';

INSERT INTO "review_rule_configs" (
  "organization_id",
  "definition_id",
  "enabled",
  "impact",
  "lookback_months",
  "config",
  "version"
)
SELECT
  organization."id",
  definition."id",
  true,
  'blocking',
  12,
  jsonb_build_object(
    'mode', 'shadow',
    'matchWindowDays', 3,
    'blockingScore', 70,
    'shadowScore', 50,
    'algorithmVersion', 1
  ),
  2
FROM "auth_organizations" AS organization
INNER JOIN "review_rule_definitions" AS definition
  ON definition."key" = 'possible_duplicate'
ON CONFLICT ("organization_id", "definition_id") DO UPDATE
SET
  "config" =
    jsonb_build_object(
      'matchWindowDays', 3,
      'blockingScore', 70,
      'shadowScore', 50,
      'algorithmVersion', 1
    )
    || COALESCE("review_rule_configs"."config", '{}'::jsonb)
    || jsonb_build_object('mode', 'shadow'),
  "lookback_months" = GREATEST("review_rule_configs"."lookback_months", 12),
  "version" = GREATEST("review_rule_configs"."version", 2),
  "updated_at" = now();

ALTER TABLE "source_record_versions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "source_record_versions";
CREATE POLICY "tenant_isolation" ON "source_record_versions"
  USING (
    "organization_id" = current_setting('app.current_organization_id', true)
  )
  WITH CHECK (
    "organization_id" = current_setting('app.current_organization_id', true)
  );

ALTER TABLE "transaction_candidate_sources" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "transaction_candidate_sources";
CREATE POLICY "tenant_isolation" ON "transaction_candidate_sources"
  USING (
    "organization_id" = current_setting('app.current_organization_id', true)
  )
  WITH CHECK (
    "organization_id" = current_setting('app.current_organization_id', true)
  );
