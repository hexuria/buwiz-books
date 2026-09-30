-- 0059_classification_memories.sql
-- Classification memories — human fixes that stick (Inbox v2 spec §7, step 10).
--
-- A reviewer who corrects an Inbox draft may opt in to "Remember this?". The
-- corrected answer (doc kind, party, and each line's account) is stored under
-- a match key normalized at write time, and inbox stage 2 answers any later
-- paper with the same key from here BEFORE asking a model. See
-- src/db/schema/classification-memories.ts and src/lib/inbox/memory/.
--
-- Convergent and idempotent, like every foundation migration: it runs BEFORE
-- `drizzle-kit push` on real databases (which must then find nothing to do)
-- and AFTER push on the CI test database (where every statement is a no-op).
-- Names below therefore match what drizzle-kit generates for the schema.
--
-- Deliberately NO check on consecutive_undos: two consecutive undos disable a
-- memory in code, and a constraint would reject the very update that records
-- the second undo (review-findings.md). The counters check only forbids
-- negative counts.
--
-- RLS: drizzle/rls_policies.sql gives the table the standard tenant policy.

CREATE TABLE IF NOT EXISTS classification_memories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  -- file_hash | sender_party | party | line_text
  match_kind varchar(32) NOT NULL,
  -- Normalized at write time (src/lib/inbox/memory/keys.ts).
  match_key varchar(255) NOT NULL,
  answer_doc_kind varchar(32),
  answer_party_id uuid,
  -- [{lineMatch, accountId, accountType, amount, currency, taxCode}]
  answer_lines jsonb,
  created_by text NOT NULL,
  source_feedback_id uuid,
  uses integer NOT NULL DEFAULT 0,
  undos integer NOT NULL DEFAULT 0,
  consecutive_undos integer NOT NULL DEFAULT 0,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS classification_memories_org_kind_key_unique
  ON classification_memories (organization_id, match_kind, match_key);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'classification_memories_match_kind_check'
  ) THEN
    ALTER TABLE classification_memories ADD CONSTRAINT classification_memories_match_kind_check
      CHECK (match_kind IN ('file_hash', 'sender_party', 'party', 'line_text'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'classification_memories_counters_check'
  ) THEN
    ALTER TABLE classification_memories ADD CONSTRAINT classification_memories_counters_check
      CHECK (uses >= 0 AND undos >= 0 AND consecutive_undos >= 0);
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
        ('classification_memories', 'organization_id', 'auth_organizations', 'CASCADE',
         'classification_memories_organization_id_auth_organizations_id_fk'),
        ('classification_memories', 'answer_party_id', 'parties', 'CASCADE',
         'classification_memories_answer_party_id_parties_id_fk')
      ) AS t(table_name, column_name, referenced_table, on_delete, constraint_name)
  LOOP
    IF to_regclass('public.' || fk.referenced_table) IS NOT NULL AND NOT EXISTS (
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
