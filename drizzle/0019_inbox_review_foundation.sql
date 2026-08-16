-- Inbox-first ingestion, review agents, firm access, and multi-currency ledger support.
-- This migration is additive: existing posted journals remain unchanged.

DO $$ BEGIN
  ALTER TYPE "journal_source" ADD VALUE IF NOT EXISTS 'document';
  ALTER TYPE "journal_source" ADD VALUE IF NOT EXISTS 'email';
  ALTER TYPE "journal_source" ADD VALUE IF NOT EXISTS 'integration';
  ALTER TYPE "journal_source" ADD VALUE IF NOT EXISTS 'payment';
END $$;

ALTER TABLE "journal_headers"
  ALTER COLUMN "total_amount" TYPE numeric(20,8),
  ADD COLUMN IF NOT EXISTS "functional_currency" varchar(3) NOT NULL DEFAULT 'USD',
  ADD COLUMN IF NOT EXISTS "transaction_currency" varchar(3),
  ADD COLUMN IF NOT EXISTS "exchange_rate_id" uuid;

ALTER TABLE "journal_lines"
  ALTER COLUMN "debit" TYPE numeric(20,8),
  ALTER COLUMN "credit" TYPE numeric(20,8),
  ADD COLUMN IF NOT EXISTS "original_debit" numeric(20,8),
  ADD COLUMN IF NOT EXISTS "original_credit" numeric(20,8),
  ADD COLUMN IF NOT EXISTS "original_currency" varchar(3),
  ADD COLUMN IF NOT EXISTS "exchange_rate" numeric(20,10),
  ADD COLUMN IF NOT EXISTS "exchange_rate_id" uuid;

