import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { withUserContext } from "../../src/db";
import { accounts } from "../../src/db/schema/accounts";
import { member, organization, user } from "../../src/db/schema/auth";
import {
  accountEntitlements,
  enterpriseAccountMembers,
  enterpriseAccounts,
} from "../../src/db/schema/business-groups";
import { journalHeaders, journalLines } from "../../src/db/schema/journals";
import { computeLivePortfolioProfitLoss } from "../../src/lib/business-groups/portfolio-profit-loss";
import {
  addOrganizationToGroup,
  createBusinessGroup,
  getAccessibleGroupEntitiesForGroups,
} from "../../src/lib/business-groups/service";
import { createTestDb } from "../utils/db-utils";

const describeDb = process.env.TEST_DATABASE_URL ? describe : describe.skip;

describeDb("portfolio Profit & Loss integration", () => {
  let db: Awaited<ReturnType<typeof createTestDb>>["db"];
  let sqlClient: Awaited<ReturnType<typeof createTestDb>>["sql"];
  let userId: string;
  let organizationA: string;
  let organizationB: string;
  let enterpriseAccountId: string;
  let groupId: string;

  beforeAll(async () => {
    ({ db, sql: sqlClient } = await createTestDb());
  });

  afterAll(async () => {
    await sqlClient.end();
  });

  beforeEach(async () => {
    const suffix = crypto.randomUUID();
    userId = `portfolio-pnl-owner-${suffix}`;
    organizationA = `portfolio-pnl-a-${suffix}`;
    organizationB = `portfolio-pnl-b-${suffix}`;

    await db.insert(user).values({
      id: userId,
      name: "Portfolio Owner",
      email: `portfolio-pnl-${suffix}@test.local`,
      emailVerified: true,
    });
    await db.insert(organization).values([
      {
        id: organizationA,
        name: "Northwind Services",
        slug: `portfolio-pnl-a-${suffix}`,
        metadata: JSON.stringify({ currency: "USD" }),
      },
      {
        id: organizationB,
        name: "Contoso Services",
        slug: `portfolio-pnl-b-${suffix}`,
        metadata: JSON.stringify({ currency: "USD" }),
      },
    ]);
    await db.insert(member).values([
      {
        id: `portfolio-pnl-member-a-${suffix}`,
        userId,
        organizationId: organizationA,
        role: "owner",
      },
      {
        id: `portfolio-pnl-member-b-${suffix}`,
        userId,
        organizationId: organizationB,
        role: "admin",
      },
    ]);

    const [enterpriseAccount] = await db
      .insert(enterpriseAccounts)
      .values({ name: "Portfolio Holdings", createdBy: userId })
      .returning({ id: enterpriseAccounts.id });
    enterpriseAccountId = enterpriseAccount.id;
    await db.insert(enterpriseAccountMembers).values({
      enterpriseAccountId,
      userId,
      role: "owner",
    });
    await db.insert(accountEntitlements).values({
      enterpriseAccountId,
      featureKey: "business_groups",
      status: "active",
      includedEntityLimit: 10,
      startsAt: new Date("2026-01-01T00:00:00.000Z"),
      endsAt: new Date("2030-01-01T00:00:00.000Z"),
    });

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
    await db.transaction(async (tx) => {
      await addOrganizationToGroup(tx, { groupId, organizationId: organizationA, userId });
      await addOrganizationToGroup(tx, { groupId, organizationId: organizationB, userId });
    });

    const chart = await db
      .insert(accounts)
      .values(
        [organizationA, organizationB].flatMap((organizationId) => [
          {
            organizationId,
            accountNumber: "1000",
            name: "Operating Cash",
            accountType: "asset" as const,
            subtype: "bank_accounts",
          },
          {
            organizationId,
            accountNumber: "4000",
            name: "Service Revenue",
            accountType: "revenue" as const,
            subtype: "sales",
          },
          {
            organizationId,
            accountNumber: "6000",
            name: "Operating Expense",
            accountType: "expense" as const,
            subtype: "general_admin",
          },
        ]),
      )
      .returning({
        id: accounts.id,
        organizationId: accounts.organizationId,
        accountType: accounts.accountType,
      });
    const accountId = (organizationId: string, accountType: string) =>
      chart.find(
        (account) =>
          account.organizationId === organizationId && account.accountType === accountType,
      )!.id;

    const { headerA, headerB } = await db.transaction(async (tx: any) => {
      const headers = await tx
        .insert(journalHeaders)
        .values([
          {
            organizationId: organizationA,
            transactionDate: "2026-07-15",
            transactionType: "journal",
            source: "manual",
            status: "posted",
            functionalCurrency: "USD",
          },
          {
            organizationId: organizationB,
            transactionDate: "2026-07-15",
            transactionType: "journal",
            source: "manual",
            status: "posted",
            functionalCurrency: "USD",
          },
        ])
        .returning({ id: journalHeaders.id, organizationId: journalHeaders.organizationId });
      const headerA = headers.find((header: any) => header.organizationId === organizationA)!.id;
      const headerB = headers.find((header: any) => header.organizationId === organizationB)!.id;
      await tx.insert(journalLines).values([
        {
          journalHeaderId: headerA,
          accountId: accountId(organizationA, "asset"),
          debit: "1000",
          credit: "0",
        },
        {
          journalHeaderId: headerA,
          accountId: accountId(organizationA, "revenue"),
          debit: "0",
          credit: "1000",
        },
        {
          journalHeaderId: headerB,
          accountId: accountId(organizationB, "asset"),
          debit: "1700",
          credit: "0",
        },
        {
          journalHeaderId: headerB,
          accountId: accountId(organizationB, "expense"),
          debit: "300",
          credit: "0",
        },
        {
          journalHeaderId: headerB,
          accountId: accountId(organizationB, "revenue"),
          debit: "0",
          credit: "2000",
        },
      ]);
      return { headerA, headerB };
    });
  });

  afterEach(async () => {
    await db.delete(enterpriseAccounts).where(eq(enterpriseAccounts.id, enterpriseAccountId));
    await db.delete(journalHeaders).where(eq(journalHeaders.organizationId, organizationA));
    await db.delete(journalHeaders).where(eq(journalHeaders.organizationId, organizationB));
    await db.delete(accounts).where(eq(accounts.organizationId, organizationA));
    await db.delete(accounts).where(eq(accounts.organizationId, organizationB));
    await db.delete(organization).where(eq(organization.id, organizationA));
    await db.delete(organization).where(eq(organization.id, organizationB));
    await db.delete(user).where(eq(user.id, userId));
  });

  async function authorizedGroups() {
    return withUserContext(userId, (tx) =>
      getAccessibleGroupEntitiesForGroups(tx, [groupId], userId),
    );
  }

  it("aggregates two authorized ledgers and withholds the report after a currency mismatch", async () => {
    const report = await computeLivePortfolioProfitLoss(await authorizedGroups(), {
      userId,
      dateFrom: "2026-07-01",
      dateTo: "2026-07-31",
      compare: "none",
    });

    expect(report.metadata).toMatchObject({
      enterpriseAccountId,
      uniqueEntityCount: 2,
      omittedEntityCount: 0,
      currency: "USD",
      sourceMode: "live_ledger",
    });
    expect(report.report).toMatchObject({
      grossProfit: 3000,
      operatingIncome: 2700,
      netIncome: 2700,
    });
    expect(report.report?.revenue).toMatchObject({ total: 3000 });
    expect(report.report?.expenses).toMatchObject({ total: 300 });

    await db
      .update(organization)
      .set({ metadata: JSON.stringify({ currency: "PHP" }) })
      .where(eq(organization.id, organizationB));
    const mixedCurrency = await computeLivePortfolioProfitLoss(await authorizedGroups(), {
      userId,
      dateFrom: "2026-07-01",
      dateTo: "2026-07-31",
      compare: "none",
    });

    expect(mixedCurrency.report).toBeNull();
    expect(mixedCurrency.metadata.currency).toBeNull();
    expect(mixedCurrency.metadata.warnings).toEqual([
      expect.stringContaining("different functional currencies"),
    ]);
  });
});
