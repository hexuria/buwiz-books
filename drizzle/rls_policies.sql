-- Better Auth + Row-Level Security Migration
-- ============================================
-- This migration:
-- 1. Creates RLS helper functions
-- 2. Conditionally adds organization_id to accounting tables (if they exist)
-- 3. Enables RLS with organization isolation policies

-- ============================================================================
-- RLS Helper Functions (always created)
-- ============================================================================

CREATE OR REPLACE FUNCTION current_organization_id() 
RETURNS TEXT 
LANGUAGE SQL 
STABLE 
AS $$
  SELECT NULLIF(current_setting('app.current_organization_id', true), '');
$$;

CREATE OR REPLACE FUNCTION current_user_id() 
RETURNS TEXT 
LANGUAGE SQL 
STABLE 
AS $$
  SELECT NULLIF(current_setting('app.current_user_id', true), '');
$$;

CREATE OR REPLACE FUNCTION current_user_role() 
RETURNS TEXT 
LANGUAGE SQL 
STABLE 
AS $$
  SELECT NULLIF(current_setting('app.user_role', true), '');
$$;

CREATE OR REPLACE FUNCTION is_admin() 
RETURNS BOOLEAN 
LANGUAGE SQL 
STABLE 
AS $$
  SELECT current_user_role() IN ('owner', 'admin', 'superuser');
$$;

-- ============================================================================
-- ⚠️  SECURITY NOTE: IS NULL bypass in all policies below
-- ============================================================================
-- Every policy contains:
--   USING (current_organization_id() IS NULL OR organization_id = current_organization_id())
--
-- The `IS NULL` clause intentionally allows DB connections that do NOT set
-- app.current_organization_id (e.g. migration scripts, admin tooling) to
-- bypass tenant isolation and access all rows.
--
-- RISK: Any application connection that forgets to call withOrgContext() will
-- silently read/write across ALL organizations.
--
-- MITIGATION in place:
--   • All application code goes through withOrgContext() in src/db/index.ts,
--     which sets the session variable inside every transaction.
--   • Direct DB access (psql, scripts) should use a separate superuser role
--     that is not used by the application connection pool.
--
-- LONG-TERM RECOMMENDATION:
--   Create a dedicated `app_admin` role with BYPASSRLS privilege for admin
--   scripts, then remove the IS NULL clause from all policies below so that
--   application connections can never access cross-org data by accident.
-- ============================================================================

-- ============================================================================
-- Conditional RLS Setup (only applies to tables that exist)
-- ============================================================================

