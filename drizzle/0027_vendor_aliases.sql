-- ============================================================================
-- 0027 — vendor_aliases (match-assist descriptor memory) + pg_trgm.
--
-- Idempotent; applied via scripts/apply-ai-foundation.ts alongside 0026.
-- The embedding column is added ONLY where pgvector is available (guarded
-- DO block): local dev may lack the extension; matching degrades to
-- normalized-descriptor exact + trgm similarity, which the blocking layer
-- treats as first-class. HNSW indexing is deliberately deferred until row
-- counts justify it (pgvector post-filter caveat — see AI_NATIVE_ARCHITECTURE
-- §4).
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS vendor_aliases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  normalized_descriptor text NOT NULL,
  party_id uuid NOT NULL,
  source text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS vendor_aliases_org_descriptor_unique
  ON vendor_aliases (organization_id, normalized_descriptor);
CREATE INDEX IF NOT EXISTS vendor_aliases_descriptor_trgm_idx
  ON vendor_aliases USING gin (normalized_descriptor gin_trgm_ops);

-- Embedding column only where pgvector exists (e.g. Neon prod; not all dev
-- machines). Code must treat the column as optional.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'vector') THEN
    EXECUTE 'CREATE EXTENSION IF NOT EXISTS vector';
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'vendor_aliases' AND column_name = 'embedding'
    ) THEN
      EXECUTE 'ALTER TABLE vendor_aliases ADD COLUMN embedding halfvec(768)';
    END IF;
  ELSE
    RAISE NOTICE 'pgvector not available — vendor_aliases.embedding skipped (trgm-only matching)';
  END IF;
END $$;
