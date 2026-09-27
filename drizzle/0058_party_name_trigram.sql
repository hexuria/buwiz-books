-- 0058_party_name_trigram.sql
-- Trigram index on parties.name for Inbox v2 entity matching: the look-alike
-- step asks for the five parties whose names are most similar to the one on a
-- document (src/lib/party-match/queries.ts, `name % $1 ORDER BY similarity`).
--
-- pg_trgm is created by 0027 on managed databases, but the CI and local test
-- builds never run 0027, so it is asserted again here. It is a trusted
-- extension, and CREATE EXTENSION IF NOT EXISTS is a no-op where it exists.
--
-- The index is deliberately absent from the Drizzle schema, like
-- vendor_aliases_descriptor_trgm_idx: push runs before this file on a fresh
-- database, where gin_trgm_ops does not exist yet. The table guard lets this
-- file run on either side of push; the next run creates the index if the
-- table was not there yet, and the query is correct without it, only slower.
--
-- RLS is unaffected: an index adds no policy and bypasses none.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

DO $$
BEGIN
  IF to_regclass('public.parties') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS parties_name_trgm_idx
      ON parties USING gin (name gin_trgm_ops);
  END IF;
END $$;