DO $$
BEGIN
  -- journal_headers
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'journal_headers') THEN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'journal_headers' AND column_name = 'organization_id') THEN
      ALTER TABLE journal_headers ADD COLUMN organization_id TEXT;
    END IF;
    ALTER TABLE journal_headers ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS org_isolation_journal_headers ON journal_headers;
    CREATE POLICY org_isolation_journal_headers ON journal_headers FOR ALL
      USING (current_organization_id() IS NULL OR organization_id = current_organization_id())
      WITH CHECK (current_organization_id() IS NULL OR organization_id = current_organization_id());
    CREATE INDEX IF NOT EXISTS idx_journal_headers_org ON journal_headers(organization_id);
    RAISE NOTICE 'RLS configured for journal_headers';
  END IF;

  -- accounts
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'accounts') THEN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'accounts' AND column_name = 'organization_id') THEN
      ALTER TABLE accounts ADD COLUMN organization_id TEXT;
    END IF;
    ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS org_isolation_accounts ON accounts;
    CREATE POLICY org_isolation_accounts ON accounts FOR ALL
      USING (current_organization_id() IS NULL OR organization_id = current_organization_id())
      WITH CHECK (current_organization_id() IS NULL OR organization_id = current_organization_id());
    CREATE INDEX IF NOT EXISTS idx_accounts_org ON accounts(organization_id);
    RAISE NOTICE 'RLS configured for accounts';
  END IF;

  -- parties
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'parties') THEN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'parties' AND column_name = 'organization_id') THEN
      ALTER TABLE parties ADD COLUMN organization_id TEXT;
    END IF;
    ALTER TABLE parties ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS org_isolation_parties ON parties;
    CREATE POLICY org_isolation_parties ON parties FOR ALL
      USING (current_organization_id() IS NULL OR organization_id = current_organization_id())
      WITH CHECK (current_organization_id() IS NULL OR organization_id = current_organization_id());
    CREATE INDEX IF NOT EXISTS idx_parties_org ON parties(organization_id);
    RAISE NOTICE 'RLS configured for parties';
  END IF;

  -- documents
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'documents') THEN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'documents' AND column_name = 'organization_id') THEN
      ALTER TABLE documents ADD COLUMN organization_id TEXT;
    END IF;
    ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
    
    -- Base policy: SELECT for all org members
    DROP POLICY IF EXISTS org_isolation_documents ON documents;
    DROP POLICY IF EXISTS documents_select_policy ON documents;
    CREATE POLICY documents_select_policy ON documents FOR SELECT
      USING (current_organization_id() IS NULL OR organization_id = current_organization_id());
    
    -- INSERT: any org member can insert (will be owned by them)
    DROP POLICY IF EXISTS documents_insert_policy ON documents;
    CREATE POLICY documents_insert_policy ON documents FOR INSERT
      WITH CHECK (current_organization_id() IS NULL OR organization_id = current_organization_id());
    
    -- UPDATE: owner or admin only
    DROP POLICY IF EXISTS documents_update_policy ON documents;
    CREATE POLICY documents_update_policy ON documents FOR UPDATE
      USING (
        current_organization_id() IS NULL 
        OR (
          organization_id = current_organization_id()
          AND (is_admin() OR uploaded_by_id::text = current_user_id())
        )
      )
      WITH CHECK (
        current_organization_id() IS NULL 
        OR (
          organization_id = current_organization_id()
          AND (is_admin() OR uploaded_by_id::text = current_user_id())
        )
      );
    
    -- DELETE: owner or admin only
    DROP POLICY IF EXISTS documents_delete_policy ON documents;
    CREATE POLICY documents_delete_policy ON documents FOR DELETE
      USING (
        current_organization_id() IS NULL 
        OR (
          organization_id = current_organization_id()
          AND (is_admin() OR uploaded_by_id::text = current_user_id())
        )
      );
    
    CREATE INDEX IF NOT EXISTS idx_documents_org ON documents(organization_id);
    CREATE INDEX IF NOT EXISTS idx_documents_owner ON documents(uploaded_by_id);
    RAISE NOTICE 'RLS configured for documents (with owner-based policies)';
  END IF;

  -- document_attachments
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'document_attachments') THEN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'document_attachments' AND column_name = 'organization_id') THEN
      ALTER TABLE document_attachments ADD COLUMN organization_id TEXT;
    END IF;
    ALTER TABLE document_attachments ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS org_isolation_document_attachments ON document_attachments;
    CREATE POLICY org_isolation_document_attachments ON document_attachments FOR ALL
      USING (current_organization_id() IS NULL OR organization_id = current_organization_id())
      WITH CHECK (current_organization_id() IS NULL OR organization_id = current_organization_id());
    CREATE INDEX IF NOT EXISTS idx_document_attachments_org ON document_attachments(organization_id);
    RAISE NOTICE 'RLS configured for document_attachments';
  END IF;

  -- journal_lines
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'journal_lines') THEN
    ALTER TABLE journal_lines ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS org_isolation_journal_lines ON journal_lines;
    CREATE POLICY org_isolation_journal_lines ON journal_lines FOR ALL
      USING (
        current_organization_id() IS NULL OR EXISTS (
          SELECT 1 FROM journal_headers h
          WHERE h.id = journal_lines.journal_header_id
            AND h.organization_id = current_organization_id()
        )
      )
      WITH CHECK (
        current_organization_id() IS NULL OR EXISTS (
          SELECT 1 FROM journal_headers h
          WHERE h.id = journal_lines.journal_header_id
            AND h.organization_id = current_organization_id()
        )
      );
    CREATE INDEX IF NOT EXISTS idx_journal_lines_header ON journal_lines(journal_header_id);
    RAISE NOTICE 'RLS configured for journal_lines (derived from journal_headers)';
  END IF;

  -- comments
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'comments') THEN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'comments' AND column_name = 'organization_id') THEN
      ALTER TABLE comments ADD COLUMN organization_id TEXT;
    END IF;
    ALTER TABLE comments ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS org_isolation_comments ON comments;
    CREATE POLICY org_isolation_comments ON comments FOR ALL
      USING (current_organization_id() IS NULL OR organization_id = current_organization_id())
      WITH CHECK (current_organization_id() IS NULL OR organization_id = current_organization_id());
    CREATE INDEX IF NOT EXISTS idx_comments_org ON comments(organization_id);
    RAISE NOTICE 'RLS configured for comments';
  END IF;

  -- activity_logs
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'activity_logs') THEN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'activity_logs' AND column_name = 'organization_id') THEN
      ALTER TABLE activity_logs ADD COLUMN organization_id TEXT;
    END IF;
    ALTER TABLE activity_logs ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS org_isolation_activity_logs ON activity_logs;
    CREATE POLICY org_isolation_activity_logs ON activity_logs FOR ALL
      USING (current_organization_id() IS NULL OR organization_id = current_organization_id())
      WITH CHECK (current_organization_id() IS NULL OR organization_id = current_organization_id());
    CREATE INDEX IF NOT EXISTS idx_activity_logs_org ON activity_logs(organization_id);
    RAISE NOTICE 'RLS configured for activity_logs';
  END IF;

  -- invoices
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'invoices') THEN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'invoices' AND column_name = 'organization_id') THEN
      ALTER TABLE invoices ADD COLUMN organization_id TEXT;
    END IF;
    ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS org_isolation_invoices ON invoices;
    CREATE POLICY org_isolation_invoices ON invoices FOR ALL
      USING (current_organization_id() IS NULL OR organization_id = current_organization_id())
      WITH CHECK (current_organization_id() IS NULL OR organization_id = current_organization_id());
    CREATE INDEX IF NOT EXISTS idx_invoices_org ON invoices(organization_id);
    RAISE NOTICE 'RLS configured for invoices';
  END IF;

  -- invoice_line_items
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'invoice_line_items') THEN
    ALTER TABLE invoice_line_items ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS org_isolation_invoice_line_items ON invoice_line_items;
    CREATE POLICY org_isolation_invoice_line_items ON invoice_line_items FOR ALL
      USING (
        current_organization_id() IS NULL OR EXISTS (
          SELECT 1 FROM invoices i
          WHERE i.id = invoice_line_items.invoice_id
            AND i.organization_id = current_organization_id()
        )
      )
      WITH CHECK (
        current_organization_id() IS NULL OR EXISTS (
          SELECT 1 FROM invoices i
          WHERE i.id = invoice_line_items.invoice_id
            AND i.organization_id = current_organization_id()
        )
      );
    CREATE INDEX IF NOT EXISTS idx_invoice_line_items_invoice ON invoice_line_items(invoice_id);
    RAISE NOTICE 'RLS configured for invoice_line_items (derived from invoices)';
  END IF;

  -- bills
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'bills') THEN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'bills' AND column_name = 'organization_id') THEN
      ALTER TABLE bills ADD COLUMN organization_id TEXT;
    END IF;
    ALTER TABLE bills ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS org_isolation_bills ON bills;
    CREATE POLICY org_isolation_bills ON bills FOR ALL
      USING (current_organization_id() IS NULL OR organization_id = current_organization_id())
      WITH CHECK (current_organization_id() IS NULL OR organization_id = current_organization_id());
    CREATE INDEX IF NOT EXISTS idx_bills_org ON bills(organization_id);
    RAISE NOTICE 'RLS configured for bills';
  END IF;

  -- bill_line_items
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'bill_line_items') THEN
    ALTER TABLE bill_line_items ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS org_isolation_bill_line_items ON bill_line_items;
    CREATE POLICY org_isolation_bill_line_items ON bill_line_items FOR ALL
      USING (
        current_organization_id() IS NULL OR EXISTS (
          SELECT 1 FROM bills b
          WHERE b.id = bill_line_items.bill_id
            AND b.organization_id = current_organization_id()
        )
      )
      WITH CHECK (
        current_organization_id() IS NULL OR EXISTS (
          SELECT 1 FROM bills b
          WHERE b.id = bill_line_items.bill_id
            AND b.organization_id = current_organization_id()
        )
      );
    CREATE INDEX IF NOT EXISTS idx_bill_line_items_bill ON bill_line_items(bill_id);
    RAISE NOTICE 'RLS configured for bill_line_items (derived from bills)';
  END IF;

  -- user_preferences
  -- This table is PER-USER (keyed on user_id), not per-org — isolate by the current user,
  -- not the current organization. An org-keyed policy would deny every read/write (the table
  -- has no meaningful organization_id) and silently reset each user's timezone under FORCE RLS.
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'user_preferences') THEN
    ALTER TABLE user_preferences ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS org_isolation_user_preferences ON user_preferences;
    DROP POLICY IF EXISTS user_isolation_user_preferences ON user_preferences;
    CREATE POLICY user_isolation_user_preferences ON user_preferences FOR ALL
      USING (current_user_id() IS NULL OR user_id::text = current_user_id())
      WITH CHECK (current_user_id() IS NULL OR user_id::text = current_user_id());
    RAISE NOTICE 'RLS configured for user_preferences (scoped by user_id)';
  END IF;

  -- party_type_mappings
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'party_type_mappings') THEN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'party_type_mappings' AND column_name = 'organization_id') THEN
      ALTER TABLE party_type_mappings ADD COLUMN organization_id TEXT;
    END IF;
    ALTER TABLE party_type_mappings ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS org_isolation_party_type_mappings ON party_type_mappings;
    CREATE POLICY org_isolation_party_type_mappings ON party_type_mappings FOR ALL
      USING (current_organization_id() IS NULL OR organization_id = current_organization_id())
      WITH CHECK (current_organization_id() IS NULL OR organization_id = current_organization_id());
    CREATE INDEX IF NOT EXISTS idx_party_type_mappings_org ON party_type_mappings(organization_id);
    RAISE NOTICE 'RLS configured for party_type_mappings';
  END IF;

  -- products
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'products') THEN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'products' AND column_name = 'organization_id') THEN
      ALTER TABLE products ADD COLUMN organization_id TEXT;
    END IF;
    ALTER TABLE products ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS org_isolation_products ON products;
    CREATE POLICY org_isolation_products ON products FOR ALL
      USING (current_organization_id() IS NULL OR organization_id = current_organization_id())
      WITH CHECK (current_organization_id() IS NULL OR organization_id = current_organization_id());
    CREATE INDEX IF NOT EXISTS idx_products_org ON products(organization_id);
    RAISE NOTICE 'RLS configured for products';
  END IF;

  -- category_connections
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'category_connections') THEN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'category_connections' AND column_name = 'organization_id') THEN
      ALTER TABLE category_connections ADD COLUMN organization_id TEXT;
    END IF;
    ALTER TABLE category_connections ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS org_isolation_category_connections ON category_connections;
    CREATE POLICY org_isolation_category_connections ON category_connections FOR ALL
      USING (current_organization_id() IS NULL OR organization_id = current_organization_id())
      WITH CHECK (current_organization_id() IS NULL OR organization_id = current_organization_id());
    CREATE INDEX IF NOT EXISTS idx_category_connections_org ON category_connections(organization_id);
    RAISE NOTICE 'RLS configured for category_connections';
  END IF;

  -- category_mappings
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'category_mappings') THEN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'category_mappings' AND column_name = 'organization_id') THEN
      ALTER TABLE category_mappings ADD COLUMN organization_id TEXT;
    END IF;
    ALTER TABLE category_mappings ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS org_isolation_category_mappings ON category_mappings;
    CREATE POLICY org_isolation_category_mappings ON category_mappings FOR ALL
      USING (current_organization_id() IS NULL OR organization_id = current_organization_id())
      WITH CHECK (current_organization_id() IS NULL OR organization_id = current_organization_id());
    CREATE INDEX IF NOT EXISTS idx_category_mappings_org ON category_mappings(organization_id);
    RAISE NOTICE 'RLS configured for category_mappings';
  END IF;

  -- document_suggestions
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'document_suggestions') THEN
    ALTER TABLE document_suggestions ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS org_isolation_document_suggestions ON document_suggestions;
    CREATE POLICY org_isolation_document_suggestions ON document_suggestions FOR ALL
      USING (
        current_organization_id() IS NULL OR EXISTS (
          SELECT 1 FROM documents d
          WHERE d.id = document_suggestions.document_id
            AND d.organization_id = current_organization_id()
        )
      )
      WITH CHECK (
        current_organization_id() IS NULL OR EXISTS (
          SELECT 1 FROM documents d
          WHERE d.id = document_suggestions.document_id
            AND d.organization_id = current_organization_id()
        )
      );
    CREATE INDEX IF NOT EXISTS idx_document_suggestions_document
      ON document_suggestions(document_id);
    RAISE NOTICE 'RLS configured for document_suggestions (derived from documents)';
  END IF;

  -- match_history
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'match_history') THEN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'match_history' AND column_name = 'organization_id') THEN
      ALTER TABLE match_history ADD COLUMN organization_id TEXT;
    END IF;
    ALTER TABLE match_history ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS org_isolation_match_history ON match_history;
    CREATE POLICY org_isolation_match_history ON match_history FOR ALL
      USING (current_organization_id() IS NULL OR organization_id = current_organization_id())
      WITH CHECK (current_organization_id() IS NULL OR organization_id = current_organization_id());
    CREATE INDEX IF NOT EXISTS idx_match_history_org ON match_history(organization_id);
    RAISE NOTICE 'RLS configured for match_history';
  END IF;

  -- reconciliations
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'reconciliations') THEN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'reconciliations' AND column_name = 'organization_id') THEN
      ALTER TABLE reconciliations ADD COLUMN organization_id TEXT;
    END IF;
    ALTER TABLE reconciliations ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS org_isolation_reconciliations ON reconciliations;
    CREATE POLICY org_isolation_reconciliations ON reconciliations FOR ALL
      USING (current_organization_id() IS NULL OR organization_id = current_organization_id())
      WITH CHECK (current_organization_id() IS NULL OR organization_id = current_organization_id());
    CREATE INDEX IF NOT EXISTS idx_reconciliations_org ON reconciliations(organization_id);
    RAISE NOTICE 'RLS configured for reconciliations';
  END IF;

  -- statement_lines
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'statement_lines') THEN
    ALTER TABLE statement_lines ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS org_isolation_statement_lines ON statement_lines;
    CREATE POLICY org_isolation_statement_lines ON statement_lines FOR ALL
      USING (
        current_organization_id() IS NULL OR EXISTS (
          SELECT 1 FROM reconciliations r
          WHERE r.id = statement_lines.reconciliation_id
            AND r.organization_id = current_organization_id()
        )
      )
      WITH CHECK (
        current_organization_id() IS NULL OR EXISTS (
          SELECT 1 FROM reconciliations r
          WHERE r.id = statement_lines.reconciliation_id
            AND r.organization_id = current_organization_id()
        )
      );
    CREATE INDEX IF NOT EXISTS idx_statement_lines_reconciliation
      ON statement_lines(reconciliation_id);
    RAISE NOTICE 'RLS configured for statement_lines (derived from reconciliations)';
  END IF;

  -- reconciliation_suggestions
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'reconciliation_suggestions') THEN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'reconciliation_suggestions' AND column_name = 'organization_id') THEN
      ALTER TABLE reconciliation_suggestions ADD COLUMN organization_id TEXT;
    END IF;
    ALTER TABLE reconciliation_suggestions ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS org_isolation_reconciliation_suggestions ON reconciliation_suggestions;
    CREATE POLICY org_isolation_reconciliation_suggestions ON reconciliation_suggestions FOR ALL
      USING (current_organization_id() IS NULL OR organization_id = current_organization_id())
      WITH CHECK (current_organization_id() IS NULL OR organization_id = current_organization_id());
    CREATE INDEX IF NOT EXISTS idx_reconciliation_suggestions_org ON reconciliation_suggestions(organization_id);
    RAISE NOTICE 'RLS configured for reconciliation_suggestions';
  END IF;

  -- reconciliation_flags
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'reconciliation_flags') THEN
    ALTER TABLE reconciliation_flags ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS org_isolation_reconciliation_flags ON reconciliation_flags;
    CREATE POLICY org_isolation_reconciliation_flags ON reconciliation_flags FOR ALL
      USING (
        current_organization_id() IS NULL OR EXISTS (
          SELECT 1 FROM reconciliations r
          WHERE r.id = reconciliation_flags.reconciliation_id
            AND r.organization_id = current_organization_id()
        )
      )
      WITH CHECK (
        current_organization_id() IS NULL OR EXISTS (
          SELECT 1 FROM reconciliations r
          WHERE r.id = reconciliation_flags.reconciliation_id
            AND r.organization_id = current_organization_id()
        )
      );
    CREATE INDEX IF NOT EXISTS idx_reconciliation_flags_reconciliation
      ON reconciliation_flags(reconciliation_id);
    RAISE NOTICE 'RLS configured for reconciliation_flags (derived from reconciliations)';
  END IF;

  -- dimensions
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'dimensions') THEN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'dimensions' AND column_name = 'organization_id') THEN
      ALTER TABLE dimensions ADD COLUMN organization_id TEXT;
    END IF;
    ALTER TABLE dimensions ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS org_isolation_dimensions ON dimensions;
    CREATE POLICY org_isolation_dimensions ON dimensions FOR ALL
      USING (current_organization_id() IS NULL OR organization_id = current_organization_id())
      WITH CHECK (current_organization_id() IS NULL OR organization_id = current_organization_id());
    CREATE INDEX IF NOT EXISTS idx_dimensions_org ON dimensions(organization_id);
    RAISE NOTICE 'RLS configured for dimensions';
  END IF;

  -- financial_accounts
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'financial_accounts') THEN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'financial_accounts' AND column_name = 'organization_id') THEN
      ALTER TABLE financial_accounts ADD COLUMN organization_id TEXT;
    END IF;
    ALTER TABLE financial_accounts ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS org_isolation_financial_accounts ON financial_accounts;
    CREATE POLICY org_isolation_financial_accounts ON financial_accounts FOR ALL
      USING (current_organization_id() IS NULL OR organization_id = current_organization_id())
      WITH CHECK (current_organization_id() IS NULL OR organization_id = current_organization_id());
    CREATE INDEX IF NOT EXISTS idx_financial_accounts_org ON financial_accounts(organization_id);
    RAISE NOTICE 'RLS configured for financial_accounts';
  END IF;

  -- bank_transactions
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'bank_transactions') THEN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'bank_transactions' AND column_name = 'organization_id') THEN
      ALTER TABLE bank_transactions ADD COLUMN organization_id TEXT;
    END IF;
    ALTER TABLE bank_transactions ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS org_isolation_bank_transactions ON bank_transactions;
    CREATE POLICY org_isolation_bank_transactions ON bank_transactions FOR ALL
      USING (current_organization_id() IS NULL OR organization_id = current_organization_id())
      WITH CHECK (current_organization_id() IS NULL OR organization_id = current_organization_id());
    CREATE INDEX IF NOT EXISTS idx_bank_transactions_org ON bank_transactions(organization_id);
    RAISE NOTICE 'RLS configured for bank_transactions';
  END IF;

  -- partyable_links
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'partyable_links') THEN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'partyable_links' AND column_name = 'organization_id') THEN
      ALTER TABLE partyable_links ADD COLUMN organization_id TEXT;
    END IF;
    ALTER TABLE partyable_links ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS org_isolation_partyable_links ON partyable_links;
    CREATE POLICY org_isolation_partyable_links ON partyable_links FOR ALL
      USING (current_organization_id() IS NULL OR organization_id = current_organization_id())
      WITH CHECK (current_organization_id() IS NULL OR organization_id = current_organization_id());
    CREATE INDEX IF NOT EXISTS idx_partyable_links_org ON partyable_links(organization_id);
    RAISE NOTICE 'RLS configured for partyable_links';
  END IF;

  -- number_sequences
  -- This table has NO organization_id column — the org is embedded in the `scope` text
  -- primary key as "<kind>:<orgId>" (e.g. "journal:<orgId>", "invoice:<orgId>"). The policy
  -- must derive the org from scope; a policy keyed on a (never-populated) organization_id
  -- column would deny every allocation under FORCE RLS and break all journal/invoice numbering.
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'number_sequences') THEN
    ALTER TABLE number_sequences ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS org_isolation_number_sequences ON number_sequences;
    CREATE POLICY org_isolation_number_sequences ON number_sequences FOR ALL
      USING (
        current_organization_id() IS NULL
        OR substring(scope from strpos(scope, ':') + 1) = current_organization_id()
      )
      WITH CHECK (
        current_organization_id() IS NULL
        OR substring(scope from strpos(scope, ':') + 1) = current_organization_id()
      );
    RAISE NOTICE 'RLS configured for number_sequences (scoped by scope text)';
  END IF;

  -- Inbox-first ingestion, review, integration, FX, and firm-client tables.
  -- Every table in this list owns organization_id directly, so the policy can use
  -- the standard tenant predicate instead of deriving ownership through a join.
  DECLARE
    inbox_table text;
  BEGIN
    FOREACH inbox_table IN ARRAY ARRAY[
      'organization_accounting_settings', 'firm_clients', 'firm_member_client_access',
      'fx_rates', 'integration_connections', 'integration_sources', 'integration_sync_runs',
      'ingestion_events', 'processing_jobs', 'source_records', 'source_record_versions',
      'source_record_documents', 'transaction_candidates', 'transaction_candidate_sources',
      'transaction_candidate_lines', 'inbox_items', 'inbox_watchers',
      'review_rule_configs', 'review_rule_runs', 'review_findings', 'review_decisions',
      'workflow_events', 'source_match_candidates', 'ledger_source_links',
      'journal_duplicate_merges', 'legacy_match_conversion_records',
      'accounting_operation_idempotency'
    ]
    LOOP
      IF EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = inbox_table
      ) THEN
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', inbox_table);
        EXECUTE format('DROP POLICY IF EXISTS org_isolation_%I ON %I', inbox_table, inbox_table);
        EXECUTE format(
          'CREATE POLICY org_isolation_%I ON %I FOR ALL USING (current_organization_id() IS NULL OR organization_id = current_organization_id()) WITH CHECK (current_organization_id() IS NULL OR organization_id = current_organization_id())',
          inbox_table,
          inbox_table
        );
      END IF;
    END LOOP;
  END;