CREATE TABLE IF NOT EXISTS "organization_accounting_settings" (
  "organization_id" text PRIMARY KEY REFERENCES "auth_organizations"("id") ON DELETE CASCADE,
  "base_currency" varchar(3) NOT NULL DEFAULT 'USD',
  "timezone" varchar(64) NOT NULL DEFAULT 'UTC',
  "inbound_email_address" varchar(320),
  "review_policy" varchar(32) NOT NULL DEFAULT 'always_review',
  "require_different_approver" boolean NOT NULL DEFAULT true,
  "allow_owner_override" boolean NOT NULL DEFAULT true,
  "low_confidence_threshold" numeric(5,4) NOT NULL DEFAULT 0.8000,
  "missing_receipt_threshold" numeric(20,8) NOT NULL DEFAULT 75,
  "missing_receipt_currency" varchar(3) NOT NULL DEFAULT 'USD',
  "fx_gain_account_id" uuid REFERENCES "accounts"("id"),
  "fx_loss_account_id" uuid REFERENCES "accounts"("id"),
  "fx_rounding_account_id" uuid REFERENCES "accounts"("id"),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "organization_accounting_settings_inbound_email_unique"
  ON "organization_accounting_settings" ("inbound_email_address")
  WHERE "inbound_email_address" IS NOT NULL;

CREATE TABLE IF NOT EXISTS "firms" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" varchar(255) NOT NULL,
  "slug" varchar(120) NOT NULL UNIQUE,
  "created_by" text REFERENCES "auth_users"("id"),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS "firm_members" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "firm_id" uuid NOT NULL REFERENCES "firms"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL REFERENCES "auth_users"("id") ON DELETE CASCADE,
  "role" varchar(32) NOT NULL DEFAULT 'preparer',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "firm_members_firm_user_unique"
  ON "firm_members" ("firm_id", "user_id");
CREATE INDEX IF NOT EXISTS "firm_members_user_idx" ON "firm_members" ("user_id");

CREATE TABLE IF NOT EXISTS "firm_clients" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "firm_id" uuid NOT NULL REFERENCES "firms"("id") ON DELETE CASCADE,
  "organization_id" text NOT NULL REFERENCES "auth_organizations"("id") ON DELETE CASCADE,
  "status" varchar(24) NOT NULL DEFAULT 'active',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "firm_clients_firm_org_unique"
  ON "firm_clients" ("firm_id", "organization_id");
CREATE INDEX IF NOT EXISTS "firm_clients_org_idx" ON "firm_clients" ("organization_id");

CREATE TABLE IF NOT EXISTS "firm_member_client_access" (
  "firm_member_id" uuid NOT NULL REFERENCES "firm_members"("id") ON DELETE CASCADE,
  "organization_id" text NOT NULL REFERENCES "auth_organizations"("id") ON DELETE CASCADE,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("firm_member_id", "organization_id")
);
CREATE INDEX IF NOT EXISTS "firm_member_client_access_org_idx"
  ON "firm_member_client_access" ("organization_id");

CREATE TABLE IF NOT EXISTS "fx_rates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" text NOT NULL REFERENCES "auth_organizations"("id") ON DELETE CASCADE,
  "base_currency" varchar(3) NOT NULL,
  "quote_currency" varchar(3) NOT NULL,
  "effective_date" date NOT NULL,
  "rate" numeric(20,10) NOT NULL,
  "source" varchar(32) NOT NULL,
  "provider_reference" varchar(255),
  "is_manual_override" boolean NOT NULL DEFAULT false,
  "override_reason" text,
  "created_by" text REFERENCES "auth_users"("id"),
  "retrieved_at" timestamptz NOT NULL DEFAULT now(),
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "fx_rates_org_pair_date_source_unique"
  ON "fx_rates" ("organization_id", "base_currency", "quote_currency", "effective_date", "source");
CREATE INDEX IF NOT EXISTS "fx_rates_org_pair_date_idx"
  ON "fx_rates" ("organization_id", "base_currency", "quote_currency", "effective_date");

CREATE TABLE IF NOT EXISTS "integration_connections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" text NOT NULL REFERENCES "auth_organizations"("id") ON DELETE CASCADE,
  "provider" varchar(64) NOT NULL,
  "domain" varchar(32) NOT NULL,
  "status" varchar(32) NOT NULL DEFAULT 'pending',
  "external_tenant_id" varchar(255),
  "secret_ref" text,
  "scopes" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "config" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "sync_cursor" text,
  "last_synced_at" timestamptz,
  "next_sync_at" timestamptz,
  "last_error" text,
  "created_by" text REFERENCES "auth_users"("id"),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "integration_connections_org_provider_tenant_unique"
  ON "integration_connections" ("organization_id", "provider", "external_tenant_id")
  WHERE "external_tenant_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "integration_connections_org_status_idx"
  ON "integration_connections" ("organization_id", "status");

CREATE TABLE IF NOT EXISTS "integration_sources" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" text NOT NULL REFERENCES "auth_organizations"("id") ON DELETE CASCADE,
  "connection_id" uuid REFERENCES "integration_connections"("id") ON DELETE CASCADE,
  "provider" varchar(64) NOT NULL,
  "channel" varchar(32) NOT NULL,
  "external_source_id" varchar(255),
  "name" varchar(255) NOT NULL,
  "currency" varchar(3),
  "ledger_account_id" uuid REFERENCES "accounts"("id"),
  "import_start_date" date,
  "status" varchar(32) NOT NULL DEFAULT 'active',
  "config" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "integration_sources_org_provider_external_unique"
  ON "integration_sources" ("organization_id", "provider", "external_source_id")
  WHERE "external_source_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "integration_sources_org_channel_idx"
  ON "integration_sources" ("organization_id", "channel");

CREATE TABLE IF NOT EXISTS "integration_sync_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" text NOT NULL REFERENCES "auth_organizations"("id") ON DELETE CASCADE,
  "connection_id" uuid NOT NULL REFERENCES "integration_connections"("id") ON DELETE CASCADE,
  "run_type" varchar(24) NOT NULL,
  "status" varchar(24) NOT NULL DEFAULT 'running',
  "cursor_before" text,
  "cursor_after" text,
  "counts" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "last_error" text,
  "started_at" timestamptz NOT NULL DEFAULT now(),
  "completed_at" timestamptz
);
CREATE INDEX IF NOT EXISTS "integration_sync_runs_connection_started_idx"
  ON "integration_sync_runs" ("connection_id", "started_at");

CREATE TABLE IF NOT EXISTS "ingestion_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" text NOT NULL REFERENCES "auth_organizations"("id") ON DELETE CASCADE,
  "connection_id" uuid REFERENCES "integration_connections"("id") ON DELETE SET NULL,
  "source_id" uuid REFERENCES "integration_sources"("id") ON DELETE SET NULL,
  "channel" varchar(32) NOT NULL,
  "provider" varchar(64) NOT NULL,
  "provider_event_id" varchar(255),
  "external_object_id" varchar(255),
  "external_version" varchar(128),
  "payload_hash" varchar(64),
  "payload" jsonb,
  "headers" jsonb,
  "raw_object_key" text,
  "status" varchar(32) NOT NULL DEFAULT 'received',
  "correlation_id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "attempts" integer NOT NULL DEFAULT 0,
  "last_error" text,
  "occurred_at" timestamptz,
  "received_at" timestamptz NOT NULL DEFAULT now(),
  "processed_at" timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS "ingestion_events_org_provider_event_unique"
  ON "ingestion_events" ("organization_id", "provider", "provider_event_id")
  WHERE "provider_event_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "ingestion_events_org_status_received_idx"
  ON "ingestion_events" ("organization_id", "status", "received_at");

