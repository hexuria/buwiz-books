-- 0054_routines.sql
-- Routines — how source papers get into the Inbox (Inbox v2 spec §3, step 4).
--
-- A routine is a trigger (`webhook`, `schedule`, later `integration`) plus the
-- configuration that trigger needs. Inbound email becomes the first webhook
-- routine; generic webhook routines authenticate with a per-routine
-- HMAC-SHA256 secret held encrypted in `routine_secrets`.
--
-- Convergent and idempotent, like every foundation migration: it runs BEFORE
-- `drizzle-kit push` on real databases (which must then find nothing to do)
-- and AFTER push on the CI test database (where every statement is a no-op).
-- Names below therefore match what drizzle-kit generates for
-- src/db/schema/routines.ts and the routine columns in src/db/schema/inbox.ts.

CREATE TABLE IF NOT EXISTS routines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  name varchar(255) NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  -- webhook | schedule | integration
  trigger_kind varchar(32) NOT NULL,
  trigger_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- The pinned rule snapshot (spec §6). Deliberately NO foreign key yet:
  -- rule_snapshots arrives in build step 8, which adds the constraint.
  rule_snapshot_id uuid,
  max_concurrent_runs integer NOT NULL DEFAULT 1,
  cursor text,
  next_run_at timestamptz,
  last_run_at timestamptz,
  last_error text,
  -- Null for the system-provisioned inbound email routine.
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'routines_trigger_kind_check') THEN
    ALTER TABLE routines ADD CONSTRAINT routines_trigger_kind_check
      CHECK (trigger_kind IN ('webhook', 'schedule', 'integration'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'routines_max_concurrent_runs_check') THEN
    ALTER TABLE routines ADD CONSTRAINT routines_max_concurrent_runs_check
      CHECK (max_concurrent_runs >= 1);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS routine_secrets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  routine_id uuid NOT NULL,
  -- enc:v1 envelope from src/lib/crypto.ts; never returned to a client.
  secret_enc text NOT NULL,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE processing_jobs ADD COLUMN IF NOT EXISTS routine_id uuid;
ALTER TABLE ingestion_events ADD COLUMN IF NOT EXISTS routine_id uuid;

-- Foreign keys are guarded by COLUMN, not by name: drizzle-kit push creates
-- its own FK under a generated name, which a name-based check cannot see.
DO $$
DECLARE
  fk record;
BEGIN
  FOR fk IN
    SELECT *
      FROM (VALUES
        ('routines', 'organization_id', 'auth_organizations', 'CASCADE',
         'routines_organization_id_auth_organizations_id_fk'),
        ('routines', 'created_by', 'auth_users', 'NO ACTION',
         'routines_created_by_auth_users_id_fk'),
        ('routine_secrets', 'organization_id', 'auth_organizations', 'CASCADE',
         'routine_secrets_organization_id_auth_organizations_id_fk'),
        ('routine_secrets', 'routine_id', 'routines', 'CASCADE',
         'routine_secrets_routine_id_routines_id_fk'),
        ('routine_secrets', 'created_by', 'auth_users', 'NO ACTION',
         'routine_secrets_created_by_auth_users_id_fk'),
        ('processing_jobs', 'routine_id', 'routines', 'SET NULL',
         'processing_jobs_routine_id_routines_id_fk'),
        ('ingestion_events', 'routine_id', 'routines', 'SET NULL',
         'ingestion_events_routine_id_routines_id_fk')
      ) AS t(table_name, column_name, referenced_table, on_delete, constraint_name)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.key_column_usage k
        JOIN information_schema.table_constraints t
          ON t.constraint_name = k.constraint_name AND t.constraint_schema = k.constraint_schema
       WHERE k.table_schema = 'public'
         AND k.table_name = fk.table_name
         AND k.column_name = fk.column_name
         AND t.constraint_type = 'FOREIGN KEY'
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES %I(id) ON DELETE %s',
        fk.table_name,
        fk.constraint_name,
        fk.column_name,
        fk.referenced_table,
        fk.on_delete
      );
    END IF;
  END LOOP;
END $$;

-- Due-schedule claims (spec §3): only enabled schedule routines are indexed.
CREATE INDEX IF NOT EXISTS routines_schedule_due_idx
  ON routines (organization_id, enabled, next_run_at)
  WHERE trigger_kind = 'schedule' AND enabled;

-- One inbound email routine per organization. It is provisioned lazily by the
-- Resend webhook, so two emails racing for a new organization must converge.
CREATE UNIQUE INDEX IF NOT EXISTS routines_org_inbound_email_unique
  ON routines (organization_id)
  WHERE trigger_kind = 'webhook' AND (trigger_config ->> 'provider') = 'resend';

CREATE UNIQUE INDEX IF NOT EXISTS routine_secrets_routine_unique
  ON routine_secrets (routine_id);

CREATE INDEX IF NOT EXISTS processing_jobs_routine_idx
  ON processing_jobs (routine_id);

-- Routine-level delivery dedupe: one event id per routine. A suppressed
-- duplicate writes a workflow_events row instead of vanishing.
CREATE UNIQUE INDEX IF NOT EXISTS ingestion_events_org_routine_event_unique
  ON ingestion_events (organization_id, routine_id, provider_event_id)
  WHERE routine_id IS NOT NULL AND provider_event_id IS NOT NULL;