END $$;

-- ============================================================================
-- AI telemetry (ai_invocations)
-- Append-only telemetry written OUTSIDE org context on the raw pool connection
-- (see src/lib/ai/invoke.ts) so rows survive caller-transaction rollback.
-- SELECT is tenant-scoped as usual; INSERT only requires a non-null org id.
-- Revisit the INSERT carve-out when the rls_hardening Section-B flip lands and
-- worker paths hold system context.
-- ============================================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'ai_invocations') THEN
    ALTER TABLE ai_invocations ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS org_isolation_ai_invocations_select ON ai_invocations;
    CREATE POLICY org_isolation_ai_invocations_select ON ai_invocations FOR SELECT
      USING (current_organization_id() IS NULL OR organization_id = current_organization_id());
    DROP POLICY IF EXISTS org_isolation_ai_invocations_insert ON ai_invocations;
    CREATE POLICY org_isolation_ai_invocations_insert ON ai_invocations FOR INSERT
      WITH CHECK (organization_id IS NOT NULL);
    DROP POLICY IF EXISTS org_isolation_ai_invocations_update ON ai_invocations;
    CREATE POLICY org_isolation_ai_invocations_update ON ai_invocations FOR UPDATE
      USING (true)
      WITH CHECK (organization_id IS NOT NULL);
    RAISE NOTICE 'RLS configured for ai_invocations (append-only telemetry)';
  END IF;
