import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
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
 * Settings -> Review Rules saves only through `updateReviewAgent`, and Inbox book findings read
 * what it saved, live and per organization. Both halves are pinned here against the real code:
 * the server function's input validator, its `agentRule:configure` check, the per-rule bounds and
 * the optimistic version check, then `createTransactionCandidate`'s read of the saved row.
 *
 * Only two things are stood in for, both below the code under test: TanStack Start's request
 * plumbing (reduced to what the server does with a POST — validate, then run the handler), and
 * better-auth's cookie lookup (reduced to "this user, this active organization"). The caller's
 * role is still read live from auth_members, exactly as in production.
 */

/** Whose request the server function is handling. */
const caller = vi.hoisted(() => ({ userId: "", orgId: "" }));

vi.mock("@tanstack/react-start", () => {
  type Validator = (input: unknown) => unknown;
  type Handler = (opts: { data: unknown }) => unknown;
  const builder = (validate?: Validator) => ({
    inputValidator: (next: Validator) => builder(next),
    handler: (fn: Handler) => async (opts?: { data?: unknown }) =>
      fn({ data: validate ? validate(opts?.data) : opts?.data }),
  });
  return { createServerFn: () => builder() };
});

// The request the wrappers read headers from and the mutation guard inspects.
vi.mock("@tanstack/react-start/server", () => ({
  getRequest: () =>
    new Request("http://localhost:3001/_serverFn/review-agents", { method: "POST" }),
}));

vi.mock("@/lib/auth", () => ({
  auth: {
    api: {
      getSession: vi.fn(async () => ({
        user: { id: caller.userId },
        session: { activeOrganizationId: caller.orgId },
      })),
      setActiveOrganization: vi.fn(),
    },
  },
}));

// Imported after the mocks so the module is built with them.
const { updateReviewAgent } = await import("@/routes/api/-review-agents");

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

/** Another member of `org`, holding `role`. */
async function addMember(org: Org, role: string) {
  const suffix = randomUUID();
  const userId = `rrs-${role}-${suffix}`;
  await db.insert(user).values({
    id: userId,
    name: `Review Rule ${role}`,
    email: `rrs-${role}-${suffix}@test.local`,
    emailVerified: true,
  });
  await db
    .insert(member)
    .values({ id: `rrs-member-${suffix}`, userId, organizationId: org.orgId, role });
  return userId;
}

async function definitionFor(key: string) {
  const [definition] = await db
    .select()
    .from(reviewRuleDefinitions)
    .where(eq(reviewRuleDefinitions.key, key));
  if (!definition) throw new Error(`${key} is missing from the seeded review-rule catalog.`);
  return definition;
}

type RuleValues = {
  enabled?: boolean;
  impact?: string;
  lookbackMonths?: number;
  config?: Record<string, string | number | boolean | null>;
};

/** Save `key` for `org` through `updateReviewAgent`, as the org owner unless `as` says otherwise. */
async function saveRule(
  org: Org,
  key: string,
  values: RuleValues = {},
  options: { expectedVersion?: number; as?: string } = {},
) {
  const definition = await definitionFor(key);
  caller.orgId = org.orgId;
  caller.userId = options.as ?? org.userId;
  return updateReviewAgent({
    data: {
      definitionId: definition.id,
      enabled: values.enabled ?? true,
      impact: values.impact ?? "blocking",
      lookbackMonths: values.lookbackMonths ?? 3,
      config:
        values.config ??
        (definition.defaultConfig as Record<string, string | number | boolean | null>),
      expectedVersion: options.expectedVersion ?? 0,
    },
  });
}

