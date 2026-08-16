CREATE TYPE "public"."account_subtype" AS ENUM('bank_accounts', 'accounts_receivable', 'inventory', 'prepaid_expenses', 'fixed_assets', 'accumulated_depreciation', 'other_current_assets', 'other_long_term_assets', 'accounts_payable', 'credit_cards', 'accrued_liabilities', 'payroll_liabilities', 'short_term_debt', 'long_term_debt', 'deferred_revenue', 'other_current_liabilities', 'other_long_term_liabilities', 'owners_equity', 'retained_earnings', 'common_stock', 'additional_paid_in_capital', 'distributions', 'sales_revenue', 'service_revenue', 'other_income', 'interest_income', 'gain_on_sale', 'cost_of_goods_sold', 'payroll_expenses', 'rent_expense', 'utilities', 'office_expenses', 'professional_services', 'marketing', 'travel', 'insurance', 'depreciation_expense', 'interest_expense', 'taxes', 'other_expenses');--> statement-breakpoint
CREATE TYPE "public"."account_type" AS ENUM('asset', 'liability', 'equity', 'revenue', 'expense');--> statement-breakpoint
CREATE TYPE "public"."party_type" AS ENUM('vendor', 'customer', 'both');--> statement-breakpoint
CREATE TYPE "public"."dimension_type" AS ENUM('department', 'location', 'class', 'project');--> statement-breakpoint
CREATE TYPE "public"."journal_source" AS ENUM('manual', 'import', 'invoice', 'bill', 'reconciliation', 'system');--> statement-breakpoint
CREATE TYPE "public"."journal_status" AS ENUM('draft', 'pending', 'posted', 'voided');--> statement-breakpoint
CREATE TYPE "public"."transaction_type" AS ENUM('expense', 'income', 'transfer', 'adjustment', 'opening_balance');--> statement-breakpoint
CREATE TYPE "public"."connection_status" AS ENUM('connected', 'stale', 'disconnected', 'pending');--> statement-breakpoint
CREATE TYPE "public"."financial_account_type" AS ENUM('checking', 'savings', 'credit_card', 'money_market', 'investment', 'other');--> statement-breakpoint
CREATE TYPE "public"."flag_type" AS ENUM('unmatched_statement', 'unmatched_ledger', 'date_mismatch', 'amount_discrepancy', 'duplicate', 'overmatched');--> statement-breakpoint
CREATE TYPE "public"."match_status" AS ENUM('unmatched', 'matched', 'created', 'ignored');--> statement-breakpoint
CREATE TYPE "public"."reconciliation_status" AS ENUM('not_started', 'draft', 'in_progress', 'finalized');--> statement-breakpoint
CREATE TYPE "public"."suggested_action" AS ENUM('create_transaction', 'change_date', 'split_transaction', 'ignore', 'manual_review');--> statement-breakpoint
CREATE TYPE "public"."invoice_status" AS ENUM('draft', 'sent', 'viewed', 'overdue', 'partial', 'paid', 'voided');--> statement-breakpoint
CREATE TYPE "public"."bill_status" AS ENUM('in_review', 'pending_approval', 'approved', 'awaiting_payment', 'scheduled', 'paid', 'voided');--> statement-breakpoint
CREATE TYPE "public"."document_type" AS ENUM('statement', 'bill', 'invoice', 'receipt', 'contract', 'tax_form', 'other');--> statement-breakpoint
CREATE TYPE "public"."file_type" AS ENUM('pdf', 'xlsx', 'xls', 'csv', 'jpg', 'jpeg', 'png', 'gif', 'webp', 'zip', 'docx', 'doc', 'other');--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_number" varchar(10),
	"name" varchar(255) NOT NULL,
	"description" text,
	"account_type" "account_type" NOT NULL,
	"subtype" "account_subtype",
	"parent_id" uuid,
	"icon" varchar(50),
	"integration_id" varchar(100),
	"integration_source" varchar(50),
	"is_active" boolean DEFAULT true NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "parties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"party_type" "party_type" NOT NULL,
	"email" varchar(255),
	"phone" varchar(50),
	"website" varchar(500),
	"address" jsonb,
	"logo_url" varchar(500),
	"description" text,
	"notes" text,
	"is_1099_vendor" boolean DEFAULT false,
	"tax_id" varchar(50),
	"payment_terms" varchar(50),
	"credit_limit" numeric(12, 2),
	"default_account_id" uuid,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dimensions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dimension_type" "dimension_type" NOT NULL,
	"name" varchar(255) NOT NULL,
	"code" varchar(50),
	"description" text,
	"parent_id" uuid,
	"source_integration_id" varchar(100),
	"source_integration" varchar(50),
	"metadata" jsonb,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "journal_headers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transaction_number" varchar(50),
	"transaction_date" date NOT NULL,
	"transaction_type" "transaction_type" NOT NULL,
	"source" "journal_source" DEFAULT 'manual' NOT NULL,
	"memo" text,
	"party_id" uuid,
	"status" "journal_status" DEFAULT 'draft' NOT NULL,
	"source_document_id" uuid,
	"source_document_type" varchar(50),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"posted_at" timestamp,
	"voided_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "journal_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"journal_header_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"debit" numeric(15, 2),
	"credit" numeric(15, 2),
	"line_description" text,
	"department_id" uuid,
	"location_id" uuid,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bank_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"financial_account_id" uuid NOT NULL,
	"transaction_date" timestamp NOT NULL,
	"raw_description" varchar(500) NOT NULL,
	"amount" varchar(50) NOT NULL,
	"cleansed_party_id" uuid,
	"source_integration_id" varchar(100),
	"source_integration" varchar(50),
	"journal_line_id" uuid,
	"external_id" varchar(100),
	"imported_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "financial_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_name" varchar(255) NOT NULL,
	"institution_name" varchar(255),
	"institution_logo_url" varchar(500),
	"account_type" "financial_account_type" NOT NULL,
	"last_four" varchar(4),
	"ledger_account_id" uuid,
	"is_manual" boolean DEFAULT true NOT NULL,
	"connection_status" "connection_status" DEFAULT 'pending',
	"connection_id" varchar(100),
	"integration_source" varchar(50),
	"external_account_id" varchar(100),
	"is_active" boolean DEFAULT true NOT NULL,
	"last_synced_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reconciliation_flags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reconciliation_id" uuid NOT NULL,
	"statement_line_id" uuid,
	"flag_type" "flag_type" NOT NULL,
	"suggested_action" "suggested_action",
	"description" text,
	"resolved" boolean DEFAULT false NOT NULL,
	"resolved_at" timestamp,
	"resolved_by_id" uuid,
	"resolution_notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reconciliations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bank_account_id" uuid NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"statement_beginning_balance" numeric(15, 2),
	"statement_ending_balance" numeric(15, 2),
	"ledger_balance" numeric(15, 2),
	"status" "reconciliation_status" DEFAULT 'not_started' NOT NULL,
	"ai_auto_finalized" boolean DEFAULT false,
	"finalized_at" timestamp,
	"finalized_by_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "statement_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reconciliation_id" uuid NOT NULL,
	"transaction_date" date NOT NULL,
	"description" varchar(500) NOT NULL,
	"amount" numeric(15, 2) NOT NULL,
	"matched_journal_line_id" uuid,
	"match_status" "match_status" DEFAULT 'unmatched' NOT NULL,
	"match_confidence" numeric(5, 2),
	"sort_order" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoice_line_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"product_service_id" uuid,
	"description" varchar(500) NOT NULL,
	"quantity" numeric(10, 4) NOT NULL,
	"unit_price" numeric(15, 2) NOT NULL,
	"amount" numeric(15, 2) NOT NULL,
	"revenue_account_id" uuid,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_number" varchar(50) NOT NULL,
	"customer_id" uuid NOT NULL,
	"issue_date" date NOT NULL,
	"due_date" date NOT NULL,
	"status" "invoice_status" DEFAULT 'draft' NOT NULL,
	"subtotal" numeric(15, 2) NOT NULL,
	"discount_amount" numeric(15, 2) DEFAULT '0',
	"discount_percent" numeric(5, 2),
	"tax_amount" numeric(15, 2) DEFAULT '0',
	"total" numeric(15, 2) NOT NULL,
	"amount_paid" numeric(15, 2) DEFAULT '0',
	"balance_due" numeric(15, 2) NOT NULL,
	"notes" text,
	"payment_terms" varchar(50),
	"journal_header_id" uuid,
	"sent_at" timestamp,
	"paid_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "invoices_invoice_number_unique" UNIQUE("invoice_number")
);
--> statement-breakpoint
CREATE TABLE "bill_line_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bill_id" uuid NOT NULL,
	"description" varchar(500),
	"amount" numeric(15, 2) NOT NULL,
	"account_id" uuid NOT NULL,
	"department_id" uuid,
	"location_id" uuid,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor_id" uuid NOT NULL,
	"bill_number" varchar(100),
	"bill_date" date NOT NULL,
	"due_date" date NOT NULL,
	"status" "bill_status" DEFAULT 'in_review' NOT NULL,
	"amount" numeric(15, 2) NOT NULL,
	"amount_paid" numeric(15, 2) DEFAULT '0',
	"balance_due" numeric(15, 2) NOT NULL,
	"memo" text,
	"approver_id" uuid,
	"approved_at" timestamp,
	"scheduled_payment_date" date,
	"paid_at" timestamp,
	"payment_method" varchar(50),
	"payment_reference" varchar(100),
	"journal_header_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"linkable_type" varchar(50) NOT NULL,
	"linkable_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_suggestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"suggested_journal_header_id" uuid,
	"confidence" integer,
	"reason" text,
	"accepted" boolean,
	"reviewed_at" timestamp,
	"reviewed_by_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"original_filename" varchar(500) NOT NULL,
	"display_title" varchar(255),
	"summary" text,
	"document_type" "document_type" DEFAULT 'other' NOT NULL,
	"file_type" "file_type" DEFAULT 'other' NOT NULL,
	"storage_path" varchar(1000) NOT NULL,
	"file_size_bytes" integer,
	"mime_type" varchar(100),
	"metadata" jsonb,
	"uploaded_by_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_parent_id_accounts_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parties" ADD CONSTRAINT "parties_default_account_id_accounts_id_fk" FOREIGN KEY ("default_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dimensions" ADD CONSTRAINT "dimensions_parent_id_dimensions_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."dimensions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_headers" ADD CONSTRAINT "journal_headers_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_journal_header_id_journal_headers_id_fk" FOREIGN KEY ("journal_header_id") REFERENCES "public"."journal_headers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_department_id_dimensions_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."dimensions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_location_id_dimensions_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."dimensions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_financial_account_id_financial_accounts_id_fk" FOREIGN KEY ("financial_account_id") REFERENCES "public"."financial_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_accounts" ADD CONSTRAINT "financial_accounts_ledger_account_id_accounts_id_fk" FOREIGN KEY ("ledger_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_flags" ADD CONSTRAINT "reconciliation_flags_reconciliation_id_reconciliations_id_fk" FOREIGN KEY ("reconciliation_id") REFERENCES "public"."reconciliations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_flags" ADD CONSTRAINT "reconciliation_flags_statement_line_id_statement_lines_id_fk" FOREIGN KEY ("statement_line_id") REFERENCES "public"."statement_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliations" ADD CONSTRAINT "reconciliations_bank_account_id_financial_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."financial_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statement_lines" ADD CONSTRAINT "statement_lines_reconciliation_id_reconciliations_id_fk" FOREIGN KEY ("reconciliation_id") REFERENCES "public"."reconciliations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statement_lines" ADD CONSTRAINT "statement_lines_matched_journal_line_id_journal_lines_id_fk" FOREIGN KEY ("matched_journal_line_id") REFERENCES "public"."journal_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_line_items" ADD CONSTRAINT "invoice_line_items_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_line_items" ADD CONSTRAINT "invoice_line_items_revenue_account_id_accounts_id_fk" FOREIGN KEY ("revenue_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_customer_id_parties_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."parties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_journal_header_id_journal_headers_id_fk" FOREIGN KEY ("journal_header_id") REFERENCES "public"."journal_headers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_line_items" ADD CONSTRAINT "bill_line_items_bill_id_bills_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."bills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_line_items" ADD CONSTRAINT "bill_line_items_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_line_items" ADD CONSTRAINT "bill_line_items_department_id_dimensions_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."dimensions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_line_items" ADD CONSTRAINT "bill_line_items_location_id_dimensions_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."dimensions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_vendor_id_parties_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."parties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_journal_header_id_journal_headers_id_fk" FOREIGN KEY ("journal_header_id") REFERENCES "public"."journal_headers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_attachments" ADD CONSTRAINT "document_attachments_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_suggestions" ADD CONSTRAINT "document_suggestions_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_suggestions" ADD CONSTRAINT "document_suggestions_suggested_journal_header_id_journal_headers_id_fk" FOREIGN KEY ("suggested_journal_header_id") REFERENCES "public"."journal_headers"("id") ON DELETE no action ON UPDATE no action;