END $$;

-- ============================================================================
-- AI proposals + feedback (ai_action_proposals, ai_run_feedback)
-- Standard tenant isolation — both tables are written inside org context
-- (unlike ai_invocations, which is append-only telemetry on the raw pool).
-- ============================================================================
DO $$
DECLARE
  ai_table text;
BEGIN
  FOREACH ai_table IN ARRAY ARRAY['ai_action_proposals', 'ai_run_feedback']
  LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ai_table
    ) THEN
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', ai_table);
      EXECUTE format('DROP POLICY IF EXISTS org_isolation_%I ON %I', ai_table, ai_table);
      EXECUTE format(
        'CREATE POLICY org_isolation_%I ON %I FOR ALL USING (current_organization_id() IS NULL OR organization_id = current_organization_id()) WITH CHECK (current_organization_id() IS NULL OR organization_id = current_organization_id())',
        ai_table,
        ai_table
      );
      RAISE NOTICE 'RLS configured for %', ai_table;
    END IF;
  END LOOP;
END $$;

-- ============================================================================
-- AI pipeline run ledger (agent_runs, agent_run_steps) — standard tenant
-- isolation; written by worker paths holding org context.
-- ============================================================================
DO $$
DECLARE
  run_table text;
BEGIN
  FOREACH run_table IN ARRAY ARRAY['agent_runs', 'agent_run_steps']
  LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = run_table
    ) THEN
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', run_table);
      EXECUTE format('DROP POLICY IF EXISTS org_isolation_%I ON %I', run_table, run_table);
      EXECUTE format(
        'CREATE POLICY org_isolation_%I ON %I FOR ALL USING (current_organization_id() IS NULL OR organization_id = current_organization_id()) WITH CHECK (current_organization_id() IS NULL OR organization_id = current_organization_id())',
        run_table,
        run_table
      );
      RAISE NOTICE 'RLS configured for %', run_table;
    END IF;
  END LOOP;