async function storedConfigs(org: Org) {
  return db
    .select({
      key: reviewRuleDefinitions.key,
      enabled: reviewRuleConfigs.enabled,
      impact: reviewRuleConfigs.impact,
      config: reviewRuleConfigs.config,
      version: reviewRuleConfigs.version,
      updatedBy: reviewRuleConfigs.updatedBy,
    })
    .from(reviewRuleConfigs)
    .innerJoin(reviewRuleDefinitions, eq(reviewRuleConfigs.definitionId, reviewRuleDefinitions.id))
    .where(eq(reviewRuleConfigs.organizationId, org.orgId));
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

describe("updateReviewAgent — who may save", () => {
  it("refuses every role without agentRule:configure, and writes nothing", async () => {
    const org = await setupOrg("rrs-denied");
    for (const role of ["member", "client_approver", "report_viewer"]) {
      const userId = await addMember(org, role);
      await expect(
        saveRule(org, "missing_vendor", { enabled: false }, { as: userId }),
      ).rejects.toThrow("Permission denied: configure on agentRule");
    }
    expect(await storedConfigs(org)).toEqual([]);
    // Nothing was switched off, so the Inbox still flags the missing vendor.
    expect((await submitExpense(org)).get("missing_vendor")).toBe("blocking");
  });

  it("lets an owner and an admin save, and records who did", async () => {
    const org = await setupOrg("rrs-allowed");
    const adminId = await addMember(org, "admin");

    const first = await saveRule(org, "missing_vendor", { enabled: false });
    expect(first).toMatchObject({ enabled: false, version: 1 });
    const second = await saveRule(
      org,
      "missing_vendor",
      { enabled: true, impact: "warning" },
      { as: adminId, expectedVersion: 1 },
    );
    expect(second).toMatchObject({ enabled: true, impact: "warning", version: 2 });

    expect(await storedConfigs(org)).toEqual([
      expect.objectContaining({ key: "missing_vendor", version: 2, updatedBy: adminId }),
    ]);
  });
});

describe("updateReviewAgent — what it accepts", () => {
  it("rejects a stale expectedVersion instead of overwriting the newer save", async () => {
    const org = await setupOrg("rrs-stale");
    await saveRule(org, "missing_vendor", { impact: "warning" });

    // A second editor who loaded the rule before that save still holds version 0.
    await expect(saveRule(org, "missing_vendor", { enabled: false })).rejects.toThrow(
      "This agent instruction changed after you opened it. Refresh and retry.",
    );
    // A version that was never issued is refused too, even with no row yet.
    await expect(saveRule(org, "missing_receipt", {}, { expectedVersion: 4 })).rejects.toThrow(
      "This agent instruction changed after you opened it. Refresh and retry.",
    );

    expect(await storedConfigs(org)).toEqual([
      expect.objectContaining({
        key: "missing_vendor",
        enabled: true,
        impact: "warning",
        version: 1,
      }),
    ]);
  });

  it("rejects out-of-bounds values and writes nothing", async () => {
    const org = await setupOrg("rrs-bounds");

    // The input validator: lookback window and impact.
    await expect(saveRule(org, "unusual_spend", { lookbackMonths: 0 })).rejects.toThrow(
      /lookbackMonths/,
    );
    await expect(saveRule(org, "unusual_spend", { lookbackMonths: 25 })).rejects.toThrow(
      /lookbackMonths/,
    );
    await expect(saveRule(org, "missing_vendor", { impact: "fatal" })).rejects.toThrow(/impact/);

    // The per-rule bounds on the values the engine reads.
    await expect(
      saveRule(org, "unusual_spend", { config: { standardDeviations: 0 } }),
    ).rejects.toThrow();
    await expect(
      saveRule(org, "material_expense", { config: { annualizedExpensePercent: 0 } }),
    ).rejects.toThrow();
    await expect(
      saveRule(org, "low_confidence_category", { config: { threshold: 1.5 } }),
    ).rejects.toThrow();
    await expect(
      saveRule(org, "missing_receipt", { config: { threshold: 75, currency: "US" } }),
    ).rejects.toThrow();
    await expect(
      saveRule(org, "possible_duplicate", {
        config: { mode: "enforce", blockingScore: 70, shadowScore: 70 },
      }),
    ).rejects.toThrow("Shadow score must be lower than the blocking score.");

    // System rules are raised with a hardcoded impact and read no config.
    await expect(saveRule(org, "source_processing_failed")).rejects.toThrow(
      "System agents are not configurable.",
    );

    expect(await storedConfigs(org)).toEqual([]);

    // The same rules save once the values are in bounds, so the refusals above were the bounds.
    await saveRule(org, "unusual_spend", { lookbackMonths: 24, config: { standardDeviations: 2 } });
    await saveRule(org, "material_expense", { config: { annualizedExpensePercent: 0.5 } });
    await saveRule(org, "low_confidence_category", { config: { threshold: 0.9 } });
    expect((await storedConfigs(org)).map((row) => row.key).sort()).toEqual([
      "low_confidence_category",
      "material_expense",
      "unusual_spend",
    ]);
  });
});

describe("inbox book findings follow what updateReviewAgent saved", () => {
  it("raises the catalog default when the organization has saved nothing", async () => {
    const org = await setupOrg("rrs-default");
    const findings = await submitExpense(org);
    expect(findings.get("missing_vendor")).toBe("blocking");
    expect(findings.get("missing_receipt")).toBe("blocking");
  });

  it("drops the finding of a rule that is turned off", async () => {
    const org = await setupOrg("rrs-off");
    await saveRule(org, "missing_vendor", { enabled: false });
    const findings = await submitExpense(org);
    expect(findings.has("missing_vendor")).toBe(false);
    // Only that rule: the others still run.
    expect(findings.get("missing_receipt")).toBe("blocking");
  });

  it("records a Warn rule's finding as a warning, and a blocker once switched back", async () => {
    const org = await setupOrg("rrs-warn");
    await saveRule(org, "missing_vendor", { impact: "warning" });
    expect((await submitExpense(org)).get("missing_vendor")).toBe("warning");

    await saveRule(org, "missing_vendor", { impact: "blocking" }, { expectedVersion: 1 });
    expect((await submitExpense(org)).get("missing_vendor")).toBe("blocking");
  });

  it("uses the organization's receipt threshold instead of the accounting default", async () => {
    const above = await setupOrg("rrs-receipt-above");
    await saveRule(above, "missing_receipt", { config: { threshold: 100, currency: "USD" } });
    expect((await submitExpense(above)).has("missing_receipt")).toBe(false);

    const below = await setupOrg("rrs-receipt-below");
    await saveRule(below, "missing_receipt", { config: { threshold: 50, currency: "USD" } });
    expect((await submitExpense(below)).get("missing_receipt")).toBe("blocking");
  });

  it("never applies another organization's configuration", async () => {
    const quiet = await setupOrg("rrs-tenant-quiet");
    await saveRule(quiet, "missing_vendor", { enabled: false });
    const strict = await setupOrg("rrs-tenant-strict");

    expect((await submitExpense(quiet)).has("missing_vendor")).toBe(false);
    expect((await submitExpense(strict)).get("missing_vendor")).toBe("blocking");
  });
});
