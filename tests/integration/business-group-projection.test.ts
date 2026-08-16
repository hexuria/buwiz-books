import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { withOrgContext, withUserContext } from "../../src/db";
import { accounts } from "../../src/db/schema/accounts";
import { member, organization, user } from "../../src/db/schema/auth";
import {
  accountEntitlements,
  enterpriseAccountMembers,
  enterpriseAccounts,
} from "../../src/db/schema/business-groups";
import { processingJobs } from "../../src/db/schema/inbox";
import { journalHeaders, journalLines } from "../../src/db/schema/journals";
import {
  businessGroupProjectionReconciliationEvents,
  organizationDailyAccountActivity,
  organizationReportingProjectionState,
} from "../../src/db/schema/reporting-projections";
import { computeProjectedBusinessGroupsPerformance } from "../../src/lib/business-groups/projected-performance";
import { computeBusinessGroupsPerformance } from "../../src/lib/business-groups/performance";
import {
  computeLivePortfolioProfitLoss,
  computeProjectedPortfolioProfitLoss,
} from "../../src/lib/business-groups/portfolio-profit-loss";
import {
  addOrganizationToGroup,
  createBusinessGroup,
  getAccessibleGroupEntitiesForGroups,
} from "../../src/lib/business-groups/service";
import { runJobWorker } from "../../src/lib/jobs/registry";
import {
  findProjectionMismatches,
  recordProjectionMismatches,
} from "../../src/lib/business-groups/projection-reconciliation";
import {
  BUSINESS_GROUP_PROJECTION_JOB_TYPE,
  getReportingProjectionStates,
  requestReportingProjection,
} from "../../src/lib/reporting/projection";
import { createTestDb } from "../utils/db-utils";

const describeDb =
  process.env.TEST_DATABASE_URL || process.env.DATABASE_URL ? describe : describe.skip;

