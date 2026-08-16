-- Migration: Add AI reconciliation support
-- Phase 1: Schema foundation for AI-driven bank statement reconciliation

-- New enums
DO $$ BEGIN
  CREATE TYPE "statement_line_source" AS ENUM('ocr', 'manual', 'generated');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "suggestion_type" AS ENUM('auto_match', 'date_fix', 'create_txn', 'duplicate', 'split', 'ignore');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "suggestion_status" AS ENUM('pending', 'accepted', 'dismissed', 'applied');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Add document link + metadata columns to reconciliations
ALTER TABLE "reconciliations"
  ADD COLUMN IF NOT EXISTS "statement_document_id" uuid REFERENCES "documents"("id"),
  ADD COLUMN IF NOT EXISTS "statement_total_pages" integer;

-- Add OCR metadata + source tracking to statement_lines
ALTER TABLE "statement_lines"
  ADD COLUMN IF NOT EXISTS "ocr_bbox" jsonb,
  ADD COLUMN IF NOT EXISTS "ocr_page" integer,
  ADD COLUMN IF NOT EXISTS "ocr_confidence" numeric(5, 2),
  ADD COLUMN IF NOT EXISTS "source" "statement_line_source" NOT NULL DEFAULT 'generated';

-- Create reconciliation_suggestions table
CREATE TABLE IF NOT EXISTS "reconciliation_suggestions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" text NOT NULL,
  "reconciliation_id" uuid NOT NULL REFERENCES "reconciliations"("id") ON DELETE CASCADE,
  "statement_line_id" uuid REFERENCES "statement_lines"("id"),
  "journal_line_id" uuid REFERENCES "journal_lines"("id"),
  "suggestion_type" "suggestion_type" NOT NULL,
  "confidence" numeric(5, 2),
  "description" text,
  "proposed_changes" jsonb,
  "status" "suggestion_status" NOT NULL DEFAULT 'pending',
  "applied_at" timestamp,
  "applied_by_id" text,
  "resolution_summary" text,
  "created_at" timestamp NOT NULL DEFAULT now()
);

-- Add suggestion FK to reconciliation_flags
ALTER TABLE "reconciliation_flags"
  ADD COLUMN IF NOT EXISTS "suggestion_id" uuid REFERENCES "reconciliation_suggestions"("id");
