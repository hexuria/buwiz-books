import { describe, expect, it } from "vitest";
import type { ReportRow } from "../../src/lib/report-calculations";
import type { BusinessGroupPerformanceAccess } from "../../src/lib/business-groups/performance-model";
import {
  buildPortfolioProfitLossMetadata,
  buildPortfolioReportScope,
  combinePortfolioReportRows,
  PORTFOLIO_PNL_SHADOW_UNSUPPORTED_WARNING,
  summarizeProjectionReadiness,
} from "../../src/lib/business-groups/portfolio-profit-loss-model";
import type { ProjectionStateView } from "../../src/lib/reporting/projection-types";
import { portfolioProfitLossSchema } from "../../src/db/validation/reports";

function reportRow(input: Partial<ReportRow> & Pick<ReportRow, "accountId">): ReportRow {
  return {
    accountId: input.accountId,
    accountName: input.accountName ?? "Service Revenue",
    accountNumber: input.accountNumber ?? "4000",
    accountType: input.accountType ?? "revenue",
    subtype: input.subtype ?? "sales",
    parentId: null,
    totalDebit: input.totalDebit ?? "0",
    totalCredit: input.totalCredit ?? "0",
  };
}

function group(
  input: Partial<BusinessGroupPerformanceAccess> &
    Pick<BusinessGroupPerformanceAccess, "groupId" | "groupName">,
): BusinessGroupPerformanceAccess {
  return {
    enterpriseAccountId: input.enterpriseAccountId ?? "account-1",
    groupId: input.groupId,
    groupName: input.groupName,
    access: input.access ?? {
      entities: [],
      totalEntityCount: 0,
      omittedEntityCount: 0,
      isComplete: true,
    },
  };
}

function state(input: Partial<ProjectionStateView> = {}): ProjectionStateView {
  return {
    organizationId: input.organizationId ?? "org-1",
    status: input.status ?? "ready",
    requestedVersion: input.requestedVersion ?? 2,
    appliedVersion: input.appliedVersion ?? 2,
    lastLedgerEventAt: input.lastLedgerEventAt ?? new Date("2026-08-01T11:59:00.000Z"),
    lastProjectedAt: input.lastProjectedAt ?? new Date("2026-08-01T12:00:00.000Z"),
    initialBackfillCompletedAt:
      input.initialBackfillCompletedAt ?? new Date("2026-07-01T00:00:00.000Z"),
    lastError: input.lastError ?? null,
    updatedAt: input.updatedAt ?? new Date("2026-08-01T12:00:00.000Z"),
  };
}