describeDb("Business Group reporting projection", () => {
  let db: Awaited<ReturnType<typeof createTestDb>>["db"];
  let sqlClient: Awaited<ReturnType<typeof createTestDb>>["sql"];
  let userId: string;
  let outsiderUserId: string;
  let organizationId: string;
  let enterpriseAccountId: string;
  let groupId: string;
  let priorHeaderId: string;
  let currentHeaderId: string;

  beforeAll(async () => {
    ({ db, sql: sqlClient } = await createTestDb());
  });

  afterAll(async () => {
    await sqlClient.end();
  });

  beforeEach(async () => {
    const suffix = crypto.randomUUID();
    userId = `projection-owner-${suffix}`;
    outsiderUserId = `projection-outsider-${suffix}`;
    organizationId = `projection-org-${suffix}`;
    await db.insert(user).values([
      {
        id: userId,
        name: "Projection Owner",
        email: `projection-owner-${suffix}@test.local`,
        emailVerified: true,
      },
      {
        id: outsiderUserId,
        name: "Projection Outsider",
        email: `projection-outsider-${suffix}@test.local`,
        emailVerified: true,
      },
    ]);
    await db.insert(organization).values({
      id: organizationId,
      name: "Juniper Industrial Services",
      slug: `juniper-${suffix}`,
      metadata: JSON.stringify({ currency: "USD" }),
    });
    await db.insert(member).values({
      id: `projection-member-${suffix}`,
      userId,
      organizationId,
      role: "owner",
    });

    const [enterprise] = await db
      .insert(enterpriseAccounts)
      .values({ name: "Juniper Holdings", createdBy: userId })
      .returning({ id: enterpriseAccounts.id });
    enterpriseAccountId = enterprise.id;
    await db.insert(enterpriseAccountMembers).values({
      enterpriseAccountId,
      userId,
      role: "owner",
    });
    await db.insert(accountEntitlements).values({
      enterpriseAccountId,
      featureKey: "business_groups",
      status: "active",
      includedEntityLimit: 20,
      startsAt: new Date("2026-01-01T00:00:00.000Z"),
      endsAt: new Date("2030-01-01T00:00:00.000Z"),
    });

    const chart = await db
      .insert(accounts)
      .values([
        {
          organizationId,
          accountNumber: "10100",
          name: "Operating Cash",
          accountType: "asset",
          subtype: "bank_accounts",
        },
        {
          organizationId,
          accountNumber: "40100",
          name: "Service Revenue",
          accountType: "revenue",
          subtype: "sales",
        },
        {
          organizationId,
          accountNumber: "60100",
          name: "Operating Expense",
          accountType: "expense",
          subtype: "general_admin",
        },
      ])
      .returning({ id: accounts.id, accountType: accounts.accountType });
    const cashId = chart.find((row) => row.accountType === "asset")!.id;
    const revenueId = chart.find((row) => row.accountType === "revenue")!.id;
    const expenseId = chart.find((row) => row.accountType === "expense")!.id;

    const group = await db.transaction((tx) =>
      createBusinessGroup(tx, {
        enterpriseAccountId,
        userId,
        name: "Operating Companies",
        reportingTimezone: "UTC",
        defaultReportingCurrency: "USD",
      }),
    );
    groupId = group.id;
    await db.transaction((tx) => addOrganizationToGroup(tx, { groupId, organizationId, userId }));

    const headers = await db
      .insert(journalHeaders)
      .values([
        {
          organizationId,
          transactionDate: "2026-05-15",
          transactionType: "pay_in",
          source: "manual",
          status: "posted",
          functionalCurrency: "USD",
        },
        {
          organizationId,
          transactionDate: "2026-06-15",
          transactionType: "pay_in",
          source: "manual",
          status: "posted",
          functionalCurrency: "USD",
        },
      ])
      .returning({ id: journalHeaders.id, transactionDate: journalHeaders.transactionDate });
    priorHeaderId = headers.find((header) => header.transactionDate === "2026-05-15")!.id;
    currentHeaderId = headers.find((header) => header.transactionDate === "2026-06-15")!.id;
    await db.insert(journalLines).values([
      { journalHeaderId: priorHeaderId, accountId: cashId, debit: "1000", credit: "0" },
      { journalHeaderId: priorHeaderId, accountId: revenueId, debit: "0", credit: "1000" },
      { journalHeaderId: currentHeaderId, accountId: cashId, debit: "1500", credit: "300" },
      { journalHeaderId: currentHeaderId, accountId: revenueId, debit: "0", credit: "1500" },
      { journalHeaderId: currentHeaderId, accountId: expenseId, debit: "300", credit: "0" },
    ]);
  });

  afterEach(async () => {
    await db.delete(enterpriseAccounts).where(eq(enterpriseAccounts.id, enterpriseAccountId));
    await db.delete(journalHeaders).where(eq(journalHeaders.organizationId, organizationId));
    await db.delete(accounts).where(eq(accounts.organizationId, organizationId));
    await db.delete(organization).where(eq(organization.id, organizationId));
    await db.delete(user).where(eq(user.id, userId));
    await db.delete(user).where(eq(user.id, outsiderUserId));
  });

  async function drainProjection() {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const result = await runJobWorker({
        jobTypes: [BUSINESS_GROUP_PROJECTION_JOB_TYPE],
        maxJobs: 5,
      });
      const [active] = await db
        .select({ id: processingJobs.id })
        .from(processingJobs)
        .where(
          and(
            eq(processingJobs.organizationId, organizationId),
            eq(processingJobs.jobType, BUSINESS_GROUP_PROJECTION_JOB_TYPE),
            sql`${processingJobs.status} in ('queued', 'running')`,
          ),
        )
        .limit(1);
      if (!active) return result;
    }
    throw new Error("Projection worker did not drain within ten passes");
  }

  async function projectedReport() {
    return withUserContext(userId, async (tx) => {
      const groups = await getAccessibleGroupEntitiesForGroups(tx, [groupId], userId);
      return computeProjectedBusinessGroupsPerformance(tx, groups, {
        dateFrom: "2026-06-01",
        dateTo: "2026-06-30",
        compare: "prior_period",
      });
    });
  }

  async function liveReport() {
    const groups = await withUserContext(userId, (tx) =>
      getAccessibleGroupEntitiesForGroups(tx, [groupId], userId),
    );
    return computeBusinessGroupsPerformance(groups, {
      userId,
      dateFrom: "2026-06-01",
      dateTo: "2026-06-30",
      compare: "prior_period",
    });
  }

  async function projectedPortfolioProfitLoss() {
    return withUserContext(userId, async (tx) => {
      const groups = await getAccessibleGroupEntitiesForGroups(tx, [groupId], userId);
      return computeProjectedPortfolioProfitLoss(tx, groups, {
        dateFrom: "2026-06-01",
        dateTo: "2026-06-30",
        compare: "prior_period",
      });
    });
  }

  async function livePortfolioProfitLoss() {
    const groups = await withUserContext(userId, (tx) =>
      getAccessibleGroupEntitiesForGroups(tx, [groupId], userId),
    );
    return computeLivePortfolioProfitLoss(groups, {
      userId,
      dateFrom: "2026-06-01",
      dateTo: "2026-06-30",
      compare: "prior_period",
    });
  }

  it("backfills full history and produces current, prior, and cash metrics", async () => {
    const [queuedBeforeDrain] = await db
      .select({ count: sql<number>`count(*)::integer` })
      .from(processingJobs)
      .where(
        and(
          eq(processingJobs.organizationId, organizationId),
          eq(processingJobs.jobType, BUSINESS_GROUP_PROJECTION_JOB_TYPE),
          sql`${processingJobs.status} in ('queued', 'running')`,
        ),
      );
    expect(queuedBeforeDrain.count).toBe(1);

    const preparing = await projectedReport();
    expect(preparing.entities).toEqual([]);
    expect(preparing.aggregate).toBeNull();
    expect(preparing.entityReadiness).toHaveLength(1);
    expect(preparing.entityReadiness[0]).toMatchObject({
      organizationId,
      name: "Juniper Industrial Services",
      groupIds: [groupId],
      groupNames: ["Operating Companies"],
    });
    expect(preparing.entityReadiness[0].status).not.toBe("ready");
    expect(preparing.entityReadinessSummary).toMatchObject({
      total: 1,
      page: 1,
      pageSize: 25,
      returnedCount: 1,
    });

    await drainProjection();

    const [state] = await db
      .select()
      .from(organizationReportingProjectionState)
      .where(eq(organizationReportingProjectionState.organizationId, organizationId));
    expect(state).toMatchObject({ status: "ready", fullRebuildRequested: false });
    expect(state.initialBackfillCompletedAt).not.toBeNull();

    const report = await projectedReport();
    expect(report.projectionStatus).toBe("ready");
    expect(report.sourceMode).toBe("projected");
    expect(report.entityReadiness).toHaveLength(1);
    expect(report.entityReadiness[0]).toMatchObject({
      organizationId,
      name: "Juniper Industrial Services",
      groupIds: [groupId],
      groupNames: ["Operating Companies"],
      status: "ready",
      projectionAsOf: report.projectionAsOf,
      syncActivityAt: state.updatedAt.toISOString(),
      ledgerLagSeconds: 0,
    });
    expect(report.entityReadiness[0].syncAgeSeconds).toBeNull();
    expect(report.entities[0]).toMatchObject({
      revenue: "1500.00",
      priorRevenue: "1000.00",
      operatingExpenses: "300.00",
      netIncome: "1200.00",
      cash: "2200.00",
    });
  });

  it("matches the live ledger exactly with decimal-string money values", async () => {
    await drainProjection();
    const [live, projected, states] = await Promise.all([
      liveReport(),
      projectedReport(),
      withUserContext(userId, (tx) => getReportingProjectionStates(tx, [organizationId])),
    ]);

    expect(live.entityReadiness).toEqual([]);
    expect(live.entityReadinessSummary).toBeNull();

    expect(projected.entities[0]).toMatchObject({
      revenue: live.entities[0].revenue,
      priorRevenue: live.entities[0].priorRevenue,
      grossProfit: live.entities[0].grossProfit,
      operatingExpenses: live.entities[0].operatingExpenses,
      netIncome: live.entities[0].netIncome,
      cash: live.entities[0].cash,
    });
    expect(typeof projected.entities[0].netIncome).toBe("string");
    expect(
      findProjectionMismatches(live, projected, {
        tolerance: 0.01,
        projectionVersions: states,
      }),
    ).toEqual([]);
  });

  it("withholds an incomplete portfolio P&L and matches live totals after projection", async () => {
    const incomplete = await projectedPortfolioProfitLoss();
    expect(incomplete.report).toBeNull();
    expect(incomplete.metadata).toMatchObject({
      enterpriseAccountId,
      projectionStatus: "building",
      incompleteEntityCount: 1,
      currency: "USD",
      uniqueEntityCount: 1,
      omittedEntityCount: 0,
    });
    expect(JSON.stringify(incomplete.metadata)).not.toContain(outsiderUserId);

    await drainProjection();
    const [live, projected] = await Promise.all([
      livePortfolioProfitLoss(),
      projectedPortfolioProfitLoss(),
    ]);

    expect(projected.metadata).toMatchObject({
      sourceMode: "projected",
      projectionStatus: "ready",
      incompleteEntityCount: 0,
      currency: "USD",
    });
    expect(projected.report).not.toBeNull();
    expect(projected.report).toMatchObject({
      grossProfit: live.report?.grossProfit,
      operatingIncome: live.report?.operatingIncome,
      netIncome: live.report?.netIncome,
      priorNetIncome: live.report?.priorNetIncome,
    });
    expect(projected.report?.revenue.total).toBe(1500);
    expect(projected.report?.expenses.total).toBe(300);
    expect(projected.report?.priorNetIncome).toBe(1000);
  });

  it("expedites an existing queued projection when a user requests refresh", async () => {
    const delayedUntil = new Date(Date.now() + 60 * 60 * 1000);
    await db
      .update(processingJobs)
      .set({ runAt: delayedUntil })
      .where(
        and(
          eq(processingJobs.organizationId, organizationId),
          eq(processingJobs.jobType, BUSINESS_GROUP_PROJECTION_JOB_TYPE),
        ),
      );

    const requestedAt = new Date();
    const request = await withOrgContext(organizationId, userId, "owner", (tx) =>
      requestReportingProjection(tx, { organizationId }),
    );
    const [queued] = await db
      .select({ id: processingJobs.id, runAt: processingJobs.runAt })
      .from(processingJobs)
      .where(
        and(
          eq(processingJobs.organizationId, organizationId),
          eq(processingJobs.jobType, BUSINESS_GROUP_PROJECTION_JOB_TYPE),
          eq(processingJobs.status, "queued"),
        ),
      );

    expect(request.jobId).toBe(queued.id);
    expect(queued.runAt.getTime()).toBeGreaterThanOrEqual(requestedAt.getTime() - 1000);
    expect(queued.runAt.getTime()).toBeLessThan(delayedUntil.getTime());
  });

  it("ages a manual refresh from the request instead of idle ledger activity", async () => {
    await drainProjection();
    const idleAt = new Date("2026-01-01T00:00:00.000Z");
    await db
      .update(organizationReportingProjectionState)
      .set({ lastLedgerEventAt: idleAt, lastProjectedAt: idleAt, updatedAt: idleAt })
      .where(eq(organizationReportingProjectionState.organizationId, organizationId));

    await withOrgContext(organizationId, userId, "owner", (tx) =>
      requestReportingProjection(tx, { organizationId }),
    );
    const report = await projectedReport();

    expect(report.projectionStatus).toBe("building");
    expect(report.entityReadiness[0]).toMatchObject({
      status: "pending",
      ledgerLagSeconds: 0,
    });
    expect(report.entityReadiness[0].syncAgeSeconds).toBeLessThan(10);
  });

  it("rebuilds the exact date after a journal is voided", async () => {
    await drainProjection();
    await db
      .update(journalHeaders)
      .set({ status: "voided", voidedAt: new Date(), updatedAt: new Date() })
      .where(eq(journalHeaders.id, currentHeaderId));

    const [dirtyState] = await db
      .select()
      .from(organizationReportingProjectionState)
      .where(eq(organizationReportingProjectionState.organizationId, organizationId));
    expect(dirtyState.status).toBe("pending");

    await drainProjection();
    const report = await projectedReport();
    expect(report.entities[0]).toMatchObject({
      revenue: "0.00",
      operatingExpenses: "0.00",
      cash: "1000.00",
    });
  });

  it("removes and restores duplicate-suppressed activity", async () => {
    await drainProjection();
    await db
      .update(journalHeaders)
      .set({ duplicateOfHeaderId: priorHeaderId, updatedAt: new Date() })
      .where(eq(journalHeaders.id, currentHeaderId));
    await drainProjection();
    expect((await projectedReport()).entities[0]).toMatchObject({
      revenue: "0.00",
      cash: "1000.00",
    });

    await db
      .update(journalHeaders)
      .set({ duplicateOfHeaderId: null, updatedAt: new Date() })
      .where(eq(journalHeaders.id, currentHeaderId));
    await drainProjection();
    expect((await projectedReport()).entities[0]).toMatchObject({
      revenue: "1500.00",
      cash: "2200.00",
    });
  });

  it("replays idempotently when an operator requests a full rebuild", async () => {
    await drainProjection();
    const before = await db
      .select({
        activityDate: organizationDailyAccountActivity.activityDate,
        accountId: organizationDailyAccountActivity.accountId,
        totalDebit: organizationDailyAccountActivity.totalDebit,
        totalCredit: organizationDailyAccountActivity.totalCredit,
      })
      .from(organizationDailyAccountActivity)
      .where(eq(organizationDailyAccountActivity.organizationId, organizationId))
      .orderBy(
        organizationDailyAccountActivity.activityDate,
        organizationDailyAccountActivity.accountId,
      );

    await withOrgContext(organizationId, userId, "owner", (tx) =>
      requestReportingProjection(tx, { organizationId, fullRebuild: true }),
    );
    await drainProjection();

    const after = await db
      .select({
        activityDate: organizationDailyAccountActivity.activityDate,
        accountId: organizationDailyAccountActivity.accountId,
        totalDebit: organizationDailyAccountActivity.totalDebit,
        totalCredit: organizationDailyAccountActivity.totalCredit,
      })
      .from(organizationDailyAccountActivity)
      .where(eq(organizationDailyAccountActivity.organizationId, organizationId))
      .orderBy(
        organizationDailyAccountActivity.activityDate,
        organizationDailyAccountActivity.accountId,
      );
    expect(after).toEqual(before);
  });

  it("persists shadow mismatches for direct members without exposing them to outsiders", async () => {
    await drainProjection();
    const [state] = await db
      .select()
      .from(organizationReportingProjectionState)
      .where(eq(organizationReportingProjectionState.organizationId, organizationId));
    const mismatch = {
      organizationId,
      metric: "revenue" as const,
      liveValue: "1500.00",
      projectedValue: "1490.00",
      absoluteDifference: "10.00",
      tolerance: 0.01,
      projectionVersion: state.appliedVersion,
    };

    const recorded = await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE buwiz_app`);
      await tx.execute(sql`SELECT set_config('app.current_user_id', ${userId}, true)`);
      return recordProjectionMismatches(tx, [mismatch], {
        dateFrom: "2026-06-01",
        dateTo: "2026-06-30",
        compare: "prior_period",
        selectedGroupIds: [groupId],
        projectionAsOf: state.lastProjectedAt?.toISOString() ?? null,
      });
    });
    expect(recorded).toBe(true);

    const ownerRows = await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE buwiz_app`);
      await tx.execute(sql`SELECT set_config('app.current_user_id', ${userId}, true)`);
      return tx
        .select()
        .from(businessGroupProjectionReconciliationEvents)
        .where(eq(businessGroupProjectionReconciliationEvents.organizationId, organizationId));
    });
    expect(ownerRows).toHaveLength(1);
    expect(ownerRows[0]).toMatchObject({
      metric: "revenue",
      projectionVersion: state.appliedVersion,
    });

    const outsiderRows = await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE buwiz_app`);
      await tx.execute(sql`SELECT set_config('app.current_user_id', ${outsiderUserId}, true)`);
      return tx
        .select()
        .from(businessGroupProjectionReconciliationEvents)
        .where(eq(businessGroupProjectionReconciliationEvents.organizationId, organizationId));
    });
    expect(outsiderRows).toEqual([]);
  });

  it("does not expose projection facts to a user without direct organization membership", async () => {
    await drainProjection();
    const rows = await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE buwiz_app`);
      await tx.execute(sql`SELECT set_config('app.current_user_id', ${outsiderUserId}, true)`);
      return tx
        .select()
        .from(organizationDailyAccountActivity)
        .where(eq(organizationDailyAccountActivity.organizationId, organizationId));
    });
    expect(rows).toEqual([]);
  });
});
