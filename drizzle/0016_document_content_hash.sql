-- Migration: add content_hash to documents for upload deduplication (audit #27).
-- Identical uploads (same SHA-256) reuse the existing document + OCR results.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS content_hash varchar(64);

-- Speeds up the per-org dedup lookup on upload.
CREATE INDEX IF NOT EXISTS idx_documents_org_content_hash
  ON documents (organization_id, content_hash);