END $$;

-- ============================================================================
-- Vendor alias memory (vendor_aliases) — standard tenant isolation.
-- ============================================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'vendor_aliases') THEN
    ALTER TABLE vendor_aliases ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS org_isolation_vendor_aliases ON vendor_aliases;
    CREATE POLICY org_isolation_vendor_aliases ON vendor_aliases FOR ALL
      USING (current_organization_id() IS NULL OR organization_id = current_organization_id())
      WITH CHECK (current_organization_id() IS NULL OR organization_id = current_organization_id());
    RAISE NOTICE 'RLS configured for vendor_aliases';
  END IF;
END $$;

-- ============================================================================
-- AI provider health (ai_provider_health) — cross-replica credential health.
-- Like ai_invocations this is written on the raw pool (a cooldown must
-- survive caller-transaction rollback), so INSERT/UPDATE only require a
-- non-null org id; SELECT stays tenant-scoped.
-- ============================================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'ai_provider_health') THEN
    ALTER TABLE ai_provider_health ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS org_isolation_ai_provider_health_select ON ai_provider_health;
    CREATE POLICY org_isolation_ai_provider_health_select ON ai_provider_health FOR SELECT
      USING (current_organization_id() IS NULL OR organization_id = current_organization_id());
    DROP POLICY IF EXISTS org_isolation_ai_provider_health_insert ON ai_provider_health;
    CREATE POLICY org_isolation_ai_provider_health_insert ON ai_provider_health FOR INSERT
      WITH CHECK (organization_id IS NOT NULL);
    DROP POLICY IF EXISTS org_isolation_ai_provider_health_update ON ai_provider_health;
    CREATE POLICY org_isolation_ai_provider_health_update ON ai_provider_health FOR UPDATE
      USING (true) WITH CHECK (organization_id IS NOT NULL);
    RAISE NOTICE 'RLS configured for ai_provider_health';
  END IF;
