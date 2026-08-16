-- Tenant-consistent transaction lineage.
--
-- Every UUID lineage relationship already has a single-column foreign key, but
-- that alone permits a child row labelled as organization A to reference an
-- organization B parent. Composite (organization_id, id) keys make the tenant
-- part of the relationship itself.
--
-- Foreign keys are installed NOT VALID intentionally. PostgreSQL enforces them
-- for every new or updated row immediately, while legacy mismatches remain
-- available for explicit preflight review and cleanup before validation.

CREATE UNIQUE INDEX IF NOT EXISTS "source_records_org_id_unique"
  ON "source_records" ("organization_id", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "documents_org_id_unique"
  ON "documents" ("organization_id", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "transaction_candidates_org_id_unique"
  ON "transaction_candidates" ("organization_id", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "journal_headers_org_id_unique"
  ON "journal_headers" ("organization_id", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "source_match_candidates_org_id_unique"
  ON "source_match_candidates" ("organization_id", "id");

-- Parent/child source lineage and provider-version history.
DO $$ BEGIN
  ALTER TABLE "source_records"
    ADD CONSTRAINT "source_records_org_parent_source_fk"
    FOREIGN KEY ("organization_id", "parent_source_record_id")
    REFERENCES "source_records" ("organization_id", "id")
    DEFERRABLE INITIALLY DEFERRED
    NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "source_record_versions"
    ADD CONSTRAINT "source_record_versions_org_source_fk"
    FOREIGN KEY ("organization_id", "source_record_id")
    REFERENCES "source_records" ("organization_id", "id")
    ON DELETE CASCADE
    NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Document evidence must belong to the same organization as both endpoints.
DO $$ BEGIN
  ALTER TABLE "source_record_documents"
    ADD CONSTRAINT "source_record_documents_org_source_fk"
    FOREIGN KEY ("organization_id", "source_record_id")
    REFERENCES "source_records" ("organization_id", "id")
    ON DELETE CASCADE
    NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "source_record_documents"
    ADD CONSTRAINT "source_record_documents_org_document_fk"
    FOREIGN KEY ("organization_id", "document_id")
    REFERENCES "documents" ("organization_id", "id")
    ON DELETE CASCADE
    NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Compatibility and many-source candidate lineage.
DO $$ BEGIN
  ALTER TABLE "transaction_candidates"
    ADD CONSTRAINT "transaction_candidates_org_source_fk"
    FOREIGN KEY ("organization_id", "source_record_id")
    REFERENCES "source_records" ("organization_id", "id")
    DEFERRABLE INITIALLY DEFERRED
    NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "transaction_candidate_sources"
    ADD CONSTRAINT "transaction_candidate_sources_org_candidate_fk"
    FOREIGN KEY ("organization_id", "candidate_id")
    REFERENCES "transaction_candidates" ("organization_id", "id")
    ON DELETE CASCADE
    NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "transaction_candidate_sources"
    ADD CONSTRAINT "transaction_candidate_sources_org_source_fk"
    FOREIGN KEY ("organization_id", "source_record_id")
    REFERENCES "source_records" ("organization_id", "id")
    ON DELETE RESTRICT
    NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Duplicate cases: both compared sources and both optional canonical targets.
DO $$ BEGIN
  ALTER TABLE "source_match_candidates"
    ADD CONSTRAINT "source_match_candidates_org_left_source_fk"
    FOREIGN KEY ("organization_id", "left_source_record_id")
    REFERENCES "source_records" ("organization_id", "id")
    ON DELETE CASCADE
    NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "source_match_candidates"
    ADD CONSTRAINT "source_match_candidates_org_right_source_fk"
    FOREIGN KEY ("organization_id", "right_source_record_id")
    REFERENCES "source_records" ("organization_id", "id")
    ON DELETE CASCADE
    NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "source_match_candidates"
    ADD CONSTRAINT "source_match_candidates_org_canonical_candidate_fk"
    FOREIGN KEY ("organization_id", "canonical_candidate_id")
    REFERENCES "transaction_candidates" ("organization_id", "id")
    DEFERRABLE INITIALLY DEFERRED
    NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "source_match_candidates"
    ADD CONSTRAINT "source_match_candidates_org_canonical_journal_fk"
    FOREIGN KEY ("organization_id", "canonical_journal_header_id")
    REFERENCES "journal_headers" ("organization_id", "id")
    DEFERRABLE INITIALLY DEFERRED
    NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Posted-journal provenance and the duplicate pointer itself.
DO $$ BEGIN
  ALTER TABLE "ledger_source_links"
    ADD CONSTRAINT "ledger_source_links_org_journal_fk"
    FOREIGN KEY ("organization_id", "journal_header_id")
    REFERENCES "journal_headers" ("organization_id", "id")
    ON DELETE CASCADE
    NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "ledger_source_links"
    ADD CONSTRAINT "ledger_source_links_org_source_fk"
    FOREIGN KEY ("organization_id", "source_record_id")
    REFERENCES "source_records" ("organization_id", "id")
    ON DELETE RESTRICT
    NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "journal_headers"
    ADD CONSTRAINT "journal_headers_org_duplicate_of_fk"
    FOREIGN KEY ("organization_id", "duplicate_of_header_id")
    REFERENCES "journal_headers" ("organization_id", "id")
    ON DELETE RESTRICT
    NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Durable posted-merge decisions must remain wholly inside one organization.
DO $$ BEGIN
  ALTER TABLE "journal_duplicate_merges"
    ADD CONSTRAINT "journal_duplicate_merges_org_canonical_fk"
    FOREIGN KEY ("organization_id", "canonical_header_id")
    REFERENCES "journal_headers" ("organization_id", "id")
    ON DELETE RESTRICT
    NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "journal_duplicate_merges"
    ADD CONSTRAINT "journal_duplicate_merges_org_duplicate_fk"
    FOREIGN KEY ("organization_id", "duplicate_header_id")
    REFERENCES "journal_headers" ("organization_id", "id")
    ON DELETE RESTRICT
    NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Drizzle schema-push databases created the table before 0021 and may not have
-- received 0021's inline duplicate_case_id FK because CREATE TABLE IF NOT EXISTS
-- does not retrofit constraints. Ensure its intended SET NULL lifecycle exists
-- before adding the tenant-qualified, deferred guard below.
DO $$
DECLARE
  duplicate_case_attribute smallint;
BEGIN
  SELECT attribute.attnum
  INTO duplicate_case_attribute
  FROM pg_attribute AS attribute
  WHERE
    attribute.attrelid = 'journal_duplicate_merges'::regclass
    AND attribute.attname = 'duplicate_case_id'
    AND NOT attribute.attisdropped;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint AS constraint_row
    WHERE
      constraint_row.conrelid = 'journal_duplicate_merges'::regclass
      AND constraint_row.confrelid = 'source_match_candidates'::regclass
      AND constraint_row.contype = 'f'
      AND constraint_row.conkey = ARRAY[duplicate_case_attribute]::smallint[]
  ) THEN
    ALTER TABLE "journal_duplicate_merges"
      ADD CONSTRAINT "journal_duplicate_merges_duplicate_case_id_fk"
      FOREIGN KEY ("duplicate_case_id")
      REFERENCES "source_match_candidates" ("id")
      ON DELETE SET NULL
      NOT VALID;
  END IF;
END $$;

DO $$ BEGIN
  ALTER TABLE "journal_duplicate_merges"
    ADD CONSTRAINT "journal_duplicate_merges_org_case_fk"
    FOREIGN KEY ("organization_id", "duplicate_case_id")
    REFERENCES "source_match_candidates" ("organization_id", "id")
    DEFERRABLE INITIALLY DEFERRED
    NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