CREATE TABLE IF NOT EXISTS "processing_jobs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" text NOT NULL REFERENCES "auth_organizations"("id") ON DELETE CASCADE,
  "ingestion_event_id" uuid REFERENCES "ingestion_events"("id") ON DELETE CASCADE,
  "job_type" varchar(64) NOT NULL,
  "status" varchar(24) NOT NULL DEFAULT 'queued',
  "payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "dedupe_key" varchar(255),
  "correlation_id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "attempts" integer NOT NULL DEFAULT 0,
  "max_attempts" integer NOT NULL DEFAULT 8,
  "run_at" timestamptz NOT NULL DEFAULT now(),
  "locked_by" varchar(128),
  "locked_until" timestamptz,
  "last_error" text,
  "completed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "processing_jobs_org_dedupe_unique"
  ON "processing_jobs" ("organization_id", "dedupe_key")
  WHERE "dedupe_key" IS NOT NULL AND "status" IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS "processing_jobs_claim_idx"
  ON "processing_jobs" ("status", "run_at", "locked_until");
CREATE INDEX IF NOT EXISTS "processing_jobs_org_status_idx"
  ON "processing_jobs" ("organization_id", "status");

CREATE TABLE IF NOT EXISTS "source_records" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" text NOT NULL REFERENCES "auth_organizations"("id") ON DELETE CASCADE,
  "source_id" uuid REFERENCES "integration_sources"("id") ON DELETE SET NULL,
  "ingestion_event_id" uuid REFERENCES "ingestion_events"("id") ON DELETE SET NULL,
  "record_type" varchar(32) NOT NULL,
  "external_id" varchar(255),
  "external_version" varchar(128) NOT NULL DEFAULT '1',
  "provider_status" varchar(64),
  "transaction_date" date,
  "description" text,
  "amount" numeric(20,8),
  "currency" varchar(3),
  "raw_data" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "source_records_org_source_external_version_unique"
  ON "source_records" ("organization_id", "source_id", "external_id", "external_version")
  WHERE "external_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "source_records_org_date_idx"
  ON "source_records" ("organization_id", "transaction_date");

CREATE TABLE IF NOT EXISTS "source_record_documents" (
  "source_record_id" uuid NOT NULL REFERENCES "source_records"("id") ON DELETE CASCADE,
  "document_id" uuid NOT NULL REFERENCES "documents"("id") ON DELETE CASCADE,
  "organization_id" text NOT NULL REFERENCES "auth_organizations"("id") ON DELETE CASCADE,
  "relationship" varchar(32) NOT NULL DEFAULT 'evidence',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("source_record_id", "document_id")
);
CREATE INDEX IF NOT EXISTS "source_record_documents_org_idx"
  ON "source_record_documents" ("organization_id");

CREATE TABLE IF NOT EXISTS "transaction_candidates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" text NOT NULL REFERENCES "auth_organizations"("id") ON DELETE CASCADE,
  "source_record_id" uuid REFERENCES "source_records"("id") ON DELETE SET NULL,
  "revision" integer NOT NULL DEFAULT 1,
  "status" varchar(24) NOT NULL DEFAULT 'current',
  "candidate_type" varchar(32) NOT NULL DEFAULT 'transaction',
  "transaction_date" date NOT NULL,
  "transaction_type" varchar(24) NOT NULL,
  "memo" text,
  "reference_number" varchar(100),
  "party_id" uuid REFERENCES "parties"("id"),
  "original_currency" varchar(3) NOT NULL,
  "functional_currency" varchar(3) NOT NULL,
  "exchange_rate_id" uuid REFERENCES "fx_rates"("id"),
  "exchange_rate" numeric(20,10) NOT NULL DEFAULT 1,
  "original_total" numeric(20,8),
  "functional_total" numeric(20,8),
  "submitted_by" text REFERENCES "auth_users"("id"),
  "submitted_at" timestamptz NOT NULL DEFAULT now(),
  "superseded_by_id" uuid,
  "posted_journal_header_id" uuid REFERENCES "journal_headers"("id"),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "transaction_candidates_org_status_idx"
  ON "transaction_candidates" ("organization_id", "status");
