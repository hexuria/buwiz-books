-- Add AI transaction cache column to documents table
-- Stores the full ParsedTransactionResult (post entity resolution) for instant reuse
ALTER TABLE documents ADD COLUMN IF NOT EXISTS ai_transaction_cache JSONB;
