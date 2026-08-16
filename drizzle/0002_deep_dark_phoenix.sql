CREATE TYPE "public"."account_status" AS ENUM('active', 'inactive', 'deactivated', 'archived');--> statement-breakpoint
CREATE TYPE "public"."connection_source_type" AS ENUM('bank', 'credit_card', 'payroll', 'payment_processor', 'expense_management', 'other');--> statement-breakpoint
ALTER TYPE "public"."account_type" ADD VALUE 'cost_of_revenue';--> statement-breakpoint
ALTER TYPE "public"."account_type" ADD VALUE 'other_income';--> statement-breakpoint
ALTER TYPE "public"."account_type" ADD VALUE 'other_expense';--> statement-breakpoint
CREATE TABLE "category_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"category_id" uuid NOT NULL,
	"source_type" "connection_source_type" NOT NULL,
	"source_name" varchar(255) NOT NULL,
	"source_institution" varchar(255),
	"external_id" varchar(255),
	"external_source" varchar(100),
	"last_four_digits" varchar(4),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "status" "account_status" DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "document_attachments" ADD COLUMN "organization_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "organization_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "r2_key" varchar(1000);--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "r2_bucket" varchar(100);--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "thumbnail_r2_key" varchar(1000);--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "is_public" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "category_connections" ADD CONSTRAINT "category_connections_category_id_accounts_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;