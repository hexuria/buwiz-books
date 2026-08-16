import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const read = (path: string) => readFileSync(resolve(REPO_ROOT, path), "utf8");

describe("isolated Buwiz Business Groups deployment", () => {
  it("locks the workflow to the approved project, service, registry, and Cloud SQL instance", () => {
    const workflow = read(".github/workflows/deploy.yml");

    expect(workflow).toContain("EXPECTED_GCP_PROJECT_ID: buwiz-503321");
    expect(workflow).toContain("SERVICE_NAME: buwiz-books");
    expect(workflow).toContain("buwiz-books-repo/app");
    expect(workflow).toContain("buwiz-503321:europe-north1:buwiz-books-db");
    expect(workflow).toContain("Validate deployment boundary");
    expect(workflow).not.toContain("SERVICE_NAME: digits");
    expect(workflow).not.toContain("digits-repo/app");
  });

  it("applies Enterprise migrations after schema reconciliation and before RLS/deploy", () => {
    const workflow = read(".github/workflows/deploy.yml");
    const push = workflow.indexOf("- name: Push DB schema");
    const enterprise = workflow.indexOf("- name: Apply Enterprise migrations\n");
    const rls = workflow.indexOf("- name: Apply RLS policies\n");
    const deploy = workflow.indexOf("- name: Deploy to Cloud Run");

    expect(push).toBeGreaterThan(-1);
    expect(enterprise).toBeGreaterThan(push);
    expect(rls).toBeGreaterThan(enterprise);
    expect(deploy).toBeGreaterThan(rls);
  });

  it("ships the migration runner and account-scoped canary settings", () => {
    const workflow = read(".github/workflows/deploy.yml");
    const dockerfile = read("Dockerfile");

    expect(dockerfile).toContain("scripts/apply-enterprise-migrations.ts");
    expect(workflow).toContain("BUSINESS_GROUP_REPORT_SOURCE=");
    expect(workflow).toContain("BUSINESS_GROUP_PROJECTION_ACCOUNT_ALLOWLIST=");
    expect(workflow).toContain("DATABASE_URL=database-url:latest");
    expect(workflow).toContain("DATABASE_URL_ADMIN=database-url-admin:latest");
    expect(workflow).toContain("migration-${{ github.sha }}");
    expect(workflow).toContain("buwiz-books-job-worker");
    expect(workflow).toContain("sha256sum --check --strict");
    expect(read("scripts/apply-enterprise-migrations.ts")).toContain(
      '"0035_enterprise_stripe_billing.sql"',
    );
    expect(read("scripts/apply-enterprise-migrations.ts")).toContain(
      '"0036_enterprise_checkout.sql"',
    );
  });

  it("keeps provider events operator-only and subscription state member-readable", () => {
    const migration = read("drizzle/0035_enterprise_stripe_billing.sql");
    const hardening = read("drizzle/rls_hardening.sql");
    const testBootstrap = read("tests/global-setup.ts");

    expect(migration).toContain("enterprise_billing_webhook_events_provider_event_unique");
    expect(migration).toContain("enterprise_billing_subscriptions_member_select");
    expect(migration).toContain("is_enterprise_account_member(enterprise_account_id)");
    expect(migration).toContain("enterprise_billing_webhook_events ENABLE ROW LEVEL SECURITY");
    expect(migration).not.toContain("enterprise_billing_webhook_events_member_select");
    expect(migration).not.toContain(
      "GRANT SELECT, INSERT, UPDATE, DELETE ON enterprise_billing_webhook_events",
    );
    for (const privilegeBoundary of [migration, hardening, testBootstrap]) {
      expect(privilegeBoundary).toContain(
        "REVOKE ALL ON TABLE enterprise_billing_webhook_events FROM PUBLIC",
      );
      expect(privilegeBoundary).toContain(
        "REVOKE ALL ON TABLE enterprise_billing_webhook_events FROM %I",
      );
      expect(privilegeBoundary).toContain(
        "REVOKE ALL ON TABLE enterprise_billing_subscriptions FROM %I",
      );
      expect(privilegeBoundary).toContain(
        "GRANT SELECT ON TABLE enterprise_billing_subscriptions TO %I",
      );
      expect(privilegeBoundary).toContain("ARRAY['app_runtime', 'buwiz_app']");
    }
    expect(
      hardening.indexOf("REVOKE ALL ON TABLE enterprise_billing_webhook_events"),
    ).toBeGreaterThan(hardening.indexOf("GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES"));
    expect(
      testBootstrap.indexOf("REVOKE ALL ON TABLE enterprise_billing_webhook_events"),
    ).toBeGreaterThan(testBootstrap.indexOf("GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES"));
  });

  it("keeps Checkout reservations operator-only and account-unique", () => {
    const migration = read("drizzle/0036_enterprise_checkout.sql");
    const hardening = read("drizzle/rls_hardening.sql");
    const testBootstrap = read("tests/global-setup.ts");

    expect(migration).toContain("enterprise_billing_checkout_sessions_active_account_unique");
    expect(migration).toContain("status IN ('creating', 'open', 'completed')");
    expect(migration).toContain("external_price_id varchar(255) NOT NULL");
    expect(migration).toContain("success_url text NOT NULL");
    expect(migration).toContain("'consumed'");
    expect(migration).toContain("enterprise_billing_checkout_sessions ENABLE ROW LEVEL SECURITY");
    expect(migration).not.toContain("CREATE POLICY");
    for (const privilegeBoundary of [migration, hardening, testBootstrap]) {
      expect(privilegeBoundary).toContain(
        "REVOKE ALL ON TABLE enterprise_billing_checkout_sessions FROM PUBLIC",
      );
      expect(privilegeBoundary).toContain(
        "REVOKE ALL ON TABLE enterprise_billing_checkout_sessions FROM %I",
      );
      expect(privilegeBoundary).toContain("ARRAY['app_runtime', 'buwiz_app']");
    }
    expect(
      hardening.indexOf("REVOKE ALL ON TABLE enterprise_billing_checkout_sessions"),
    ).toBeGreaterThan(hardening.indexOf("GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES"));
    expect(
      testBootstrap.indexOf("REVOKE ALL ON TABLE enterprise_billing_checkout_sessions"),
    ).toBeGreaterThan(testBootstrap.indexOf("GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES"));
  });

  it("makes the local provisioning path fail closed on the same target", () => {
    const provision = read("scripts/provision-gcp.sh");
    const makefile = read("Makefile");

    for (const content of [provision, makefile]) {
      expect(content).toContain("buwiz-503321");
      expect(content).toContain("buwiz-books");
    }
    expect(provision).toContain('DB_TIER="${DB_TIER:-db-custom-1-3840}"');
    expect(provision).toContain('DB_AVAILABILITY_TYPE="${DB_AVAILABILITY_TYPE:-REGIONAL}"');
    expect(provision).toContain("--enable-point-in-time-recovery");
    expect(provision).toContain("--deletion-protection");
    expect(provision).toContain('ensure_database_user_secret "$DB_RUNTIME_USER" "database-url"');
    expect(provision).toContain(
      'ensure_database_user_secret "$DB_ADMIN_USER" "database-url-admin"',
    );
    expect(provision.indexOf("billing projects describe")).toBeLessThan(
      provision.indexOf("services enable"),
    );
  });
});
