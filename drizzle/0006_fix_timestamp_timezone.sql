-- Migration: Convert journal timestamp columns from "timestamp without time zone"
-- to "timestamp with time zone" (timestamptz).
--
-- Problem: Naive timestamps are interpreted as local time by JS Date(),
-- causing offset issues when serialized with .toISOString().
--
-- The PostgreSQL server timezone is Asia/Manila (+08:00), so now()
-- stored local Manila time in the naive columns. We use
-- "AT TIME ZONE 'Asia/Manila'" to correctly re-interpret existing values
-- as Manila local time when converting to timestamptz.

ALTER TABLE journal_headers
  ALTER COLUMN created_at TYPE timestamptz USING created_at AT TIME ZONE 'Asia/Manila',
  ALTER COLUMN updated_at TYPE timestamptz USING updated_at AT TIME ZONE 'Asia/Manila',
  ALTER COLUMN posted_at  TYPE timestamptz USING posted_at  AT TIME ZONE 'Asia/Manila',
  ALTER COLUMN voided_at  TYPE timestamptz USING voided_at  AT TIME ZONE 'Asia/Manila';

ALTER TABLE journal_lines
  ALTER COLUMN created_at TYPE timestamptz USING created_at AT TIME ZONE 'Asia/Manila';
