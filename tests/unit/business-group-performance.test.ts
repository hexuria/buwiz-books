import { describe, expect, it } from "vitest";
import {
  aggregateMetrics,
  buildEntityPerformanceMetric,
  dedupeGroupAccess,
  type EntityPerformanceMetric,
} from "../../src/lib/business-groups/performance-model";

const sharedBusiness = {
  id: "entity-a",
  organizationId: "organization-a",
  name: "Northwind Manufacturing",
  role: "owner",
  currency: "USD",
};

describe("multi-group performance", () => {
  it("keeps base totals but withholds comparison fields without historical activity", () => {
    const metric = buildEntityPerformanceMetric({
      entityId: "entity-a",
      organizationId: "organization-a",
      name: "Northwind Manufacturing",
      currency: "USD",
      currentRows: [
        {
          accountId: "revenue",
          accountName: "Revenue",
          accountNumber: "4000",
          accountType: "revenue",
          subtype: null,
          parentId: null,
          totalDebit: "0",
          totalCredit: "125.00",
        },
      ],
      priorRows: null,
      asOfRows: [],
    });

    expect(metric).toMatchObject({
      revenue: "125.00",
      netIncome: "125.00",
      priorRevenue: null,
      priorNetIncome: null,
      revenueChangePct: null,
    });
  });

  it("deduplicates the same organization before combined reporting", () => {
    const result = dedupeGroupAccess([
      {
        enterpriseAccountId: "11111111-1111-4111-8111-111111111111",
        groupId: "group-a",
        groupName: "Operating Companies",
        access: {
          entities: [sharedBusiness],
          totalEntityCount: 1,
          omittedEntityCount: 0,
          isComplete: true,
        },
      },
      {
        enterpriseAccountId: "11111111-1111-4111-8111-111111111111",
        groupId: "group-b",
        groupName: "Regional Portfolio",
        access: {
          entities: [{ ...sharedBusiness, id: "entity-b" }],
          totalEntityCount: 1,
          omittedEntityCount: 0,
          isComplete: true,
        },
      },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      groupIds: ["group-a", "group-b"],
      groupNames: ["Operating Companies", "Regional Portfolio"],
    });
  });

  it("sums only the metrics passed after deduplication", () => {
    const metric: EntityPerformanceMetric = {
      entityId: "entity-a",
      organizationId: "organization-a",
      name: "Northwind Manufacturing",
      currency: "USD",
      revenue: "184320.00",
      priorRevenue: "170000.00",
      revenueChangePct: 8.42,
      grossProfit: "112400.00",
      grossMargin: 60.98,
      operatingExpenses: "47400.00",
      operatingIncome: "65000.00",
      operatingMargin: 35.26,
      netIncome: "61750.00",
      priorNetIncome: "55000.00",
      netMargin: 33.5,
      cash: "93420.00",
      profitable: true,
    };

    expect(aggregateMetrics([metric]).aggregate).toMatchObject({
      revenue: "184320.00",
      netIncome: "61750.00",
      cash: "93420.00",
    });

    const tenCents = {
      ...metric,
      entityId: "entity-ten",
      organizationId: "organization-ten",
      revenue: "0.10",
      priorRevenue: "0.10",
      grossProfit: "0.10",
      operatingExpenses: "0.10",
      operatingIncome: "0.10",
      netIncome: "0.10",
      priorNetIncome: "0.10",
      cash: "0.10",
    };
    const twentyCents = {
      ...tenCents,
      entityId: "entity-twenty",
      organizationId: "organization-twenty",
      revenue: "0.20",
      priorRevenue: "0.20",
      grossProfit: "0.20",
      operatingExpenses: "0.20",
      operatingIncome: "0.20",
      netIncome: "0.20",
      priorNetIncome: "0.20",
      cash: "0.20",
    };
    expect(aggregateMetrics([tenCents, twentyCents]).aggregate).toMatchObject({
      revenue: "0.30",
      netIncome: "0.30",
      cash: "0.30",
    });
  });
});