CREATE INDEX IF NOT EXISTS "transaction_candidates_source_record_idx"
  ON "transaction_candidates" ("source_record_id");

CREATE TABLE IF NOT EXISTS "transaction_candidate_lines" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" text NOT NULL REFERENCES "auth_organizations"("id") ON DELETE CASCADE,
  "candidate_id" uuid NOT NULL REFERENCES "transaction_candidates"("id") ON DELETE CASCADE,
  "account_id" uuid REFERENCES "accounts"("id"),
  "original_debit" numeric(20,8),
  "original_credit" numeric(20,8),
  "functional_debit" numeric(20,8),
  "functional_credit" numeric(20,8),
  "original_currency" varchar(3) NOT NULL,
  "exchange_rate" numeric(20,10) NOT NULL DEFAULT 1,
  "line_description" text,
  "party_id" uuid REFERENCES "parties"("id"),
  "department_id" uuid REFERENCES "dimensions"("id"),
  "location_id" uuid REFERENCES "dimensions"("id"),
  "category_confidence" numeric(5,4),
  "prediction_evidence" jsonb,
  "sort_order" integer NOT NULL DEFAULT 0,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "transaction_candidate_lines_candidate_idx"
  ON "transaction_candidate_lines" ("candidate_id", "sort_order");
CREATE INDEX IF NOT EXISTS "transaction_candidate_lines_org_account_idx"
  ON "transaction_candidate_lines" ("organization_id", "account_id");

CREATE TABLE IF NOT EXISTS "inbox_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" text NOT NULL REFERENCES "auth_organizations"("id") ON DELETE CASCADE,
  "candidate_id" uuid REFERENCES "transaction_candidates"("id") ON DELETE CASCADE,
  "source_record_id" uuid REFERENCES "source_records"("id") ON DELETE SET NULL,
  "item_type" varchar(48) NOT NULL DEFAULT 'approve_transaction',
  "state" varchar(32) NOT NULL DEFAULT 'ready_for_review',
  "priority" varchar(16) NOT NULL DEFAULT 'normal',
  "title" varchar(255) NOT NULL,
  "assignee_id" text REFERENCES "auth_users"("id"),
  "submitted_by" text REFERENCES "auth_users"("id"),
  "candidate_revision" integer NOT NULL DEFAULT 1,
  "due_at" timestamptz,
  "resolved_by" text REFERENCES "auth_users"("id"),
  "resolved_at" timestamptz,
  "resolution_note" text,
  "lock_version" integer NOT NULL DEFAULT 1,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "inbox_items_candidate_unique"
  ON "inbox_items" ("candidate_id") WHERE "candidate_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "inbox_items_org_state_created_idx"
  ON "inbox_items" ("organization_id", "state", "created_at");
CREATE INDEX IF NOT EXISTS "inbox_items_assignee_state_idx"
  ON "inbox_items" ("assignee_id", "state");

CREATE TABLE IF NOT EXISTS "inbox_watchers" (
  "inbox_item_id" uuid NOT NULL REFERENCES "inbox_items"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL REFERENCES "auth_users"("id") ON DELETE CASCADE,
  "organization_id" text NOT NULL REFERENCES "auth_organizations"("id") ON DELETE CASCADE,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("inbox_item_id", "user_id")
);
CREATE INDEX IF NOT EXISTS "inbox_watchers_user_idx" ON "inbox_watchers" ("user_id");

CREATE TABLE IF NOT EXISTS "review_rule_definitions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "key" varchar(64) NOT NULL UNIQUE,
  "name" varchar(120) NOT NULL,
  "group_name" varchar(16) NOT NULL,
  "evaluator_key" varchar(64) NOT NULL,
  "default_config" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "formula_version" integer NOT NULL DEFAULT 1,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS "review_rule_configs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" text NOT NULL REFERENCES "auth_organizations"("id") ON DELETE CASCADE,
  "definition_id" uuid NOT NULL REFERENCES "review_rule_definitions"("id") ON DELETE CASCADE,
  "enabled" boolean NOT NULL DEFAULT true,
  "impact" varchar(16) NOT NULL,
  "lookback_months" integer NOT NULL DEFAULT 3,
  "config" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "version" integer NOT NULL DEFAULT 1,
  "updated_by" text REFERENCES "auth_users"("id"),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "review_rule_configs_org_definition_unique"
  ON "review_rule_configs" ("organization_id", "definition_id");