END $$;

-- ============================================================================
-- Per-org AI credentials + settings — standard tenant isolation. Both are
-- written inside org context from the settings routes.
-- ============================================================================
DO $$
DECLARE
  cfg_table text;
BEGIN
  FOREACH cfg_table IN ARRAY ARRAY['organization_ai_credentials', 'organization_ai_settings']
  LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = cfg_table
    ) THEN
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', cfg_table);
      EXECUTE format('DROP POLICY IF EXISTS org_isolation_%I ON %I', cfg_table, cfg_table);
      EXECUTE format(
        'CREATE POLICY org_isolation_%I ON %I FOR ALL USING (current_organization_id() IS NULL OR organization_id = current_organization_id()) WITH CHECK (current_organization_id() IS NULL OR organization_id = current_organization_id())',
        cfg_table,
        cfg_table
      );
      RAISE NOTICE 'RLS configured for %', cfg_table;
    END IF;
  END LOOP;
END $$;

-- ============================================================================
-- Lessons + eval cases. ai_eval_cases allows organization_id IS NULL — that
-- is the cross-org GOLDEN SET, which a case only joins with explicit org
-- consent (enforced in the curation script, not by RLS).
-- ============================================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'ai_lessons') THEN
    ALTER TABLE ai_lessons ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS org_isolation_ai_lessons ON ai_lessons;
    CREATE POLICY org_isolation_ai_lessons ON ai_lessons FOR ALL
      USING (current_organization_id() IS NULL OR organization_id = current_organization_id())
      WITH CHECK (current_organization_id() IS NULL OR organization_id = current_organization_id());
    RAISE NOTICE 'RLS configured for ai_lessons';
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'ai_eval_cases') THEN
    ALTER TABLE ai_eval_cases ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS org_isolation_ai_eval_cases ON ai_eval_cases;
    CREATE POLICY org_isolation_ai_eval_cases ON ai_eval_cases FOR ALL
      USING (
        current_organization_id() IS NULL
        OR organization_id IS NULL
        OR organization_id = current_organization_id()
      )
      WITH CHECK (
        current_organization_id() IS NULL
        OR organization_id = current_organization_id()
      );
    RAISE NOTICE 'RLS configured for ai_eval_cases';
  END IF;
