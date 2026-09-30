-- 0055_rule_snapshots.sql
-- Rule snapshots — immutable rule packs a routine pins (Inbox v2 spec §6, step 8).
--
-- A snapshot freezes an organization's effective review-rule configuration:
-- [{ruleKey, enabled, impact, config, formulaVersion}]. Routines pin one
-- (`rule_snapshot_id`, added without a foreign key by 0054) and may shadow a
-- second (`shadow_rule_snapshot_id`, new here). Both now reference
-- rule_snapshots ON DELETE RESTRICT, so a pinned snapshot cannot be deleted.
--
-- Rows are immutable: a BEFORE UPDATE trigger rejects every update. DELETE is
-- deliberately left to the foreign keys — an organization's cascade must still
-- be able to remove its snapshots, and a pinned one is protected by RESTRICT.
--
-- Convergent and idempotent, like every foundation migration: it runs BEFORE
-- `drizzle-kit push` on real databases (which must then find nothing to do)
-- and AFTER push on the CI test database (where only the trigger is new).
-- Names below therefore match what drizzle-kit generates for
-- src/db/schema/rule-snapshots.ts and src/db/schema/routines.ts.

CREATE TABLE IF NOT EXISTS rule_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  label text,
  snapshot jsonb NOT NULL,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rule_snapshots_snapshot_array_check') THEN
    ALTER TABLE rule_snapshots ADD CONSTRAINT rule_snapshots_snapshot_array_check
      CHECK (jsonb_typeof(snapshot) = 'array');
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS rule_snapshots_org_created_idx
  ON rule_snapshots (organization_id, created_at);

ALTER TABLE routines ADD COLUMN IF NOT EXISTS shadow_rule_snapshot_id uuid;

-- 0054 left rule_snapshot_id unconstrained and no application path ever set
-- it, so any value present now points at nothing and was never read: those
-- routines have always evaluated against live configs. Clearing such a value
-- preserves that behavior and lets the foreign key below attach.
UPDATE routines
   SET rule_snapshot_id = NULL
 WHERE rule_snapshot_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM rule_snapshots s WHERE s.id = routines.rule_snapshot_id);

-- Foreign keys are guarded by COLUMN, not by name: drizzle-kit push creates
-- its own FK under a generated name, which a name-based check cannot see.
DO $$
DECLARE
  fk record;
BEGIN
  FOR fk IN
    SELECT *
      FROM (VALUES
        ('rule_snapshots', 'organization_id', 'auth_organizations', 'CASCADE',
         'rule_snapshots_organization_id_auth_organizations_id_fk'),
        ('rule_snapshots', 'created_by', 'auth_users', 'NO ACTION',
         'rule_snapshots_created_by_auth_users_id_fk'),
        ('routines', 'rule_snapshot_id', 'rule_snapshots', 'RESTRICT',
         'routines_rule_snapshot_id_rule_snapshots_id_fk'),
        ('routines', 'shadow_rule_snapshot_id', 'rule_snapshots', 'RESTRICT',
         'routines_shadow_rule_snapshot_id_rule_snapshots_id_fk')
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

-- Immutability. A snapshot is what a routine's findings were evaluated
-- against; editing one in place would silently rewrite that history. Changing
-- rules means creating a new snapshot and repinning.
CREATE OR REPLACE FUNCTION forbid_rule_snapshot_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    'rule snapshot % is immutable; create a new snapshot instead', OLD.id
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS rule_snapshots_forbid_update ON rule_snapshots;
CREATE TRIGGER rule_snapshots_forbid_update
  BEFORE UPDATE ON rule_snapshots
  FOR EACH ROW EXECUTE FUNCTION forbid_rule_snapshot_update();
