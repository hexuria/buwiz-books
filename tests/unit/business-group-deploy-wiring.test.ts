import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const read = (path: string) => readFileSync(resolve(REPO_ROOT, path), "utf8");

describe("isolated Buwiz Business Groups application wiring", () => {
  it("keeps Business Group production wiring outside application CI", () => {
    const workflow = read(".github/workflows/deploy.yml");

    expect(workflow).not.toContain("BUSINESS_GROUP_REPORT_SOURCE");
    expect(workflow).not.toContain("BUSINESS_GROUP_PROJECTION_ACCOUNT_ALLOWLIST");
    expect(workflow).not.toContain("DATABASE_URL_ADMIN");
    expect(workflow).not.toContain("buwiz-books-job-worker");
    expect(workflow).not.toContain("deploy-cloudrun");
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

  it("applies 0028-0036 as SQL on disposable test databases, matching CI", () => {
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    const apply = read("scripts/apply-enterprise-test-sql.ts");
    const workflow = read(".github/workflows/deploy.yml");
    const integrationJob = workflow.slice(workflow.indexOf("\n  integration-tests:"));

    expect(pkg.scripts["db:enterprise:test-sql"]).toContain("scripts/apply-enterprise-test-sql.ts");
    expect(pkg.scripts["db:test:fresh"]).toContain("db:enterprise:test-sql");
    expect(pkg.scripts["db:fresh"]).toContain("db:enterprise:test-sql");
    expect(apply).toContain("0028_enterprise_business_groups.sql");
    expect(apply).toContain("0034_business_group_admin_guards.sql");
    expect(apply).toContain("0035_enterprise_stripe_billing.sql");
    expect(apply).toContain("0036_enterprise_checkout.sql");
    expect(apply).toContain("Never run this against a real database");
    expect(integrationJob).toContain("Apply Enterprise migrations to test DB");
    expect(integrationJob.indexOf("Apply Enterprise migrations to test DB")).toBeLessThan(
      integrationJob.indexOf("db:tax:foundation"),
    );
  });
});
