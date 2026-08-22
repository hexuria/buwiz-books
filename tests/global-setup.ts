/**
 * Global setup — runs ONCE before all test files in a single process.
 *
 * Two jobs:
 *  1. Pre-create the `buwiz_app` Postgres role that RLS integration tests switch to via
 *     `SET LOCAL ROLE buwiz_app`. This prevents the "tuple concurrently updated" race that
 *     happens when multiple parallel test files each try to CREATE USER inside their own
 *     beforeAll() at the same time.
 *     The broad fixture grants are immediately narrowed again for operator-only Enterprise
 *     billing evidence and the read-only subscription mirror.
 *  2. Seed the global review-rule catalog, so tests see the same 16 definitions the app does.
 *     Without this, CI runs against an empty `review_rule_definitions` (the workflow's test job
 *     does push + RLS only) and the suite stays green solely because individual tests
 *     hand-insert the one row they need.
 */
import postgres from "postgres";
import { loadTestEnv } from "./load-test-env";

loadTestEnv();

export async function setup() {
  const connectionString = process.env.TEST_DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "Integration tests require an explicit TEST_DATABASE_URL. " +
        "DATABASE_URL is deliberately ignored; unit and component projects need no database.",
    );
  }

  const sql = postgres(connectionString, { max: 1 });

  try {
    await sql.unsafe(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'buwiz_app') THEN
          CREATE USER buwiz_app WITH PASSWORD 'password';
        END IF;
      END $$;
      REVOKE ALL ON SCHEMA public FROM buwiz_app;
      GRANT USAGE ON SCHEMA public TO buwiz_app;
      REVOKE ALL ON ALL TABLES IN SCHEMA public FROM buwiz_app;
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO buwiz_app;
      REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM buwiz_app;
      GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO buwiz_app;
      REVOKE CREATE ON SCHEMA public FROM buwiz_app;
      DO $$ BEGIN
        IF to_regclass('public.organization_group_audit_events') IS NOT NULL THEN
          REVOKE ALL ON TABLE organization_group_audit_events FROM buwiz_app;
          GRANT SELECT ON TABLE organization_group_audit_events TO buwiz_app;
        END IF;
        IF to_regclass('public.entitlement_events') IS NOT NULL THEN
          REVOKE ALL ON TABLE entitlement_events FROM buwiz_app;
          GRANT SELECT ON TABLE entitlement_events TO buwiz_app;
        END IF;
        IF to_regclass('public.business_group_projection_reconciliation_events') IS NOT NULL THEN
          REVOKE ALL ON TABLE business_group_projection_reconciliation_events FROM buwiz_app;
          GRANT SELECT, INSERT
            ON TABLE business_group_projection_reconciliation_events TO buwiz_app;
        END IF;
        IF to_regclass('public.business_group_owner_transfer_context') IS NOT NULL THEN
          REVOKE ALL ON TABLE business_group_owner_transfer_context FROM buwiz_app;
        END IF;
        IF to_regprocedure(
          'public.transfer_organization_group_ownership(uuid,text,text)'
        ) IS NOT NULL THEN
          REVOKE ALL ON FUNCTION
            transfer_organization_group_ownership(uuid, text, text) FROM buwiz_app;
        END IF;
        IF to_regprocedure('public.lock_business_group_user_rows(text[])') IS NOT NULL THEN
          REVOKE ALL ON FUNCTION lock_business_group_user_rows(text[]) FROM buwiz_app;
        END IF;
        IF to_regprocedure('public.has_active_business_groups_entitlement(uuid)') IS NOT NULL THEN
          REVOKE ALL ON FUNCTION has_active_business_groups_entitlement(uuid) FROM buwiz_app;
        END IF;
        -- Migration 0034 revokes PUBLIC execution. The CI role is deliberately
        -- created after migrations, so mirror the production runtime-role
        -- normalization for the safe helpers required by RLS and triggers.
        IF to_regprocedure(
          'public.is_enterprise_organization_group_member(uuid,text)'
        ) IS NOT NULL THEN
          GRANT EXECUTE ON FUNCTION
            is_enterprise_organization_group_member(uuid, text) TO buwiz_app;
        END IF;
        IF to_regprocedure(
          'public.is_organization_assigned_to_business_group(uuid,text,uuid,text)'
        ) IS NOT NULL THEN
          GRANT EXECUTE ON FUNCTION
            is_organization_assigned_to_business_group(uuid, text, uuid, text) TO buwiz_app;
        END IF;
        IF to_regprocedure(
          'public.is_eligible_organization_group_owner(uuid,text)'
        ) IS NOT NULL THEN
          GRANT EXECUTE ON FUNCTION
            is_eligible_organization_group_owner(uuid, text) TO buwiz_app;
        END IF;
        IF to_regprocedure('public.can_manage_organization_group(uuid)') IS NOT NULL THEN
          GRANT EXECUTE ON FUNCTION can_manage_organization_group(uuid) TO buwiz_app;
        END IF;
        IF to_regprocedure('public.can_manage_organization_group_owners(uuid)') IS NOT NULL THEN
          GRANT EXECUTE ON FUNCTION can_manage_organization_group_owners(uuid) TO buwiz_app;
        END IF;
        IF to_regprocedure('public.can_bootstrap_organization_group(uuid,text)') IS NOT NULL THEN
          GRANT EXECUTE ON FUNCTION
            can_bootstrap_organization_group(uuid, text) TO buwiz_app;
        END IF;
      END $$;

      DO $privileges$
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
      END $privileges$;
    `);

    // Same rows as scripts/seed-review-rules.ts, different transport. Importing `{ db }` here
    // would open a second postgres pool at import time that globalSetup never closes, which
    // can hang vitest teardown — so the shared constant is pushed through the client already
    // open above. Tolerates a missing table so unit-only runs against a bare DB still work.
    try {
      const { REVIEW_RULE_CATALOG } = await import("../src/lib/inbox/review-rule-catalog");
      for (const rule of REVIEW_RULE_CATALOG) {
        await sql`
          INSERT INTO review_rule_definitions
            (key, name, group_name, evaluator_key, default_config, formula_version)
          VALUES (
            ${rule.key},
            ${rule.name},
            ${rule.group},
            ${rule.evaluatorKey},
            ${sql.json(rule.defaultConfig)},
            ${rule.formulaVersion}
          )
          ON CONFLICT (key) DO NOTHING
        `;
      }
    } catch (error) {
      if (!/review_rule_definitions/.test(String(error))) throw error;
    }
  } finally {
    await sql.end();
  }
}