END $$;

-- ============================================================================
-- Split clearing rows (statement_line_matches) — standard tenant isolation.
-- ============================================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'statement_line_matches') THEN
    ALTER TABLE statement_line_matches ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS org_isolation_statement_line_matches ON statement_line_matches;
    CREATE POLICY org_isolation_statement_line_matches ON statement_line_matches FOR ALL
      USING (current_organization_id() IS NULL OR organization_id = current_organization_id())
      WITH CHECK (current_organization_id() IS NULL OR organization_id = current_organization_id());
    RAISE NOTICE 'RLS configured for statement_line_matches';
  END IF;
END $$;

-- ============================================================================
-- Philippine BIR tax subsystem (drizzle/0037_tax_reference_core.sql)
-- ============================================================================
-- GLOBAL, deliberately WITHOUT policies: tax_reference_datasets,
-- tax_withholding_tables, tax_de_minimis_ceilings. These carry statutory rates,
-- not tenant data — the same treatment review_rule_definitions gets. A per-org
-- copy of a national rate is the drift bug IMPLEMENTATION-PLAN.md blocker B11
-- describes: a rate change would never reach an org that already onboarded.
--
-- Org-scoped and therefore isolated: org_tax_profiles, org_tax_branches. Both
-- will hold TINs and filing identity, which is among the most sensitive data
-- the product stores.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'org_tax_profiles') THEN
    ALTER TABLE org_tax_profiles ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS org_isolation_org_tax_profiles ON org_tax_profiles;
    CREATE POLICY org_isolation_org_tax_profiles ON org_tax_profiles FOR ALL
      USING (current_organization_id() IS NULL OR organization_id = current_organization_id())
      WITH CHECK (current_organization_id() IS NULL OR organization_id = current_organization_id());
    RAISE NOTICE 'RLS configured for org_tax_profiles';
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'org_tax_branches') THEN
    ALTER TABLE org_tax_branches ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS org_isolation_org_tax_branches ON org_tax_branches;
    CREATE POLICY org_isolation_org_tax_branches ON org_tax_branches FOR ALL
      USING (current_organization_id() IS NULL OR organization_id = current_organization_id())
      WITH CHECK (current_organization_id() IS NULL OR organization_id = current_organization_id());
    RAISE NOTICE 'RLS configured for org_tax_branches';
  END IF;
END $$;