CREATE TABLE IF NOT EXISTS "review_rule_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" text NOT NULL REFERENCES "auth_organizations"("id") ON DELETE CASCADE,
  "rule_config_id" uuid REFERENCES "review_rule_configs"("id") ON DELETE SET NULL,
  "trigger" varchar(24) NOT NULL,
  "status" varchar(24) NOT NULL DEFAULT 'running',
  "window_start" date NOT NULL,
  "window_end" date NOT NULL,
  "as_of_date" date NOT NULL,
  "config_snapshot" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "counts" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "last_error" text,
  "started_at" timestamptz NOT NULL DEFAULT now(),
  "completed_at" timestamptz
);
CREATE INDEX IF NOT EXISTS "review_rule_runs_org_started_idx"
  ON "review_rule_runs" ("organization_id", "started_at");

CREATE TABLE IF NOT EXISTS "review_findings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" text NOT NULL REFERENCES "auth_organizations"("id") ON DELETE CASCADE,
  "inbox_item_id" uuid REFERENCES "inbox_items"("id") ON DELETE CASCADE,
  "candidate_id" uuid REFERENCES "transaction_candidates"("id") ON DELETE CASCADE,
  "rule_config_id" uuid REFERENCES "review_rule_configs"("id") ON DELETE SET NULL,
  "rule_run_id" uuid REFERENCES "review_rule_runs"("id") ON DELETE SET NULL,
  "rule_key" varchar(64) NOT NULL,
  "impact" varchar(16) NOT NULL,
  "state" varchar(24) NOT NULL DEFAULT 'open',
  "subject_type" varchar(32) NOT NULL,
  "subject_id" uuid,
  "fingerprint" varchar(255) NOT NULL,
  "message" text NOT NULL,
  "evidence" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "formula_version" integer NOT NULL DEFAULT 1,
  "first_seen_at" timestamptz NOT NULL DEFAULT now(),
  "last_seen_at" timestamptz NOT NULL DEFAULT now(),
  "resolved_by" text REFERENCES "auth_users"("id"),
  "resolved_at" timestamptz,
  "resolution_note" text
);
CREATE UNIQUE INDEX IF NOT EXISTS "review_findings_org_fingerprint_unique"
  ON "review_findings" ("organization_id", "fingerprint");
CREATE INDEX IF NOT EXISTS "review_findings_inbox_state_idx"
  ON "review_findings" ("inbox_item_id", "state");
CREATE INDEX IF NOT EXISTS "review_findings_org_rule_state_idx"
  ON "review_findings" ("organization_id", "rule_key", "state");

CREATE TABLE IF NOT EXISTS "review_decisions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" text NOT NULL REFERENCES "auth_organizations"("id") ON DELETE CASCADE,
  "inbox_item_id" uuid NOT NULL REFERENCES "inbox_items"("id") ON DELETE CASCADE,
  "decision" varchar(32) NOT NULL,
  "actor_id" text NOT NULL REFERENCES "auth_users"("id"),
  "candidate_revision" integer NOT NULL,
  "reason" text,
  "before_state" varchar(32) NOT NULL,
  "after_state" varchar(32) NOT NULL,
  "journal_header_id" uuid REFERENCES "journal_headers"("id"),
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "review_decisions_inbox_created_idx"
  ON "review_decisions" ("inbox_item_id", "created_at");

CREATE TABLE IF NOT EXISTS "workflow_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" text NOT NULL REFERENCES "auth_organizations"("id") ON DELETE CASCADE,
  "inbox_item_id" uuid REFERENCES "inbox_items"("id") ON DELETE CASCADE,
  "entity_type" varchar(48) NOT NULL,
  "entity_id" uuid NOT NULL,
  "action" varchar(48) NOT NULL,
  "actor_type" varchar(16) NOT NULL,
  "actor_id" text,
  "correlation_id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "idempotency_key" varchar(255),
  "data" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "workflow_events_org_idempotency_unique"
  ON "workflow_events" ("organization_id", "idempotency_key")
  WHERE "idempotency_key" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "workflow_events_entity_created_idx"
  ON "workflow_events" ("organization_id", "entity_type", "entity_id", "created_at");

CREATE TABLE IF NOT EXISTS "source_match_candidates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" text NOT NULL REFERENCES "auth_organizations"("id") ON DELETE CASCADE,
  "left_source_record_id" uuid NOT NULL REFERENCES "source_records"("id") ON DELETE CASCADE,
  "right_source_record_id" uuid NOT NULL REFERENCES "source_records"("id") ON DELETE CASCADE,
  "match_type" varchar(16) NOT NULL,
  "confidence" numeric(5,4),
  "state" varchar(24) NOT NULL DEFAULT 'open',
  "evidence" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "resolved_by" text REFERENCES "auth_users"("id"),
  "resolved_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "source_match_candidates_pair_unique"
  ON "source_match_candidates" ("organization_id", "left_source_record_id", "right_source_record_id");
