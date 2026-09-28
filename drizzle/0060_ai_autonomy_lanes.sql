-- 0060_ai_autonomy_lanes.sql
-- Jev approval lanes — earned autonomy per vendor and kind of paper (Inbox v2
-- spec §8, build step 11).
--
--   ai_autonomy_lanes           one row per (organization, lane, party, kind).
--                               Level watch -> suggest -> auto; an auto lane
--                               must name its party, amount cap and calibrated
--                               confidence threshold (CHECK below).
--   ai_run_feedback.lane_id     the lane a human label counts toward, plus the
--                  .lane_evidence  lane's view of the paper when it was proposed
--                  .label_key      and a per-proposal key: one label per proposal.
--   organization_ai_settings    the org's Jev-approval switch (off by default),
--                               its maker-checker opt-in, and the spot-check
--                               rate and salt.
--
-- Convergent and idempotent, like every foundation migration: it runs BEFORE
-- `drizzle-kit push` on real databases (which must then find nothing to do)
-- and AFTER push on the CI test database. Names below therefore match what
-- drizzle-kit generates for src/db/schema/ai.ts.

CREATE TABLE IF NOT EXISTS ai_autonomy_lanes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  lane_key varchar(64) NOT NULL,
  party_id uuid,
  doc_kind varchar(32),
  level varchar(16) NOT NULL DEFAULT 'watch',
  amount_cap numeric(20,8),
  confidence_threshold numeric(5,4),
  promoted_by text,
  promoted_at timestamptz,
  demoted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'ai_autonomy_lanes_level_check'
       AND conrelid = 'ai_autonomy_lanes'::regclass
  ) THEN
    ALTER TABLE ai_autonomy_lanes ADD CONSTRAINT ai_autonomy_lanes_level_check
      CHECK (level IN ('watch', 'suggest', 'auto'));
  END IF;

  -- A new lane is a reviewed migration, never a typo in application code.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'ai_autonomy_lanes_lane_key_check'
       AND conrelid = 'ai_autonomy_lanes'::regclass
  ) THEN
    ALTER TABLE ai_autonomy_lanes ADD CONSTRAINT ai_autonomy_lanes_lane_key_check
      CHECK (lane_key IN ('inbox_approve'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'ai_autonomy_lanes_threshold_range_check'
       AND conrelid = 'ai_autonomy_lanes'::regclass
  ) THEN
    ALTER TABLE ai_autonomy_lanes ADD CONSTRAINT ai_autonomy_lanes_threshold_range_check
      CHECK (confidence_threshold IS NULL OR (confidence_threshold > 0 AND confidence_threshold <= 1));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'ai_autonomy_lanes_amount_cap_check'
       AND conrelid = 'ai_autonomy_lanes'::regclass
  ) THEN
    ALTER TABLE ai_autonomy_lanes ADD CONSTRAINT ai_autonomy_lanes_amount_cap_check
      CHECK (amount_cap IS NULL OR amount_cap > 0);
  END IF;

  -- An auto lane without a party, a cap or a threshold would approve without
  -- the limits its promotion was supposed to set. The database refuses it.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'ai_autonomy_lanes_auto_limits_check'
       AND conrelid = 'ai_autonomy_lanes'::regclass
  ) THEN
    ALTER TABLE ai_autonomy_lanes ADD CONSTRAINT ai_autonomy_lanes_auto_limits_check
      CHECK (
        level <> 'auto'
        OR (party_id IS NOT NULL AND amount_cap IS NOT NULL AND confidence_threshold IS NOT NULL)
      );
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS ai_autonomy_lanes_identity_unique
  ON ai_autonomy_lanes (organization_id, lane_key, party_id, doc_kind);
-- NULLs are distinct in a unique index (NULLS NOT DISTINCT needs Postgres 15),
-- so the lane for papers with no known party is guarded separately.
CREATE UNIQUE INDEX IF NOT EXISTS ai_autonomy_lanes_partyless_unique
  ON ai_autonomy_lanes (organization_id, lane_key, doc_kind)
  WHERE party_id IS NULL;
CREATE INDEX IF NOT EXISTS ai_autonomy_lanes_org_level_idx
  ON ai_autonomy_lanes (organization_id, lane_key, level);

ALTER TABLE ai_run_feedback
  ADD COLUMN IF NOT EXISTS lane_id uuid,
  ADD COLUMN IF NOT EXISTS lane_evidence jsonb,
  ADD COLUMN IF NOT EXISTS label_key text;

CREATE INDEX IF NOT EXISTS ai_run_feedback_org_lane_created_idx
  ON ai_run_feedback (organization_id, lane_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS ai_run_feedback_org_label_key_unique
  ON ai_run_feedback (organization_id, label_key)
  WHERE label_key IS NOT NULL;

ALTER TABLE organization_ai_settings
  ADD COLUMN IF NOT EXISTS inbox_autoapprove_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS inbox_autoapprove_with_maker_checker boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS inbox_spot_check_rate numeric(5,4) NOT NULL DEFAULT 0.1000,
  ADD COLUMN IF NOT EXISTS inbox_spot_check_salt uuid NOT NULL DEFAULT gen_random_uuid();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'organization_ai_settings_spot_check_rate_check'
       AND conrelid = 'organization_ai_settings'::regclass
  ) THEN
    ALTER TABLE organization_ai_settings
      ADD CONSTRAINT organization_ai_settings_spot_check_rate_check
      CHECK (inbox_spot_check_rate >= 0 AND inbox_spot_check_rate <= 1);
  END IF;
END $$;

-- Foreign keys are guarded by COLUMN, not by name: drizzle-kit push creates
-- its own FK under a generated name, which a name-based check cannot see.
DO $$
DECLARE
  fk record;
BEGIN
  FOR fk IN
    SELECT *
      FROM (VALUES
        ('ai_autonomy_lanes', 'organization_id', 'auth_organizations', 'CASCADE',
         'ai_autonomy_lanes_organization_id_auth_organizations_id_fk'),
        ('ai_autonomy_lanes', 'party_id', 'parties', 'CASCADE',
         'ai_autonomy_lanes_party_id_parties_id_fk'),
        ('ai_autonomy_lanes', 'promoted_by', 'auth_users', 'NO ACTION',
         'ai_autonomy_lanes_promoted_by_auth_users_id_fk'),
        ('ai_run_feedback', 'lane_id', 'ai_autonomy_lanes', 'SET NULL',
         'ai_run_feedback_lane_id_ai_autonomy_lanes_id_fk')
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
