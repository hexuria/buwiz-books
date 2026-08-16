-- Replay-safe accounting operations.
--
-- A row is inserted and completed in the same transaction as the domain
-- transition and journal posting. The organization/key unique index is the
-- concurrency boundary; payload_hash prevents a key from being reused for a
-- different mutation.

CREATE TABLE IF NOT EXISTS "accounting_operation_idempotency" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" text NOT NULL REFERENCES "auth_organizations"("id") ON DELETE CASCADE,
  "operation_type" varchar(64) NOT NULL,
  "entity_type" varchar(32) NOT NULL,
  "entity_id" uuid NOT NULL,
  "idempotency_key" varchar(255) NOT NULL,
  "payload_hash" varchar(64) NOT NULL,
  "state" varchar(16) NOT NULL DEFAULT 'pending',
  "journal_header_id" uuid REFERENCES "journal_headers"("id") ON DELETE RESTRICT,
  "source_record_id" uuid REFERENCES "source_records"("id") ON DELETE RESTRICT,
  "result" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "actor_id" text REFERENCES "auth_users"("id") ON DELETE SET NULL,
  "completed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "accounting_operation_idempotency_state_check"
    CHECK ("state" IN ('pending', 'completed'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "accounting_operation_idempotency_org_key_unique"
  ON "accounting_operation_idempotency" ("organization_id", "idempotency_key");

CREATE INDEX IF NOT EXISTS "accounting_operation_idempotency_entity_idx"
  ON "accounting_operation_idempotency"
    ("organization_id", "entity_type", "entity_id", "created_at");

ALTER TABLE "accounting_operation_idempotency" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "org_isolation_accounting_operation_idempotency"
  ON "accounting_operation_idempotency";
CREATE POLICY "org_isolation_accounting_operation_idempotency"
  ON "accounting_operation_idempotency"
  FOR ALL
  USING (
    NULLIF(current_setting('app.current_organization_id', true), '') IS NULL
    OR "organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')
  )
  WITH CHECK (
    NULLIF(current_setting('app.current_organization_id', true), '') IS NULL
    OR "organization_id" = NULLIF(current_setting('app.current_organization_id', true), '')
  );