CREATE INDEX IF NOT EXISTS "source_match_candidates_org_state_idx"
  ON "source_match_candidates" ("organization_id", "state");

CREATE TABLE IF NOT EXISTS "ledger_source_links" (
  "organization_id" text NOT NULL REFERENCES "auth_organizations"("id") ON DELETE CASCADE,
  "journal_header_id" uuid NOT NULL REFERENCES "journal_headers"("id") ON DELETE CASCADE,
  "source_record_id" uuid NOT NULL REFERENCES "source_records"("id") ON DELETE RESTRICT,
  "relationship" varchar(24) NOT NULL DEFAULT 'origin',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("journal_header_id", "source_record_id")
);
CREATE INDEX IF NOT EXISTS "ledger_source_links_org_source_idx"
  ON "ledger_source_links" ("organization_id", "source_record_id");

INSERT INTO "review_rule_definitions" ("key", "name", "group_name", "evaluator_key", "default_config")
VALUES
  ('uncategorized', 'Uncategorized', 'book', 'uncategorized', '{}'),
  ('low_confidence_category', 'Low Confidence Category', 'book', 'low_confidence_category', '{"threshold":0.8}'),
  ('missing_vendor', 'Missing Vendor', 'book', 'missing_vendor', '{}'),
  ('missing_customer', 'Missing Customer', 'book', 'missing_customer', '{}'),
  ('missing_receipt', 'Missing Receipt', 'book', 'missing_receipt', '{"threshold":75,"currency":"USD"}'),
  ('missing_invoice', 'Missing Invoice', 'book', 'missing_invoice', '{}'),
  ('missing_department', 'Missing Department', 'book', 'missing_department', '{}'),
  ('missing_location', 'Missing Location', 'book', 'missing_location', '{}'),
  ('possible_duplicate', 'Possible Duplicate', 'book', 'possible_duplicate', '{"matchWindowDays":3}'),
  ('unusual_spend', 'Unusual Spend', 'review', 'unusual_spend', '{"standardDeviations":3}'),
  ('non_zero_clearing', 'Non Zero Clearing', 'review', 'non_zero_clearing', '{}'),
  ('material_expense', 'Material Expense', 'review', 'material_expense', '{"annualizedExpensePercent":1}'),
  ('material_asset', 'Material Asset', 'review', 'material_asset', '{"totalAssetPercent":0.5}'),
  ('transaction_in_parent_category', 'Transaction In Parent Category', 'review', 'transaction_in_parent_category', '{}')
ON CONFLICT ("key") DO NOTHING;

-- Tenant policies. These use the same transaction-local session setting as the
-- existing application RLS layer and apply to both reads and writes.
DO $$
DECLARE
  tenant_table text;
BEGIN
  FOREACH tenant_table IN ARRAY ARRAY[
    'organization_accounting_settings', 'firm_clients', 'firm_member_client_access',
    'fx_rates', 'integration_connections', 'integration_sources', 'integration_sync_runs',
    'ingestion_events', 'processing_jobs', 'source_records', 'source_record_documents',
    'transaction_candidates', 'transaction_candidate_lines', 'inbox_items', 'inbox_watchers',
    'review_rule_configs', 'review_rule_runs', 'review_findings', 'review_decisions',
    'workflow_events', 'source_match_candidates', 'ledger_source_links'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tenant_table);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', tenant_table);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (organization_id = current_setting(''app.current_organization_id'', true)) WITH CHECK (organization_id = current_setting(''app.current_organization_id'', true))',
      tenant_table
    );
  END LOOP;
END $$;

ALTER TABLE "firms" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "firm_members" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "firm_member_access" ON "firms";
CREATE POLICY "firm_member_access" ON "firms"
  USING (EXISTS (
    SELECT 1 FROM "firm_members"
    WHERE "firm_members"."firm_id" = "firms"."id"
      AND "firm_members"."user_id" = current_setting('app.current_user_id', true)
  ));
DROP POLICY IF EXISTS "own_firm_membership" ON "firm_members";
CREATE POLICY "own_firm_membership" ON "firm_members"
  USING ("user_id" = current_setting('app.current_user_id', true));
