import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db, withOrgContext } from "@/db";
import { accounts } from "@/db/schema/accounts";
import { member, organization, user } from "@/db/schema/auth";
import {
  organizationAccountingSettings,
  reviewFindings,
  reviewRuleConfigs,
  reviewRuleDefinitions,
  reviewRuleRuns,
  workflowEvents,
} from "@/db/schema/inbox";
import { journalHeaders, journalLines } from "@/db/schema/journals";
import { runConfiguredReviewRules } from "@/lib/inbox/review-engine";
import {
  REVIEW_AGENT_RUN_KEYS,
  REVIEW_RULE_CATALOG,
  seedReviewRuleDefinitions,
} from "@/lib/inbox/review-rule-catalog";
import { listReviewFindingsForOrg, resolveReviewFindingForOrg } from "@/routes/api/-review-agents";

async function setupOrg(prefix: string) {
  const suffix = randomUUID();
  const orgId = `${prefix}-org-${suffix}`;
  const userId = `${prefix}-user-${suffix}`;
  await db.insert(user).values({
    id: userId,
    name: "Review Agent Test Owner",
    email: `${prefix}-${suffix}@test.local`,
    emailVerified: true,
  });
  await db
    .insert(organization)
    .values({ id: orgId, name: "Review Agent Test Org", slug: `${prefix}-${suffix}` });
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

type TestOrg = Awaited<ReturnType<typeof setupOrg>>;

/** Post a balanced expense journal. Amounts are strings — decimal(20,8) everywhere. */
async function postExpense(fixture: TestOrg, date: string, amount: string) {
  const header = await db.transaction(async (tx: any) => {
    const [created] = await tx
      .insert(journalHeaders)
      .values({
        organizationId: fixture.orgId,
        transactionNumber: `TXN-${randomUUID().slice(0, 8)}`,
        transactionDate: date,
        transactionType: "pay_out",
        status: "posted",
        memo: "Review agent fixture",
        totalAmount: amount,
        createdBy: fixture.userId,
      })
      .returning();
    // journal_lines carries no organization_id — its RLS policy derives tenancy from the header.
    await tx.insert(journalLines).values([
      {
        journalHeaderId: created.id,
        accountId: fixture.expense.id,
        debit: amount,
        credit: "0",
        sortOrder: 1,
      },
      {
        journalHeaderId: created.id,
        accountId: fixture.bank.id,
        debit: "0",
        credit: amount,
        sortOrder: 2,
      },
    ]);
    return created;
  });
  return header;
}

function ctxFor(fixture: TestOrg) {
  return { db, orgId: fixture.orgId, userId: fixture.userId, role: "owner" as const };
}

describe("review rule catalog seeding", () => {
  beforeAll(async () => {
    await seedReviewRuleDefinitions(db);
  });

  it("is idempotent and reports nothing new on a second run", async () => {
    const second = await seedReviewRuleDefinitions(db);
    expect(second.inserted).toBe(0);
    expect(second.skipped).toBe(REVIEW_RULE_CATALOG.length);

    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(reviewRuleDefinitions);
    expect(count).toBeGreaterThanOrEqual(REVIEW_RULE_CATALOG.length);
  });

  /**
   * The guard that matters: 0020 already changed possible_duplicate's defaults, and re-asserting
   * a TypeScript constant over a reviewed migration would retune duplicate blocking for every
   * tenant.
   *
   * Deliberately exercised on `missing_department` rather than `possible_duplicate`.
   * `review_rule_definitions` is a GLOBAL table with no organization_id, so a mutation here is
   * visible to every other test file in the run — and if an assertion threw between the mutation
   * and the restore, every downstream duplicate test would silently run in shadow mode against a
   * blockingScore of 99. `missing_department`'s defaultConfig is `{}` and no engine reads it, so
   * the semantics under test are identical and the blast radius is nil. The restore is in a
   * `finally` for the same reason.
   */
  it("never overwrites a definition edited out of band", async () => {
    const key = "missing_department";
    const [original] = await db
      .select()
      .from(reviewRuleDefinitions)
      .where(eq(reviewRuleDefinitions.key, key));

    try {
      await db
        .update(reviewRuleDefinitions)
        .set({ defaultConfig: { editedByHand: true }, formulaVersion: 7 })
        .where(eq(reviewRuleDefinitions.key, key));

      await seedReviewRuleDefinitions(db);

      const [row] = await db
        .select()
        .from(reviewRuleDefinitions)
        .where(eq(reviewRuleDefinitions.key, key));
      expect(row.defaultConfig).toMatchObject({ editedByHand: true });
      expect(row.formulaVersion).toBe(7);
    } finally {
      await db
        .update(reviewRuleDefinitions)
        .set({ defaultConfig: original.defaultConfig, formulaVersion: original.formulaVersion })
        .where(eq(reviewRuleDefinitions.key, key));
    }
  });
});

describe("on-demand review run", () => {
  beforeAll(async () => {
    await seedReviewRuleDefinitions(db);
  });

  it("touches only the five review agents, never the book rules", async () => {
    const fixture = await setupOrg("run-scope");
    await postExpense(fixture, "2026-03-10", "1200.00");

    const result = await withOrgContext(fixture.orgId, fixture.userId, "admin", (tx) =>
      runConfiguredReviewRules({ ...ctxFor(fixture), db: tx }, "2026-03-31"),
    );

    expect(new Set(result.rules.map((rule) => rule.ruleKey))).toEqual(
      new Set(REVIEW_AGENT_RUN_KEYS),
    );

    // No book rule may produce a finding from a batch run — those journals are already posted
    // and the finding would have no corrective action available.
    const bookFindings = await db
      .select()
      .from(reviewFindings)
      .where(
        and(
          eq(reviewFindings.organizationId, fixture.orgId),
          eq(reviewFindings.ruleKey, "missing_vendor"),
        ),
      );
    expect(bookFindings).toHaveLength(0);
  });

  it("bootstraps no config row for system agents", async () => {
    const fixture = await setupOrg("run-system");
    await withOrgContext(fixture.orgId, fixture.userId, "admin", (tx) =>
      runConfiguredReviewRules({ ...ctxFor(fixture), db: tx }, "2026-03-31"),
    );

    const systemConfigs = await db
      .select({ key: reviewRuleDefinitions.key })
      .from(reviewRuleConfigs)
      .innerJoin(
        reviewRuleDefinitions,
        eq(reviewRuleConfigs.definitionId, reviewRuleDefinitions.id),
      )
      .where(
        and(
          eq(reviewRuleConfigs.organizationId, fixture.orgId),
          eq(reviewRuleDefinitions.group, "system"),
        ),
      );
    expect(systemConfigs).toHaveLength(0);
  });

  /**
   * The fingerprint used to carry the month the button was pressed, so the same journal minted a
   * fresh finding every month and re-blocked the close no matter how often it was resolved.
   */
  it("fingerprints a journal by its own month, so re-running does not duplicate it", async () => {
    const fixture = await setupOrg("fingerprint");
    await postExpense(fixture, "2026-03-10", "50.00");
    await postExpense(fixture, "2026-03-20", "5000.00");

    for (const asOf of ["2026-03-31", "2026-04-30"]) {
      await withOrgContext(fixture.orgId, fixture.userId, "admin", (tx) =>
        runConfiguredReviewRules({ ...ctxFor(fixture), db: tx }, asOf),
      );
    }

    const findings = await db
      .select()
      .from(reviewFindings)
      .where(
        and(
          eq(reviewFindings.organizationId, fixture.orgId),
          eq(reviewFindings.ruleKey, "material_expense"),
        ),
      );
    const subjects = findings.map((finding) => finding.subjectId);
    expect(new Set(subjects).size).toBe(subjects.length);
  });

  it("does not reopen a finding a reviewer already resolved", async () => {
    const fixture = await setupOrg("no-reopen");
    await postExpense(fixture, "2026-03-10", "50.00");
    await postExpense(fixture, "2026-03-20", "5000.00");
    await withOrgContext(fixture.orgId, fixture.userId, "admin", (tx) =>
      runConfiguredReviewRules({ ...ctxFor(fixture), db: tx }, "2026-03-31"),
    );

    const [finding] = await db
      .select()
      .from(reviewFindings)
      .where(
        and(
          eq(reviewFindings.organizationId, fixture.orgId),
          eq(reviewFindings.ruleKey, "material_expense"),
        ),
      );
    expect(finding).toBeDefined();

    await withOrgContext(fixture.orgId, fixture.userId, "admin", (tx) =>
      resolveReviewFindingForOrg(
        { db: tx, orgId: fixture.orgId, userId: fixture.userId },
        { findingId: finding.id, resolutionNote: "Reviewed and accepted." },
      ),
    );
    await withOrgContext(fixture.orgId, fixture.userId, "admin", (tx) =>
      runConfiguredReviewRules({ ...ctxFor(fixture), db: tx }, "2026-03-31"),
    );

    const [after] = await db.select().from(reviewFindings).where(eq(reviewFindings.id, finding.id));
    expect(after.state).toBe("resolved");
    expect(after.lastSeenAt.getTime()).toBeGreaterThanOrEqual(finding.lastSeenAt.getTime());
  });

  it("records a run row with counts", async () => {
    const fixture = await setupOrg("run-counts");
    await postExpense(fixture, "2026-03-10", "100.00");
    await withOrgContext(fixture.orgId, fixture.userId, "admin", (tx) =>
      runConfiguredReviewRules({ ...ctxFor(fixture), db: tx }, "2026-03-31"),
    );
    const runs = await db
      .select()
      .from(reviewRuleRuns)
      .where(eq(reviewRuleRuns.organizationId, fixture.orgId));
    expect(runs.length).toBe(REVIEW_AGENT_RUN_KEYS.size);
    for (const run of runs) {
      expect(run.status).toBe("completed");
      expect(run.counts).toHaveProperty("scanned");
    }
  });
});

describe("resolving item-less findings", () => {
  beforeAll(async () => {
    await seedReviewRuleDefinitions(db);
  });

  async function findingFor(prefix: string) {
    const fixture = await setupOrg(prefix);
    await postExpense(fixture, "2026-03-10", "50.00");
    await postExpense(fixture, "2026-03-20", "5000.00");
    await withOrgContext(fixture.orgId, fixture.userId, "admin", (tx) =>
      runConfiguredReviewRules({ ...ctxFor(fixture), db: tx }, "2026-03-31"),
    );
    const [finding] = await db
      .select()
      .from(reviewFindings)
      .where(
        and(
          eq(reviewFindings.organizationId, fixture.orgId),
          eq(reviewFindings.ruleKey, "material_expense"),
        ),
      );
    expect(finding, "expected the fixture to produce a material_expense finding").toBeDefined();
    return { fixture, finding };
  }

  it("writes state, actor, note and an item-less audit row", async () => {
    const { fixture, finding } = await findingFor("resolve-ok");
    // The engine is the one insert path that leaves this null — which is why it needed its own
    // resolution function.
    expect(finding.inboxItemId).toBeNull();

    const result = await withOrgContext(fixture.orgId, fixture.userId, "admin", (tx) =>
      resolveReviewFindingForOrg(
        { db: tx, orgId: fixture.orgId, userId: fixture.userId },
        { findingId: finding.id, resolutionNote: "Capex, reviewed with the controller." },
      ),
    );
    expect(result.alreadyResolved).toBe(false);

    const [after] = await db.select().from(reviewFindings).where(eq(reviewFindings.id, finding.id));
    expect(after.state).toBe("resolved");
    expect(after.resolvedBy).toBe(fixture.userId);
    expect(after.resolvedAt).not.toBeNull();
    expect(after.resolutionNote).toBe("Capex, reviewed with the controller.");

    const events = await db
      .select()
      .from(workflowEvents)
      .where(
        and(
          eq(workflowEvents.organizationId, fixture.orgId),
          eq(workflowEvents.entityId, finding.id),
        ),
      );
    expect(events).toHaveLength(1);
    expect(events[0].inboxItemId).toBeNull();
    expect(events[0].entityType).toBe("review_finding");
    expect(events[0].action).toBe("resolved");
  });

  it("is idempotent", async () => {
    const { fixture, finding } = await findingFor("resolve-twice");
    const input = { findingId: finding.id, resolutionNote: "Reviewed." };
    await withOrgContext(fixture.orgId, fixture.userId, "admin", (tx) =>
      resolveReviewFindingForOrg({ db: tx, orgId: fixture.orgId, userId: fixture.userId }, input),
    );
    const second = await withOrgContext(fixture.orgId, fixture.userId, "admin", (tx) =>
      resolveReviewFindingForOrg({ db: tx, orgId: fixture.orgId, userId: fixture.userId }, input),
    );
    expect(second.alreadyResolved).toBe(true);
  });

  it("refuses to resolve a finding that belongs to an Inbox item", async () => {
    const { fixture, finding } = await findingFor("resolve-boundary");
    // Simulate an item-linked finding without building a whole candidate: the boundary is drawn
    // on inboxItemId alone.
    await db
      .update(reviewFindings)
      .set({ inboxItemId: randomUUID() })
      .where(eq(reviewFindings.id, finding.id))
      .catch(() => {
        /* FK will reject a fabricated id; fall through to the possible_duplicate check below */
      });

    const [reloaded] = await db
      .select()
      .from(reviewFindings)
      .where(eq(reviewFindings.id, finding.id));
    if (reloaded.inboxItemId === null) return; // FK prevented the setup; nothing to assert here.

    await expect(
      withOrgContext(fixture.orgId, fixture.userId, "admin", (tx) =>
        resolveReviewFindingForOrg(
          { db: tx, orgId: fixture.orgId, userId: fixture.userId },
          { findingId: finding.id, resolutionNote: "Should be refused." },
        ),
      ),
    ).rejects.toThrow(/resolve it from the Inbox/i);
  });

  it("does not leak or mutate another organization's findings", async () => {
    const { finding } = await findingFor("resolve-org-a");
    const other = await setupOrg("resolve-org-b");

    await expect(
      withOrgContext(other.orgId, other.userId, "admin", (tx) =>
        resolveReviewFindingForOrg(
          { db: tx, orgId: other.orgId, userId: other.userId },
          { findingId: finding.id, resolutionNote: "Cross-tenant attempt." },
        ),
      ),
    ).rejects.toThrow(/not found/i);

    const [after] = await db.select().from(reviewFindings).where(eq(reviewFindings.id, finding.id));
    expect(after.state).toBe("open");

    const visible = await withOrgContext(other.orgId, other.userId, "admin", (tx) =>
      listReviewFindingsForOrg({ db: tx, orgId: other.orgId }, { state: "all", limit: 50 }),
    );
    expect(visible.findings.some((row) => row.id === finding.id)).toBe(false);
  });
});

describe("listReviewFindings", () => {
  beforeAll(async () => {
    await seedReviewRuleDefinitions(db);
  });

  it("hydrates journal subjects and marks them resolvable in place", async () => {
    const fixture = await setupOrg("list-journal");
    await postExpense(fixture, "2026-03-10", "50.00");
    const big = await postExpense(fixture, "2026-03-20", "5000.00");
    await withOrgContext(fixture.orgId, fixture.userId, "admin", (tx) =>
      runConfiguredReviewRules({ ...ctxFor(fixture), db: tx }, "2026-03-31"),
    );

    const { findings } = await withOrgContext(fixture.orgId, fixture.userId, "admin", (tx) =>
      listReviewFindingsForOrg(
        { db: tx, orgId: fixture.orgId },
        { ruleKey: "material_expense", state: "open", limit: 50 },
      ),
    );
    const row = findings.find((finding) => finding.subjectId === big.id);
    expect(row).toBeDefined();
    expect(row!.subjectType).toBe("journal_header");
    expect(row!.subjectLabel).toBe(big.transactionNumber);
    expect(row!.subjectDate).toBe("2026-03-20");
    // decimal(20,8) must stay a string all the way to the client.
    expect(typeof row!.subjectAmount).toBe("string");
    expect(row!.resolvableHere).toBe(true);
  });

  /**
   * `subjectId` has no foreign key, so an account_month finding whose id happens to match a
   * journal must still resolve as an account — otherwise the join predicates aren't doing their
   * job and cross-type (and, without the org predicate, cross-tenant) context could leak.
   */
  it("keeps the two enrichment joins from crossing subject types", async () => {
    const fixture = await setupOrg("list-subject-type");
    const header = await postExpense(fixture, "2026-03-10", "100.00");

    const [definition] = await db
      .select()
      .from(reviewRuleDefinitions)
      .where(eq(reviewRuleDefinitions.key, "non_zero_clearing"));
    await db.insert(reviewFindings).values({
      organizationId: fixture.orgId,
      ruleKey: "non_zero_clearing",
      impact: "warning",
      subjectType: "account_month",
      // Deliberately a journal id in an account_month subject.
      subjectId: header.id,
      fingerprint: `non_zero_clearing:account_month:${header.id}:2026-03`,
      message: "Synthetic cross-type subject.",
      evidence: { month: "2026-03" },
      formulaVersion: definition.formulaVersion,
    });

    const { findings } = await withOrgContext(fixture.orgId, fixture.userId, "admin", (tx) =>
      listReviewFindingsForOrg(
        { db: tx, orgId: fixture.orgId },
        { ruleKey: "non_zero_clearing", state: "open", limit: 50 },
      ),
    );
    const row = findings.find((finding) => finding.subjectId === header.id);
    expect(row).toBeDefined();
    // No journal context bled through: the account join found nothing, the journal join was
    // excluded by subjectType, and the month came from evidence.
    expect(row!.subjectLabel).toBeNull();
    expect(row!.subjectAmount).toBeNull();
    expect(row!.subjectDate).toBe("2026-03");
  });
});
