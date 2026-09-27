import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db, withOrgContext } from "@/db";
import { accounts } from "@/db/schema/accounts";
import { member, organization, user } from "@/db/schema/auth";
import {
  organizationAccountingSettings,
  reviewFindings,
  reviewRuleConfigs,
  reviewRuleDefinitions,
} from "@/db/schema/inbox";
import { createTransactionCandidate } from "@/lib/inbox/service";

/**
 * The contract Settings -> Review Rules depends on: Inbox book findings read the organization's
 * `review_rule_configs` rows live — `enabled`, `impact`, and the thresholds in `config` — at the
 * moment a candidate is created. Moving the editor from the Review Agents page into Settings must
 * not change any of this, so it is pinned here against the real service.
 *
 * Rows are written in the shape `updateReviewAgent` upserts; the catalog comes from the seed in
 * tests/global-setup.ts.
 */

async function setupOrg(prefix: string) {
  const suffix = randomUUID();
  const orgId = `${prefix}-org-${suffix}`;
  const userId = `${prefix}-user-${suffix}`;
  await db.insert(user).values({
    id: userId,
    name: "Review Rule Settings Owner",
    email: `${prefix}-${suffix}@test.local`,
    emailVerified: true,
  });
  await db
    .insert(organization)
    .values({ id: orgId, name: "Review Rule Settings Org", slug: `${prefix}-${suffix}` });
  await db
    .insert(member)
    .values({ id: `${prefix}-member-${suffix}`, userId, organizationId: orgId, role: "owner" });
  const [bank, expense] = await db
    .insert(accounts)
    .values([
      {
        organizationId: orgId,
        accountNumber: "10000",
        name: "Operating Bank",
        accountType: "asset",
        subtype: "checking",
      },
      {
        organizationId: orgId,
        accountNumber: "61000",
        name: "Office Supplies",
        accountType: "expense",
        subtype: "office_supplies",
      },
    ])
    .returning();
  await db.insert(organizationAccountingSettings).values({
    organizationId: orgId,
    baseCurrency: "USD",
    requireDifferentApprover: false,
  });
  return { orgId, userId, bank, expense };
}

type Org = Awaited<ReturnType<typeof setupOrg>>;

async function configureRule(
  org: Org,
  key: string,
  values: { enabled?: boolean; impact?: "blocking" | "warning"; config?: Record<string, unknown> },
) {
  const [definition] = await db
    .select()
    .from(reviewRuleDefinitions)
    .where(eq(reviewRuleDefinitions.key, key));
  if (!definition) throw new Error(`${key} is missing from the seeded review-rule catalog.`);
  await db.insert(reviewRuleConfigs).values({
    organizationId: org.orgId,
    definitionId: definition.id,
    enabled: values.enabled ?? true,
    impact: values.impact ?? "blocking",
    lookbackMonths: 3,
    config: values.config ?? definition.defaultConfig,
    version: 1,
    updatedBy: org.userId,
  });
}

/** An 84.25 USD expense with no vendor and no receipt — trips missing_vendor and missing_receipt. */
async function submitExpense(org: Org) {
  const { candidate } = await withOrgContext(org.orgId, org.userId, "owner", (tx) =>
    createTransactionCandidate(
      { db: tx, orgId: org.orgId, userId: org.userId, role: "owner" },
      {
        transactionDate: "2026-07-24",
        transactionType: "pay_out",
        memo: "Printer paper",
        originalCurrency: "USD",
        lines: [
          { accountId: org.expense.id, debit: "84.25" },
          { accountId: org.bank.id, credit: "84.25" },
        ],
      },
    ),
  );
  const rows = await db
    .select({ ruleKey: reviewFindings.ruleKey, impact: reviewFindings.impact })
    .from(reviewFindings)
    .where(
      and(
        eq(reviewFindings.organizationId, org.orgId),
        eq(reviewFindings.candidateId, candidate.id),
      ),
    );
  return new Map(rows.map((row) => [row.ruleKey, row.impact]));
}

describe("inbox book findings read live per-organization rule configuration", () => {
  it("raises the catalog default when the organization has configured nothing", async () => {
    const org = await setupOrg("rrs-default");
    const findings = await submitExpense(org);
    expect(findings.get("missing_vendor")).toBe("blocking");
    expect(findings.get("missing_receipt")).toBe("blocking");
  });

  it("drops the finding of a rule that is turned off", async () => {
    const org = await setupOrg("rrs-off");
    await configureRule(org, "missing_vendor", { enabled: false });
    const findings = await submitExpense(org);
    expect(findings.has("missing_vendor")).toBe(false);
    // Only that rule: the others still run.
    expect(findings.get("missing_receipt")).toBe("blocking");
  });

  it("records a Warn rule's finding as a warning rather than a blocker", async () => {
    const org = await setupOrg("rrs-warn");
    await configureRule(org, "missing_vendor", { impact: "warning" });
    const findings = await submitExpense(org);
    expect(findings.get("missing_vendor")).toBe("warning");
  });

  it("uses the organization's receipt threshold instead of the accounting default", async () => {
    const above = await setupOrg("rrs-receipt-above");
    await configureRule(above, "missing_receipt", { config: { threshold: 100, currency: "USD" } });
    expect((await submitExpense(above)).has("missing_receipt")).toBe(false);

    const below = await setupOrg("rrs-receipt-below");
    await configureRule(below, "missing_receipt", { config: { threshold: 50, currency: "USD" } });
    expect((await submitExpense(below)).get("missing_receipt")).toBe("blocking");
  });

  it("never applies another organization's configuration", async () => {
    const quiet = await setupOrg("rrs-tenant-quiet");
    await configureRule(quiet, "missing_vendor", { enabled: false });
    const strict = await setupOrg("rrs-tenant-strict");

    expect((await submitExpense(quiet)).has("missing_vendor")).toBe(false);
    expect((await submitExpense(strict)).get("missing_vendor")).toBe("blocking");
  });
});