describe("portfolio Profit & Loss", () => {
  it("rejects impossible calendar dates before report execution", () => {
    const input = {
      enterpriseAccountId: "7dff0f5d-f5e8-4a9f-b8eb-2cdb82a68f92",
      groupIds: ["21384b9e-1dc3-4aef-9bf7-f98aa74d9803"],
      dateFrom: "2026-02-01",
      dateTo: "2026-02-28",
      compare: "none" as const,
    };

    expect(portfolioProfitLossSchema.safeParse(input).success).toBe(true);
    expect(portfolioProfitLossSchema.safeParse({ ...input, dateTo: "2026-02-30" }).success).toBe(
      false,
    );
    expect(portfolioProfitLossSchema.safeParse({ ...input, dateFrom: "2026-13-01" }).success).toBe(
      false,
    );
    expect(
      portfolioProfitLossSchema.safeParse({
        ...input,
        dateFrom: "2026-03-01",
        dateTo: "2026-02-28",
      }).success,
    ).toBe(false);
  });

  it("combines equivalent accounts without assuming shared account IDs", () => {
    const rows = combinePortfolioReportRows([
      reportRow({ accountId: "org-a-revenue", totalCredit: "125.25" }),
      reportRow({ accountId: "org-b-revenue", totalCredit: "74.75" }),
      reportRow({
        accountId: "org-b-consulting",
        accountName: "Consulting Revenue",
        accountNumber: "4010",
        totalCredit: "50.00",
      }),
    ]);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      accountName: "Service Revenue",
      totalDebit: "0.00",
      totalCredit: "200.00",
      parentId: null,
    });
    expect(rows[0].accountId).not.toContain("org-a-revenue");
    expect(rows[1].totalCredit).toBe("50.00");
  });

  it("deduplicates authorized businesses and exposes only aggregate omission counts", () => {
    const sharedEntity = {
      id: "entity-a",
      organizationId: "org-a",
      name: "Northwind",
      role: "owner",
      currency: "USD",
    };
    const scope = buildPortfolioReportScope([
      group({
        groupId: "group-a",
        groupName: "Operating",
        access: {
          entities: [sharedEntity],
          totalEntityCount: 2,
          omittedEntityCount: 1,
          isComplete: false,
        },
      }),
      group({
        groupId: "group-b",
        groupName: "Regional",
        access: {
          entities: [sharedEntity],
          totalEntityCount: 1,
          omittedEntityCount: 0,
          isComplete: true,
        },
      }),
    ]);

    expect(scope).toMatchObject({
      enterpriseAccountId: "account-1",
      totalEntityCount: 3,
      omittedEntityCount: 1,
      duplicateMembershipCount: 1,
      currency: "USD",
    });
    expect(scope.organizations).toEqual([
      expect.objectContaining({
        organizationId: "org-a",
        groupIds: ["group-a", "group-b"],
        groupNames: ["Operating", "Regional"],
      }),
    ]);
    expect(JSON.stringify(scope)).not.toContain("omitted-org-id");
  });

  it("withholds a portfolio currency when authorized businesses differ", () => {
    const scope = buildPortfolioReportScope([
      group({
        groupId: "group-a",
        groupName: "Mixed",
        access: {
          entities: [
            {
              id: "entity-a",
              organizationId: "org-a",
              name: "Northwind",
              role: "owner",
              currency: "USD",
            },
            {
              id: "entity-b",
              organizationId: "org-b",
              name: "Contoso",
              role: "admin",
              currency: "PHP",
            },
          ],
          totalEntityCount: 2,
          omittedEntityCount: 0,
          isComplete: true,
        },
      }),
    ]);

    expect(scope.currency).toBeNull();
  });

  it("withholds mixed-currency live totals before entering any organization ledger", () => {
    const scope = buildPortfolioReportScope([
      group({
        groupId: "group-a",
        groupName: "Mixed",
        access: {
          entities: [
            {
              id: "entity-a",
              organizationId: "org-a",
              name: "Northwind",
              role: "owner",
              currency: "USD",
            },
            {
              id: "entity-b",
              organizationId: "org-b",
              name: "Contoso",
              role: "admin",
              currency: "PHP",
            },
          ],
          totalEntityCount: 2,
          omittedEntityCount: 0,
          isComplete: true,
        },
      }),
    ]);
    const metadata = buildPortfolioProfitLossMetadata(scope, {
      dateFrom: "2026-07-01",
      dateTo: "2026-07-31",
      compare: "none",
      sourceMode: "live_ledger",
    });

    expect(metadata.currency).toBeNull();
    expect(metadata.warnings).toEqual([expect.stringContaining("different functional currencies")]);
  });

  it("labels unsupported shadow configuration as live ledger output", () => {
    const scope = buildPortfolioReportScope([
      group({
        groupId: "group-a",
        groupName: "Empty Portfolio",
      }),
    ]);
    const metadata = buildPortfolioProfitLossMetadata(
      scope,
      {
        dateFrom: "2026-07-01",
        dateTo: "2026-07-31",
        compare: "none",
        sourceMode: "live_ledger",
      },
      {
        warnings: [PORTFOLIO_PNL_SHADOW_UNSUPPORTED_WARNING],
      },
    );

    expect(metadata.sourceMode).toBe("live_ledger");
    expect(JSON.stringify(metadata)).not.toContain('"sourceMode":"shadow"');
    expect(metadata.warnings).toContain(PORTFOLIO_PNL_SHADOW_UNSUPPORTED_WARNING);
    expect(metadata.projectionStatus).toBe("not_applicable");
  });

  it("uses the oldest projection timestamp and fails closed on incomplete states", () => {
    const states = new Map<string, ProjectionStateView>([
      ["org-a", state({ organizationId: "org-a" })],
      [
        "org-b",
        state({
          organizationId: "org-b",
          status: "failed",
          requestedVersion: 3,
          appliedVersion: 2,
          lastProjectedAt: new Date("2026-08-01T11:30:00.000Z"),
          lastLedgerEventAt: new Date("2026-08-01T11:45:00.000Z"),
        }),
      ],
    ]);

    expect(
      summarizeProjectionReadiness(
        ["org-a", "org-b"],
        states,
        new Date("2026-08-01T12:00:00.000Z"),
      ),
    ).toEqual({
      projectionAsOf: "2026-08-01T11:30:00.000Z",
      projectionLagSeconds: 900,
      projectionStatus: "failed",
      incompleteEntityCount: 1,
    });
  });
});
