-- Activity Logs: real audit trail for transactions (and future entities)
CREATE TABLE IF NOT EXISTS "activity_logs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" text NOT NULL,
  "entity_type" varchar(50) NOT NULL,
  "entity_id" uuid NOT NULL,
  "action" varchar(50) NOT NULL,
  "actor_id" text,
  "changes" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- Fast lookup by entity
CREATE INDEX IF NOT EXISTS "activity_logs_entity_idx" ON "activity_logs" ("entity_type", "entity_id");

-- Tenant scoping
CREATE INDEX IF NOT EXISTS "activity_logs_org_idx" ON "activity_logs" ("organization_id");
