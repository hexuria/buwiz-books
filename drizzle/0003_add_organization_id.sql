-- Migration: Add organization_id to all data tables
-- Strategy: Add nullable → backfill from first org → set NOT NULL

-- Step 1: Add organization_id as NULLABLE to all 10 parent tables
ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "organization_id" text;
ALTER TABLE "dimensions" ADD COLUMN IF NOT EXISTS "organization_id" text;
ALTER TABLE "journal_headers" ADD COLUMN IF NOT EXISTS "organization_id" text;
ALTER TABLE "parties" ADD COLUMN IF NOT EXISTS "organization_id" text;
ALTER TABLE "bills" ADD COLUMN IF NOT EXISTS "organization_id" text;
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "organization_id" text;
ALTER TABLE "financial_accounts" ADD COLUMN IF NOT EXISTS "organization_id" text;
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "organization_id" text;
ALTER TABLE "category_connections" ADD COLUMN IF NOT EXISTS "organization_id" text;
ALTER TABLE "reconciliations" ADD COLUMN IF NOT EXISTS "organization_id" text;

-- Step 2: Backfill — assign all existing rows to the first organization
-- better-auth stores organizations in "auth_organizations"
UPDATE "accounts" SET "organization_id" = (SELECT "id" FROM "auth_organizations" LIMIT 1) WHERE "organization_id" IS NULL;
UPDATE "dimensions" SET "organization_id" = (SELECT "id" FROM "auth_organizations" LIMIT 1) WHERE "organization_id" IS NULL;
UPDATE "journal_headers" SET "organization_id" = (SELECT "id" FROM "auth_organizations" LIMIT 1) WHERE "organization_id" IS NULL;
UPDATE "parties" SET "organization_id" = (SELECT "id" FROM "auth_organizations" LIMIT 1) WHERE "organization_id" IS NULL;
UPDATE "bills" SET "organization_id" = (SELECT "id" FROM "auth_organizations" LIMIT 1) WHERE "organization_id" IS NULL;
UPDATE "invoices" SET "organization_id" = (SELECT "id" FROM "auth_organizations" LIMIT 1) WHERE "organization_id" IS NULL;
UPDATE "financial_accounts" SET "organization_id" = (SELECT "id" FROM "auth_organizations" LIMIT 1) WHERE "organization_id" IS NULL;
UPDATE "products" SET "organization_id" = (SELECT "id" FROM "auth_organizations" LIMIT 1) WHERE "organization_id" IS NULL;
UPDATE "category_connections" SET "organization_id" = (SELECT "id" FROM "auth_organizations" LIMIT 1) WHERE "organization_id" IS NULL;
UPDATE "reconciliations" SET "organization_id" = (SELECT "id" FROM "auth_organizations" LIMIT 1) WHERE "organization_id" IS NULL;

-- Step 3: Set NOT NULL constraint
ALTER TABLE "accounts" ALTER COLUMN "organization_id" SET NOT NULL;
ALTER TABLE "dimensions" ALTER COLUMN "organization_id" SET NOT NULL;
ALTER TABLE "journal_headers" ALTER COLUMN "organization_id" SET NOT NULL;
ALTER TABLE "parties" ALTER COLUMN "organization_id" SET NOT NULL;
ALTER TABLE "bills" ALTER COLUMN "organization_id" SET NOT NULL;
ALTER TABLE "invoices" ALTER COLUMN "organization_id" SET NOT NULL;
ALTER TABLE "financial_accounts" ALTER COLUMN "organization_id" SET NOT NULL;
ALTER TABLE "products" ALTER COLUMN "organization_id" SET NOT NULL;
ALTER TABLE "category_connections" ALTER COLUMN "organization_id" SET NOT NULL;
ALTER TABLE "reconciliations" ALTER COLUMN "organization_id" SET NOT NULL;
