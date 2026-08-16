-- ============================================================================
-- RLS Hardening — non-owner runtime role + FORCE ROW LEVEL SECURITY
-- ============================================================================
-- PROBLEM this fixes (audit C1/#13):
--   Postgres does NOT apply row-level security to a table's OWNER unless the table
--   is set to FORCE ROW LEVEL SECURITY. The app currently connects with the same
--   role that owns the tables (digits_app / neondb_owner), so EVERY policy in
--   rls_policies.sql is bypassed and tenant isolation rests entirely on hand-written
--   `eq(x.organizationId, orgId)` filters. This migration closes that hole.
--
-- ⚠️  DO NOT APPLY BLIND TO PRODUCTION. Enabling FORCE while the app still connects
--     as owner, or while any query runs OUTSIDE withOrgContext(), will start REJECTING
--     those queries (once the IS NULL bypass is removed). Follow the staged rollout below.
--
-- ── STAGED ROLLOUT ──────────────────────────────────────────────────────────
--   1. Convert the raw-`db` query paths so they run in RLS context (audited list below).
--      Each must either run inside withOrgContext()/withSessionOrgContext() using ctx.db,
--      or be moved to an explicit admin/BYPASSRLS connection. Grep: `rg "\\bdb\\." src`.
--
--      MUST FIX before the flip (org-scoped filters present, but run on the raw pool
--      connection with no app.current_organization_id set — reads return nothing / writes
--      are denied once the IS NULL bypass is removed):
--        • services/reports.ts (aggregateBalances + compute*) → add a `db: DbExecutor` param;
--          pass ctx.db from callers -reports.ts, -dashboard.ts, -export-transactions.ts.
--        • -transactions-import.ts (both import handlers) → wrap in withOrgContext, use ctx.db,
--          and pass ctx.db into allocateJournalTransactionNumber.
--        • lib/account-helpers.ts getAllDescendantIds → add a `db` param; pass ctx.db.
--        • lib/insert-activity-log.ts → ensure EVERY caller passes the ctx tx (some don't).
--        • services/thumbnail-generator.ts → run inside withOrgContext or an admin connection.
--
--      LEGITIMATELY CONTEXT-FREE (system/public paths) — give these a dedicated admin/
--      BYPASSRLS connection, do NOT rely on the IS NULL bypass:
--        • -public-invoice.ts (unauthenticated payment page; reads + sent→viewed UPDATE).
--        • lib/invoice-payments.ts (Stripe/PayPal capture — no session; org from the invoice).
--
--      USER-SCOPED (keyed by user, not org): user_preferences uses the policy
--      user_id = current_user_id(). Its only consumer, -user-preferences.ts, runs BOTH
--      its read and its upsert inside withUserContext(userId) (sets app.current_user_id),
--      so it is safe under FORCE. It does NOT use withOrgContext (no active org on this
--      path). Any future per-user-scoped raw-db path must do the same.
--
--      ALREADY SAFE (run in context or touch non-RLS auth tables): reconciliations/
--      -_list-detail.ts, period-close.ts, gemini-client.ts, auth.ts, auth-middleware.ts,
--      -app-config.ts, -invitation-lookup.ts.
--   2. Provision the runtime role and grants (Section A) — safe to run anytime; it only
--      creates a role and grants, it does not change enforcement.
--   3. Point the application's DATABASE_URL at app_runtime (NOT the owner). Keep a separate
--      owner URL for migrations only. Deploy and soak — enforcement is still permissive here.
--   4. Once (1) is verified in staging, run Section B (FORCE + drop IS NULL) in a maintenance
--      window. Migrations continue to run as the owner (owner still bypasses FORCE only if it
--      also has BYPASSRLS — see note), so schema pushes are unaffected.
--
-- Re-running is safe: role creation and grants are idempotent; FORCE is idempotent.
-- ============================================================================

-- ── Section A: runtime role (safe to run now) ───────────────────────────────
-- A non-owner login role the APPLICATION connects as. It gets DML on all tables but
-- never owns them, so RLS applies to it normally.
BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    -- Password is set out-of-band (ALTER ROLE app_runtime WITH PASSWORD '...') or via IAM.
    CREATE ROLE app_runtime LOGIN;
  END IF;
END $$;

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON SCHEMA public FROM app_runtime;
GRANT USAGE ON SCHEMA public TO app_runtime;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_runtime;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM app_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_runtime;
-- Future tables/sequences created by the owner are auto-granted to app_runtime.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE ALL ON TABLES FROM app_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE ALL ON SEQUENCES FROM app_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app_runtime;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO app_runtime;

-- Security-sensitive Business Group objects are deliberately narrower than
-- the broad runtime bootstrap above. Keep this block after every ALL TABLES /
-- ALL FUNCTIONS grant so rerunning this deployment-order script cannot restore
-- audit fabrication or ownership-transfer capability access.
DO $$
DECLARE runtime_role text;
BEGIN
  FOREACH runtime_role IN ARRAY ARRAY['app_runtime', 'buwiz_app'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = runtime_role) THEN
      EXECUTE format('REVOKE CREATE ON SCHEMA public FROM %I', runtime_role);
      IF to_regclass('public.organization_group_audit_events') IS NOT NULL THEN
        EXECUTE format(
          'REVOKE ALL ON TABLE organization_group_audit_events FROM %I',
          runtime_role
        );
        EXECUTE format(
          'GRANT SELECT ON TABLE organization_group_audit_events TO %I',
          runtime_role
        );
      END IF;
      IF to_regclass('public.entitlement_events') IS NOT NULL THEN
        EXECUTE format(
          'REVOKE ALL ON TABLE entitlement_events FROM %I',
          runtime_role
        );
        EXECUTE format(
          'GRANT SELECT ON TABLE entitlement_events TO %I',
          runtime_role
        );
      END IF;
      IF to_regclass('public.business_group_projection_reconciliation_events') IS NOT NULL THEN
        EXECUTE format(
          'REVOKE ALL ON TABLE business_group_projection_reconciliation_events FROM %I',
          runtime_role
        );
        EXECUTE format(
          'GRANT SELECT, INSERT ON TABLE business_group_projection_reconciliation_events TO %I',
          runtime_role
        );
      END IF;
      IF to_regclass('public.business_group_owner_transfer_context') IS NOT NULL THEN
        EXECUTE format(
          'REVOKE ALL ON TABLE business_group_owner_transfer_context FROM %I',
          runtime_role
        );
      END IF;
      IF to_regprocedure(
        'public.transfer_organization_group_ownership(uuid,text,text)'
      ) IS NOT NULL THEN
        EXECUTE format(
          'REVOKE ALL ON FUNCTION transfer_organization_group_ownership(uuid, text, text) FROM %I',
          runtime_role
        );
      END IF;
      IF to_regprocedure('public.lock_business_group_user_rows(text[])') IS NOT NULL THEN
        EXECUTE format(
          'REVOKE ALL ON FUNCTION lock_business_group_user_rows(text[]) FROM %I',
          runtime_role
        );
      END IF;
      IF to_regprocedure('public.has_active_business_groups_entitlement(uuid)') IS NOT NULL THEN
        EXECUTE format(
          'REVOKE ALL ON FUNCTION has_active_business_groups_entitlement(uuid) FROM %I',
          runtime_role
        );
      END IF;
      -- These read-only authorization helpers are evaluated by RLS policies and
      -- lifecycle guards under the runtime role. PUBLIC execution is revoked by
      -- migration 0034, so every runtime-role normalization must grant them
      -- explicitly (including roles created after the migration ran).
      IF to_regprocedure(
        'public.is_enterprise_organization_group_member(uuid,text)'
      ) IS NOT NULL THEN
        EXECUTE format(
          'GRANT EXECUTE ON FUNCTION is_enterprise_organization_group_member(uuid, text) TO %I',
          runtime_role
        );
      END IF;
      IF to_regprocedure(
        'public.is_organization_assigned_to_business_group(uuid,text,uuid,text)'
      ) IS NOT NULL THEN
        EXECUTE format(
          'GRANT EXECUTE ON FUNCTION is_organization_assigned_to_business_group(uuid, text, uuid, text) TO %I',
          runtime_role
        );
      END IF;
      IF to_regprocedure(
        'public.is_eligible_organization_group_owner(uuid,text)'
      ) IS NOT NULL THEN
        EXECUTE format(
          'GRANT EXECUTE ON FUNCTION is_eligible_organization_group_owner(uuid, text) TO %I',
          runtime_role
        );
      END IF;
      IF to_regprocedure('public.can_manage_organization_group(uuid)') IS NOT NULL THEN
        EXECUTE format(
          'GRANT EXECUTE ON FUNCTION can_manage_organization_group(uuid) TO %I',
          runtime_role
        );
      END IF;
      IF to_regprocedure('public.can_manage_organization_group_owners(uuid)') IS NOT NULL THEN
        EXECUTE format(
          'GRANT EXECUTE ON FUNCTION can_manage_organization_group_owners(uuid) TO %I',
          runtime_role
        );
      END IF;
      IF to_regprocedure('public.can_bootstrap_organization_group(uuid,text)') IS NOT NULL THEN
        EXECUTE format(
          'GRANT EXECUTE ON FUNCTION can_bootstrap_organization_group(uuid, text) TO %I',
          runtime_role
        );
      END IF;
    END IF;
  END LOOP;
END
$$;

-- Broad runtime grants above must never expose operator-only Stripe webhook
-- evidence. TRUNCATE bypasses RLS, so explicitly remove every table privilege.
-- The subscription mirror remains member-readable through SELECT only.
DO $$
DECLARE
  runtime_role text;
BEGIN
  IF to_regclass('public.enterprise_billing_webhook_events') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON TABLE enterprise_billing_webhook_events FROM PUBLIC';
    FOREACH runtime_role IN ARRAY ARRAY['app_runtime', 'buwiz_app'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = runtime_role) THEN
        EXECUTE format(
          'REVOKE ALL ON TABLE enterprise_billing_webhook_events FROM %I',
          runtime_role
        );
      END IF;
    END LOOP;
  END IF;

  IF to_regclass('public.enterprise_billing_checkout_sessions') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON TABLE enterprise_billing_checkout_sessions FROM PUBLIC';
    FOREACH runtime_role IN ARRAY ARRAY['app_runtime', 'buwiz_app'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = runtime_role) THEN
        EXECUTE format(
          'REVOKE ALL ON TABLE enterprise_billing_checkout_sessions FROM %I',
          runtime_role
        );
      END IF;
    END LOOP;
  END IF;

  IF to_regclass('public.enterprise_billing_subscriptions') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON TABLE enterprise_billing_subscriptions FROM PUBLIC';
    FOREACH runtime_role IN ARRAY ARRAY['app_runtime', 'buwiz_app'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = runtime_role) THEN
        EXECUTE format(
          'REVOKE ALL ON TABLE enterprise_billing_subscriptions FROM %I',
          runtime_role
        );
        EXECUTE format(
          'GRANT SELECT ON TABLE enterprise_billing_subscriptions TO %I',
          runtime_role
        );
      END IF;
    END LOOP;
  END IF;
END $$;

COMMIT;

-- ── Section B: enforce RLS (run ONLY after the staged rollout above) ─────────
-- Uncomment to apply. FORCE makes RLS apply even to the table owner; dropping the
-- IS NULL bypass means a connection with no org context set can no longer read/write
-- any org's rows. Do these together — FORCE without the IS NULL drop still leaves the
-- bypass; dropping IS NULL without FORCE still lets the owner through.
--
-- DO $$
-- DECLARE
--   t text;
--   tables text[] := ARRAY[
--     'accounts','activity_logs','bank_transactions','bill_line_items','bills',
--     'category_connections','category_mappings','comments','dimensions',
--     'document_attachments','document_suggestions','documents','financial_accounts',
--     'invoice_line_items','invoices','journal_headers','journal_lines','match_history',
--     'number_sequences','parties','party_type_mappings','partyable_links','products',
--     'reconciliation_flags','reconciliation_suggestions','reconciliations',
--     'statement_lines','user_preferences'
--   ];
-- BEGIN
--   FOREACH t IN ARRAY tables LOOP
--     IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = t) THEN
--       EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY;', t);
--     END IF;
--   END LOOP;
-- END $$;
--
-- After FORCE is on, re-create each policy WITHOUT the `current_organization_id() IS NULL OR`
-- prefix so a missing org context denies rather than allows. Example for journal_lines:
--
--   DROP POLICY IF EXISTS org_isolation_journal_lines ON journal_lines;
--   CREATE POLICY org_isolation_journal_lines ON journal_lines FOR ALL
--     USING (organization_id = current_organization_id())
--     WITH CHECK (organization_id = current_organization_id());
--
-- Repeat for every table listed above (mirror the definitions in rls_policies.sql,
-- dropping the IS NULL clause).
--
-- TWO TABLES USE A DIFFERENT KEY (fixed in rls_policies.sql — do NOT use organization_id):
--   • number_sequences: scoped by the `scope` text ("<kind>:<orgId>"), so the enforced policy is
--       USING (split_part(scope, ':', 2) = current_organization_id())
--     (it has no organization_id column; an org-keyed policy denies all number allocation).
--   • user_preferences: per-user, so the enforced policy is
--       USING (user_id = current_user_id())
--     Its consumer -user-preferences.ts runs in withUserContext(userId), which issues
--     set_config('app.current_user_id', ...). Org-scoped paths set the same key via
--     withOrgContext alongside the org id.