-- ============================================================================
-- Payroll compliance (Stage 5a of docs/tax/IMPLEMENTATION-PLAN.md)
-- ============================================================================
-- Every table here is org-scoped and holds employee compensation — among the
-- most sensitive data the product stores. Note that RLS is not actually
-- enforced today (rls_hardening.sql Section B is commented out and the app
-- connects as the table owner), so the application-level organizationId
-- predicate is the real boundary; these policies are the ratchet for when it is.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'payroll_runs') THEN
    ALTER TABLE payroll_runs ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS org_isolation_payroll_runs ON payroll_runs;
    CREATE POLICY org_isolation_payroll_runs ON payroll_runs FOR ALL
      USING (current_organization_id() IS NULL OR organization_id = current_organization_id())
      WITH CHECK (current_organization_id() IS NULL OR organization_id = current_organization_id());
    RAISE NOTICE 'RLS configured for payroll_runs';
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'payroll_lines') THEN
    ALTER TABLE payroll_lines ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS org_isolation_payroll_lines ON payroll_lines;
    CREATE POLICY org_isolation_payroll_lines ON payroll_lines FOR ALL
      USING (current_organization_id() IS NULL OR organization_id = current_organization_id())
      WITH CHECK (current_organization_id() IS NULL OR organization_id = current_organization_id());
    RAISE NOTICE 'RLS configured for payroll_lines';
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'payroll_employee_year_state') THEN
    ALTER TABLE payroll_employee_year_state ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS org_isolation_payroll_employee_year_state ON payroll_employee_year_state;
    CREATE POLICY org_isolation_payroll_employee_year_state ON payroll_employee_year_state FOR ALL
      USING (current_organization_id() IS NULL OR organization_id = current_organization_id())
      WITH CHECK (current_organization_id() IS NULL OR organization_id = current_organization_id());
    RAISE NOTICE 'RLS configured for payroll_employee_year_state';
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'payroll_previous_employer_2316') THEN
    ALTER TABLE payroll_previous_employer_2316 ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS org_isolation_payroll_previous_employer_2316 ON payroll_previous_employer_2316;
    CREATE POLICY org_isolation_payroll_previous_employer_2316 ON payroll_previous_employer_2316 FOR ALL
      USING (current_organization_id() IS NULL OR organization_id = current_organization_id())
      WITH CHECK (current_organization_id() IS NULL OR organization_id = current_organization_id());
    RAISE NOTICE 'RLS configured for payroll_previous_employer_2316';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'party_tax_profiles') THEN
    ALTER TABLE party_tax_profiles ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS org_isolation_party_tax_profiles ON party_tax_profiles;
    CREATE POLICY org_isolation_party_tax_profiles ON party_tax_profiles FOR ALL
      USING (current_organization_id() IS NULL OR organization_id = current_organization_id())
      WITH CHECK (current_organization_id() IS NULL OR organization_id = current_organization_id());
    RAISE NOTICE 'RLS configured for party_tax_profiles';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'tax_certificates') THEN
    ALTER TABLE tax_certificates ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS org_isolation_tax_certificates ON tax_certificates;
    CREATE POLICY org_isolation_tax_certificates ON tax_certificates FOR ALL
      USING (current_organization_id() IS NULL OR organization_id = current_organization_id())
      WITH CHECK (current_organization_id() IS NULL OR organization_id = current_organization_id());
    RAISE NOTICE 'RLS configured for tax_certificates';
  END IF;
END $$;

-- Stage remainder tables. filing_deadline_overrides is GLOBAL and has no policy.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'org_tax_year_elections') THEN
    ALTER TABLE org_tax_year_elections ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS org_isolation_org_tax_year_elections ON org_tax_year_elections;
    CREATE POLICY org_isolation_org_tax_year_elections ON org_tax_year_elections FOR ALL
      USING (current_organization_id() IS NULL OR organization_id = current_organization_id())
      WITH CHECK (current_organization_id() IS NULL OR organization_id = current_organization_id());
    RAISE NOTICE 'RLS configured for org_tax_year_elections';
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'org_tax_registrations') THEN
    ALTER TABLE org_tax_registrations ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS org_isolation_org_tax_registrations ON org_tax_registrations;
    CREATE POLICY org_isolation_org_tax_registrations ON org_tax_registrations FOR ALL
      USING (current_organization_id() IS NULL OR organization_id = current_organization_id())
      WITH CHECK (current_organization_id() IS NULL OR organization_id = current_organization_id());
    RAISE NOTICE 'RLS configured for org_tax_registrations';
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'tax_withholding_payments') THEN
    ALTER TABLE tax_withholding_payments ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS org_isolation_tax_withholding_payments ON tax_withholding_payments;
    CREATE POLICY org_isolation_tax_withholding_payments ON tax_withholding_payments FOR ALL
      USING (current_organization_id() IS NULL OR organization_id = current_organization_id())
      WITH CHECK (current_organization_id() IS NULL OR organization_id = current_organization_id());
    RAISE NOTICE 'RLS configured for tax_withholding_payments';
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'tax_computed_returns') THEN
    ALTER TABLE tax_computed_returns ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS org_isolation_tax_computed_returns ON tax_computed_returns;
    CREATE POLICY org_isolation_tax_computed_returns ON tax_computed_returns FOR ALL
      USING (current_organization_id() IS NULL OR organization_id = current_organization_id())
      WITH CHECK (current_organization_id() IS NULL OR organization_id = current_organization_id());
    RAISE NOTICE 'RLS configured for tax_computed_returns';
  END IF;
END $$;
