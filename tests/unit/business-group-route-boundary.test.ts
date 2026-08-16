import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { migrationManifest } from "@/lib/migrations/manifest";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const read = (path: string) => readFileSync(resolve(REPO_ROOT, path), "utf8");

describe("Business Group request and operator boundaries", () => {
  it("keeps customer server functions on request-scoped context wrappers", () => {
    const route = read("src/routes/api/-business-groups.ts");

    expect(route).toContain("withSessionUserContext");
    expect(route).toContain("withMutationSessionUserContext");
    expect(route).not.toContain("dbAdmin");
    expect(route).not.toContain("withUserContext(");
    expect(route).not.toContain("withOrgContext(");
    expect(route).not.toContain("requireSession(");
  });

  it("keeps privileged entitlement writes in an explicit dry-run-first operator command", () => {
    const pkg = JSON.parse(read("package.json")) as {
      scripts: Record<string, string>;
    };
    const scriptPath = "scripts/business-group-entitlement.ts";
    const operator = read(scriptPath);

    expect(pkg.scripts["business-groups:entitlement"]).toContain(scriptPath);
    expect(operator).toContain("DATABASE_URL_ADMIN");
    expect(operator).toContain("--apply");
    expect(operator).toContain("expected-version");
    expect(operator).toContain("entitlement_events");
    expect(operator).toContain("current_database()");
    expect(operator).toContain("--allow-stripe-managed");
    expect(operator).toContain('previous.provisioning_source === "stripe"');
    expect(operator).toContain("entitlement.stripe_break_glass_reconciled");
    expect(operator).toContain("stripeManagedOverride");
    expect(operator).toContain('overrideSource = stripeManagedOverride ? "manual_cli" : null');
    expect(operator).toContain("provisioningSource: locked.provisioning_source");
    expect(operator).toContain("JSON.stringify(previousState)");
    expect(operator).toContain("JSON.stringify(auditedNextState)");

    const updateStart = operator.indexOf("async function update(");
    const updateBody = operator.slice(updateStart);
    const operatorLock = updateBody.indexOf("buwiz:enterprise-entitlement:");
    const allowanceLock = updateBody.indexOf("business-groups:${enterpriseAccountId}");
    const entitlementRowLock = updateBody.indexOf("SELECT * FROM account_entitlements");
    expect(updateStart).toBeGreaterThan(-1);
    expect(operatorLock).toBeGreaterThan(-1);
    expect(allowanceLock).toBeGreaterThan(operatorLock);
    expect(entitlementRowLock).toBeGreaterThan(allowanceLock);
  });

  it("persists comparison mode and sends it through the portfolio query boundary", () => {
    const page = read("src/routes/business-groups.tsx");

    expect(page).toContain('compare: search.compare === "none" ? "none" : "prior_period"');
    expect(page).toContain('aria-label="Compare performance"');
    expect(page).toContain('<option value="prior_period">Prior period</option>');
    expect(page).toContain('<option value="none">No comparison</option>');
    expect(page).toContain("compare: search.compare!");
    expect(page).toContain('data.compare === "prior_period"');
  });

  it("derives portfolio report organizations behind the authenticated server boundary", () => {
    const reports = read("src/routes/api/-reports.ts");
    const validation = read("src/db/validation/reports.ts");
    const financials = read("src/routes/financials.tsx");
    const schemaStart = validation.indexOf("export const portfolioProfitLossSchema");
    const schemaEnd = validation.indexOf("export type PortfolioProfitLossParams");
    const portfolioInput = validation.slice(schemaStart, schemaEnd);
    const handlerStart = reports.indexOf("export const getPortfolioProfitLoss");
    const handlerEnd = reports.indexOf("export const getCashFlow");
    const handler = reports.slice(handlerStart, handlerEnd);

    expect(schemaStart).toBeGreaterThan(-1);
    expect(portfolioInput).toContain("enterpriseAccountId");
    expect(portfolioInput).toContain("groupIds");
    expect(portfolioInput).toContain("z.iso.date()");
    expect(portfolioInput).not.toContain("organizationId");
    expect(handlerStart).toBeGreaterThan(-1);
    expect(handler).toContain("withSessionUserContext");
    expect(handler).toContain("getAccessibleGroupEntitiesForGroups");
    expect(handler).toContain("groups[0]?.enterpriseAccountId !== input.enterpriseAccountId");
    expect(handler.indexOf("computeLivePortfolioProfitLoss")).toBeGreaterThan(
      handler.indexOf("withSessionUserContext"),
    );
    expect(handler).toContain("PORTFOLIO_PNL_SHADOW_UNSUPPORTED_WARNING");
    expect(reports).not.toContain("dbAdmin");
    expect(financials).not.toContain("plQuery.error.message");
    expect(financials).not.toContain("plQuery.error instanceof Error");
    expect(financials).toContain("The selected portfolio is unavailable. Check your access");
  });

  it("keeps portfolio metrics and readiness on the same 25-row page boundary", () => {
    const route = read("src/routes/api/-business-groups.ts");
    const page = read("src/routes/business-groups.tsx");

    expect(route).toContain("pageSize: z.number().int().min(1).max(25).default(25)");
    expect(page).toContain("pageSize: 25");
  });

  it("keeps Business Group administration behind the checksum-fenced database guards", () => {
    const pkg = JSON.parse(read("package.json")) as {
      scripts: Record<string, string>;
    };
    const migration = read("drizzle/0034_business_group_admin_guards.sql");
    const rlsHardening = read("drizzle/rls_hardening.sql");
    const globalSetup = read("tests/global-setup.ts");
    const service = read("src/lib/business-groups/service.ts");
    const entitlements = read("src/lib/enterprise/entitlements.ts");
    const page = read("src/routes/business-groups.tsx");

    // There is no per-group runner to inspect any more: one ordered manifest owns which
    // migrations exist and in what phase, and `db:migrate` applies all of it. Assert the
    // manifest itself, which is the thing that would actually have to change for 0034 to
    // stop being installed.
    const guardMigration = migrationManifest.find(
      (item) => item.file === "0034_business_group_admin_guards.sql",
    );
    expect(guardMigration).toBeDefined();
    expect(guardMigration?.phase).toBe("post_schema");
    expect(pkg.scripts["db:migrate"]).toContain("scripts/migrate.ts apply");
    expect(pkg.scripts["db:test:fresh"]).toContain("db:migrate");
    expect(pkg.scripts["db:rls:hardening"]).toContain("drizzle/rls_hardening.sql");
    expect(pkg.scripts["db:test:fresh"]).toContain("db:rls:hardening");
    expect(migration).toContain("groups without an eligible owner");
    expect(migration).toContain("group memberships without matching Enterprise membership");
    expect(migration).toContain("ineligible group-owner memberships");
    expect(migration).toContain("archived groups with enabled entities");
    expect(migration).toContain("FOR UPDATE");
    expect(migration).toContain(
      "A Business Group creator must be an Enterprise owner or group_admin",
    );
    expect(migration).toContain("organization_groups_name_check");
    expect(migration).toContain("has_active_business_groups_entitlement");
    expect(migration).toContain("entitlement.status IN ('pending', 'active')");
    expect(migration).toContain("account_membership.role IN ('owner', 'group_admin')");
    expect(migration).toContain("can_manage_organization_group_owners");
    expect(migration).toContain("membership id, group_id, user_id, and created_at are immutable");
    expect(migration).toContain("enterprise_account_id and user_id are immutable");
    expect(migration).toContain("'business-group-members:'");
    expect(migration).toContain("organization_groups_lifecycle_guard");
    expect(migration).toContain("BEFORE INSERT OR UPDATE OR DELETE ON organization_group_entities");
    expect(migration).toContain("organization_group_entities_audit");
    expect(migration).toContain("Business Group assignments must be disabled instead of deleted");
    expect(migration).toContain("membership.role IN ('owner', 'admin')");
    expect(migration).toContain("'business-groups:' || NEW.enterprise_account_id::text");
    expect(migration).toContain("archived Business Group is read-only");
    expect(migration).toContain("reporting_timezone and default_reporting_currency are immutable");
    expect(migration).toContain("NEW.updated_at := OLD.updated_at");
    expect(migration).toContain("organization_group_members_audit");
    const auditInserts =
      migration.match(/INSERT INTO organization_group_audit_events \([\s\S]*?\n\s*\);/g) ?? [];
    expect(auditInserts).toHaveLength(7);
    expect(
      auditInserts.every(
        (statement) => statement.includes("created_at") && statement.includes("clock_timestamp()"),
      ),
    ).toBe(true);
    expect(migration).toContain("DEFERRABLE INITIALLY DEFERRED");
    expect(migration).toContain("enterprise_account_members_owned_groups_guard");
    expect(migration).toContain("organization_group_audit_events_group_insert");
    expect(migration).toContain("REVOKE ALL ON TABLE organization_group_audit_events");
    expect(migration).toContain("GRANT SELECT ON TABLE organization_group_audit_events");
    expect(migration).toContain("REVOKE ALL ON TABLE entitlement_events");
    expect(migration).toContain("GRANT SELECT ON TABLE entitlement_events");
    expect(migration).toContain(
      "REVOKE ALL ON TABLE business_group_projection_reconciliation_events",
    );
    expect(migration).toContain(
      "GRANT SELECT, INSERT ON TABLE business_group_projection_reconciliation_events",
    );
    expect(migration).toContain("membership id, group_id, user_id, and created_at are immutable");
    expect(migration).toContain("transfer_organization_group_ownership");
    expect(migration).toContain("business_group_owner_transfer_context");
    expect(migration).toContain("group.owner_transferred");
    expect(migration).toContain("ERRCODE = '40001'");
    expect(migration).not.toContain("SET search_path = public\n");
    expect(migration).toContain("SET search_path = pg_catalog, public, pg_temp");
    expect(migration).toContain("ALTER FUNCTION is_enterprise_account_member(uuid)");
    expect(migration).toContain(
      "ALTER FUNCTION is_organization_assigned_to_business_group(uuid, text, uuid, text)",
    );
    expect(migration).toContain("REVOKE CREATE ON SCHEMA public FROM PUBLIC");
    expect(rlsHardening).toContain("REVOKE ALL ON TABLE organization_group_audit_events");
    expect(rlsHardening).toContain("GRANT SELECT ON TABLE organization_group_audit_events");
    expect(rlsHardening).toContain("REVOKE ALL ON TABLE entitlement_events");
    expect(rlsHardening).toContain("GRANT SELECT ON TABLE entitlement_events");
    expect(rlsHardening).toContain(
      "REVOKE ALL ON TABLE business_group_projection_reconciliation_events",
    );
    expect(rlsHardening).toContain(
      "GRANT SELECT, INSERT ON TABLE business_group_projection_reconciliation_events",
    );
    expect(rlsHardening).toContain("REVOKE ALL ON TABLE business_group_owner_transfer_context");
    expect(rlsHardening).toContain("REVOKE ALL ON FUNCTION transfer_organization_group_ownership");
    expect(rlsHardening).toContain("REVOKE ALL ON FUNCTION lock_business_group_user_rows");
    expect(migration).toContain(
      "REVOKE ALL ON FUNCTION has_active_business_groups_entitlement(uuid)",
    );
    expect(rlsHardening).toContain(
      "REVOKE ALL ON FUNCTION has_active_business_groups_entitlement(uuid)",
    );
    for (const safeHelper of [
      "is_enterprise_organization_group_member(uuid, text)",
      "is_organization_assigned_to_business_group(uuid, text, uuid, text)",
      "is_eligible_organization_group_owner(uuid, text)",
      "can_manage_organization_group(uuid)",
      "can_manage_organization_group_owners(uuid)",
      "can_bootstrap_organization_group(uuid, text)",
    ]) {
      expect(rlsHardening).toContain(`GRANT EXECUTE ON FUNCTION ${safeHelper}`);
      expect(globalSetup).toContain(safeHelper);
    }
    expect(rlsHardening).toContain("REVOKE CREATE ON SCHEMA public FROM PUBLIC");
    expect(rlsHardening).toContain("REVOKE ALL ON SCHEMA public FROM app_runtime");
    expect(rlsHardening).toContain("REVOKE ALL ON ALL TABLES IN SCHEMA public FROM app_runtime");
    expect(rlsHardening).toContain("REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM app_runtime");
    expect(rlsHardening).toContain("REVOKE ALL ON TABLES FROM app_runtime");
    expect(rlsHardening).toContain("REVOKE ALL ON SEQUENCES FROM app_runtime");
    expect(rlsHardening.indexOf("BEGIN;")).toBeLessThan(
      rlsHardening.indexOf("GRANT EXECUTE ON ALL FUNCTIONS"),
    );
    expect(rlsHardening.indexOf("COMMIT;")).toBeGreaterThan(
      rlsHardening.indexOf("REVOKE ALL ON FUNCTION has_active_business_groups_entitlement"),
    );
    expect(service).not.toContain("pg_advisory_xact_lock");
    expect(service).not.toContain("lockGroupAssignments");
    expect(service).not.toContain("lockGroupMembers");
    expect(entitlements).toContain("lockEnterpriseAllowance");
    expect(page).toContain("canManageEnterpriseGroups");
    expect(page).toContain("canReduceAccess");
    expect(page).toContain("you can still remove existing links");
  });

  it("keeps cutover and row/account/group locks in their stable order", () => {
    const migration = read("drizzle/0034_business_group_admin_guards.sql");
    const functionNames = [
      "enforce_organization_group_creation_entitlement",
      "enforce_organization_group_lifecycle",
      "enforce_active_organization_group_entity",
      "enforce_organization_group_member_invariants",
    ];

    for (const functionName of functionNames) {
      const functionStart = migration.indexOf(`CREATE OR REPLACE FUNCTION ${functionName}()`);
      const functionEnd = migration.indexOf("$$;", functionStart);
      const functionBody = migration.slice(functionStart, functionEnd);
      const allowanceLock = functionBody.indexOf("hashtextextended('business-groups:'");
      const entitlementCheck = functionBody.indexOf("has_active_business_groups_entitlement");

      expect(functionStart, functionName).toBeGreaterThan(-1);
      expect(functionEnd, functionName).toBeGreaterThan(functionStart);
      expect(allowanceLock, functionName).toBeGreaterThan(-1);
      expect(entitlementCheck, functionName).toBeGreaterThan(allowanceLock);
    }

    const functionBody = (functionName: string) => {
      const start = migration.indexOf(`CREATE OR REPLACE FUNCTION ${functionName}()`);
      return migration.slice(start, migration.indexOf("$$;", start));
    };
    const creation = functionBody("enforce_organization_group_creation_entitlement");
    const lifecycle = functionBody("enforce_organization_group_lifecycle");
    const entity = functionBody("enforce_active_organization_group_entity");
    const member = functionBody("enforce_organization_group_member_invariants");
    const enterpriseMembership = functionBody("guard_enterprise_membership_owned_groups");
    const authUser = functionBody("guard_user_owned_business_groups");
    const allowanceIndex = (body: string) => body.indexOf("hashtextextended('business-groups:'");

    const creationUsers = creation.indexOf("lock_business_group_user_rows");
    const creationAccountParent = creation.indexOf("FROM enterprise_accounts account");
    const creationMembership = creation.indexOf("FROM enterprise_account_members");
    expect(creationUsers).toBeLessThan(creationAccountParent);
    expect(creationAccountParent).toBeLessThan(creationMembership);
    expect(creationMembership).toBeLessThan(allowanceIndex(creation));
    expect(allowanceIndex(lifecycle)).toBeLessThan(
      lifecycle.indexOf("hashtextextended('business-group-assignments:'"),
    );
    expect(lifecycle).toContain("pg_try_advisory_xact_lock");

    const entityInsertMarker = entity.indexOf("The new child does not own any row yet");
    const entityUpdateMarker = entity.indexOf("UPDATE already owns the child row");
    const entityUsers = entity.indexOf("lock_business_group_user_rows", entityInsertMarker);
    const entityOrganizationParent = entity.indexOf(
      "FROM auth_organizations target_organization",
      entityInsertMarker,
    );
    const entityOrganizationMembership = entity.indexOf(
      "FROM auth_members membership",
      entityInsertMarker,
    );
    const entityAccountParent = entity.indexOf(
      "FROM enterprise_accounts account",
      entityInsertMarker,
    );
    const entityGroupParent = entity.indexOf("PERFORM 1\n      FROM organization_groups groups");
    expect(entityUsers).toBeGreaterThan(entityInsertMarker);
    expect(entityUsers).toBeLessThan(entityOrganizationParent);
    expect(entityOrganizationParent).toBeLessThan(entityOrganizationMembership);
    expect(entityOrganizationMembership).toBeLessThan(entityAccountParent);
    expect(entityAccountParent).toBeLessThan(entityGroupParent);
    expect(entityGroupParent).toBeLessThan(allowanceIndex(entity));
    expect(entity.slice(entityUpdateMarker, allowanceIndex(entity))).not.toContain("FOR KEY SHARE");
    expect(entity.indexOf("FOR UPDATE OF membership NOWAIT")).toBeGreaterThan(
      allowanceIndex(entity),
    );
    expect(allowanceIndex(entity)).toBeLessThan(
      entity.indexOf("hashtextextended('business-group-assignments:'"),
    );

    const memberInsertMarker = member.indexOf("The new child has no row lock yet");
    const memberUpdateMarker = member.indexOf("UPDATE/DELETE already owns the membership child");
    const memberUsers = member.indexOf("lock_business_group_user_rows", memberInsertMarker);
    const memberAccountParent = member.indexOf(
      "FROM enterprise_accounts account",
      memberInsertMarker,
    );
    const memberGroupParent = member.indexOf("PERFORM 1\n    FROM organization_groups groups");
    const memberEnterpriseMembership = member.indexOf(
      "FROM enterprise_account_members account_membership",
    );
    expect(memberUsers).toBeGreaterThan(memberInsertMarker);
    expect(memberUsers).toBeLessThan(memberAccountParent);
    expect(memberAccountParent).toBeLessThan(memberGroupParent);
    expect(memberGroupParent).toBeLessThan(memberEnterpriseMembership);
    expect(memberEnterpriseMembership).toBeLessThan(allowanceIndex(member));
    expect(member.slice(memberUpdateMarker, allowanceIndex(member))).not.toContain("FOR KEY SHARE");
    expect(allowanceIndex(member)).toBeLessThan(
      member.indexOf("hashtextextended('business-group-members:'"),
    );
    expect(allowanceIndex(enterpriseMembership)).toBeLessThan(
      enterpriseMembership.indexOf("hashtextextended('business-group-members:'"),
    );
    expect(allowanceIndex(authUser)).toBeLessThan(
      authUser.indexOf("hashtextextended('business-group-members:'"),
    );

    const firstPreflight = migration.indexOf("DO $preflight$");
    const cutoverTables = [
      "account_entitlements",
      "auth_users",
      "enterprise_accounts",
      "enterprise_account_members",
      "organization_groups",
      "organization_group_members",
      "organization_group_entities",
    ];
    let priorLock = -1;
    for (const table of cutoverTables) {
      const tableLock = migration.indexOf(`LOCK TABLE ${table} IN SHARE ROW EXCLUSIVE MODE`);
      expect(tableLock, table).toBeGreaterThan(priorLock);
      expect(tableLock, table).toBeLessThan(firstPreflight);
      priorLock = tableLock;
    }
  });

  it("keeps Enterprise Stripe billing on a signed, admin-only webhook boundary", () => {
    const route = read("server/routes/api/enterprise/stripe-webhook.post.ts");
    const processor = read("src/lib/enterprise/stripe-entitlements.ts");

    expect(route).toContain("constructEventAsync");
    expect(route).toContain("readRawBody");
    expect(route).toContain("STRIPE_ENTERPRISE_WEBHOOK_SECRET");
    expect(route).toContain("DATABASE_URL_ADMIN");
    expect(processor).toContain("enterpriseBillingWebhookEvents");
    expect(processor).toContain("onConflictDoNothing");
    expect(processor).toContain("stale_event");
    expect(processor).toContain("buwiz:enterprise-entitlement:");
    expect(processor).toContain("storedEventId >= incomingEventId");
    const providerLockStart = processor.indexOf(
      "async function lockEnterpriseStripeProviderIdentifiers",
    );
    const providerLockEnd = processor.indexOf(
      "export async function applyEnterpriseStripeSubscription",
      providerLockStart,
    );
    const providerLock = processor.slice(providerLockStart, providerLockEnd);
    expect(providerLockStart).toBeGreaterThan(-1);
    expect(providerLock).toContain("buwiz:enterprise-stripe:customer:");
    expect(providerLock).toContain("buwiz:enterprise-stripe:subscription:");
    expect(providerLock).toContain("].sort()");
    expect(providerLock).toContain("pg_advisory_xact_lock");
    const applyStart = processor.indexOf("export async function applyEnterpriseStripeSubscription");
    const applyEnd = processor.indexOf("function invoiceSubscriptionId", applyStart);
    const apply = processor.slice(applyStart, applyEnd);
    const entitlementAdvisory = apply.indexOf("buwiz:enterprise-entitlement:");
    const deliveryInsert = apply.indexOf(".insert(enterpriseBillingWebhookEvents)");
    const deliveryRowLock = apply.indexOf('.for("update")', deliveryInsert);
    const accountRow = apply.indexOf(".from(enterpriseAccounts)", deliveryRowLock);
    const accountRowLock = apply.indexOf('.for("no key update")', accountRow);
    const allowanceAdvisory = apply.indexOf("lockEnterpriseAllowance", accountRowLock);
    const checkoutReservationRow = apply.indexOf(
      ".from(enterpriseBillingCheckoutSessions)",
      allowanceAdvisory,
    );
    const providerIdentifierAdvisory = apply.indexOf(
      "lockEnterpriseStripeProviderIdentifiers",
      checkoutReservationRow,
    );
    const subscriptionRow = apply.indexOf(
      ".from(enterpriseBillingSubscriptions)",
      providerIdentifierAdvisory,
    );
    const entitlementRow = apply.indexOf(".from(accountEntitlements)", subscriptionRow);
    const accountCustomerWrite = apply.indexOf(".update(enterpriseAccounts)", entitlementRow);
    const subscriptionWrite = apply.indexOf(
      ".insert(enterpriseBillingSubscriptions)",
      entitlementRow,
    );
    expect(entitlementAdvisory).toBeGreaterThan(-1);
    expect(deliveryInsert).toBeGreaterThan(entitlementAdvisory);
    expect(deliveryRowLock).toBeGreaterThan(deliveryInsert);
    expect(accountRow).toBeGreaterThan(deliveryRowLock);
    expect(accountRowLock).toBeGreaterThan(accountRow);
    expect(allowanceAdvisory).toBeGreaterThan(accountRowLock);
    expect(checkoutReservationRow).toBeGreaterThan(allowanceAdvisory);
    expect(providerIdentifierAdvisory).toBeGreaterThan(checkoutReservationRow);
    expect(subscriptionRow).toBeGreaterThan(providerIdentifierAdvisory);
    expect(entitlementRow).toBeGreaterThan(subscriptionRow);
    expect(accountCustomerWrite).toBeGreaterThan(entitlementRow);
    expect(subscriptionWrite).toBeGreaterThan(entitlementRow);

    const checkoutApply = processor.slice(
      processor.indexOf("async function processEnterpriseCheckoutEvent"),
      processor.indexOf("export async function applyEnterpriseStripeSubscription"),
    );
    const checkoutEntitlementAdvisory = checkoutApply.indexOf("buwiz:enterprise-entitlement:");
    const checkoutDelivery = checkoutApply.indexOf(".insert(enterpriseBillingWebhookEvents)");
    const checkoutAccount = checkoutApply.indexOf(".from(enterpriseAccounts)");
    const checkoutAllowance = checkoutApply.indexOf("lockEnterpriseAllowance", checkoutAccount);
    const checkoutReservation = checkoutApply.indexOf(
      ".from(enterpriseBillingCheckoutSessions)",
      checkoutAllowance,
    );
    expect(checkoutEntitlementAdvisory).toBeGreaterThan(-1);
    expect(checkoutDelivery).toBeGreaterThan(checkoutEntitlementAdvisory);
    expect(checkoutAccount).toBeGreaterThan(checkoutDelivery);
    expect(checkoutAllowance).toBeGreaterThan(checkoutAccount);
    expect(checkoutReservation).toBeGreaterThan(checkoutAllowance);
    expect(route).toContain('result.status === "ignored" && result.failureCode');
    expect(route).toContain("Enterprise Stripe event quarantined");
    expect(route).toContain("failureCode: result.failureCode");
    expect(route).not.toContain('result.status === "failed"');
    expect(route).not.toContain("STRIPE_WEBHOOK_SECRET");
  });

  it("derives Enterprise Checkout and portal scope on the server", () => {
    const route = read("src/routes/api/-enterprise-billing.ts");
    const billing = read("src/lib/enterprise/billing.ts");

    expect(route).toContain("withMutationSessionUserContext");
    expect(route).toContain("STRIPE_ENTERPRISE_SECRET_KEY");
    expect(billing).toContain("ENTERPRISE_BILLING_ROLES");
    expect(billing).toContain("requireBillingActor");
    expect(billing).toContain("subscription_data: { metadata: enterpriseMetadata }");
    expect(billing).toContain("enterprise-billing-checkout:");
    expect(billing).toContain("idempotencyKey: `enterprise-checkout:${reservation.id}`");
    expect(billing).toContain("STRIPE_ENTERPRISE_PORTAL_CONFIGURATION_ID");
    expect(billing).toContain("configuration,");
    expect(read(".env.example")).toContain("STRIPE_ENTERPRISE_PORTAL_CONFIGURATION_ID=");
    expect(route).not.toContain("successUrl");
    expect(route).not.toContain("cancelUrl");
  });

  it("pins checkout actor rows in delete-compatible lock order", () => {
    const billing = read("src/lib/enterprise/billing.ts");
    const actorBoundary = billing.slice(
      billing.indexOf("async function requireBillingActor"),
      billing.indexOf("interface CheckoutReservation"),
    );
    const reservationBoundary = billing.slice(
      billing.indexOf("export async function reserveEnterpriseCheckout"),
      billing.indexOf("export function enterpriseBillingBaseUrl"),
    );

    expect(actorBoundary.indexOf(".from(user)")).toBeLessThan(
      actorBoundary.indexOf(".from(enterpriseAccounts)"),
    );
    expect(actorBoundary.indexOf(".from(enterpriseAccounts)")).toBeLessThan(
      actorBoundary.indexOf(".from(enterpriseAccountMembers)"),
    );
    expect(actorBoundary.match(/\.for\("update"\)/g)).toHaveLength(3);
    expect(reservationBoundary.indexOf("enterprise-billing-checkout:")).toBeLessThan(
      reservationBoundary.indexOf("requireBillingActor(tx"),
    );
    expect(reservationBoundary.indexOf("requireBillingActor(tx")).toBeLessThan(
      reservationBoundary.indexOf("lockEnterpriseAllowance(tx"),
    );

    const reconcileBoundary = billing.slice(
      billing.indexOf("async function reconcileRetrievedCheckoutSession"),
      billing.indexOf("async function reconcileKnownCheckoutSession"),
    );
    expect(reconcileBoundary.indexOf("enterprise-billing-checkout:")).toBeLessThan(
      reconcileBoundary.indexOf("requireBillingActor(tx"),
    );
    expect(reconcileBoundary.indexOf("requireBillingActor(tx")).toBeLessThan(
      reconcileBoundary.indexOf("lockEnterpriseAllowance(tx"),
    );
    expect(reconcileBoundary.indexOf("lockEnterpriseAllowance(tx")).toBeLessThan(
      reconcileBoundary.indexOf(".from(enterpriseBillingCheckoutSessions)"),
    );

    const portalBoundary = billing.slice(
      billing.indexOf("export async function createEnterprisePortalSession"),
    );
    expect(portalBoundary.indexOf("requireBillingActor(tx")).toBeLessThan(
      portalBoundary.indexOf(".from(enterpriseBillingSubscriptions)"),
    );
    expect(portalBoundary).toContain("BILLING_PORTAL_UNAVAILABLE");
  });
});
