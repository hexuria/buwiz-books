-- 0053_review_decision_actor.sql
-- Record who made an Inbox review decision when it was not a person.
--
-- review_decisions.actor_id was a NOT NULL foreign key to auth_users, so the
-- only decider the table could name was a signed-in user. Inbox v2 lets a
-- system actor (Jev, through an earned autonomy lane) approve, and those
-- decisions must be recorded as exactly that, never under a borrowed user id.
--
--   actor_type  'user' | 'system'. Defaults to 'user', which is what every
--               existing row is.
--   actor_key   the system actor's name ('jev'). NULL for users.
--   actor_id    now nullable. A user decision still requires it.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, DROP NOT NULL (a no-op once the column
-- is nullable), and each CHECK is added only when its name is absent. The same
-- columns and CHECKs are declared in src/db/schema/inbox.ts, so drizzle-kit
-- push creates them on a fresh database and never drops them. Push removes any
-- CHECK the schema does not declare, whichever order the two run in.

ALTER TABLE review_decisions
  ADD COLUMN IF NOT EXISTS actor_type varchar(16) NOT NULL DEFAULT 'user',
  ADD COLUMN IF NOT EXISTS actor_key varchar(64);

ALTER TABLE review_decisions
  ALTER COLUMN actor_id DROP NOT NULL;

DO $$
BEGIN
  -- Without the value check, any string other than 'user' (a typo, a casing
  -- slip) would skip the user-requires-actor_id rule below.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'review_decisions_actor_type_check'
       AND conrelid = 'review_decisions'::regclass
  ) THEN
    ALTER TABLE review_decisions
      ADD CONSTRAINT review_decisions_actor_type_check
      CHECK (actor_type IN ('user', 'system'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'review_decisions_user_actor_check'
       AND conrelid = 'review_decisions'::regclass
  ) THEN
    ALTER TABLE review_decisions
      ADD CONSTRAINT review_decisions_user_actor_check
      CHECK (actor_type <> 'user' OR actor_id IS NOT NULL);
  END IF;

  -- A system decision with no key names no one; it is as unattributable as a
  -- user decision with no user.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'review_decisions_system_actor_check'
       AND conrelid = 'review_decisions'::regclass
  ) THEN
    ALTER TABLE review_decisions
      ADD CONSTRAINT review_decisions_system_actor_check
      CHECK (actor_type <> 'system' OR actor_key IS NOT NULL);
  END IF;
END $$;
