import { describe, expect, it } from "vitest";
import { buildProfitLoss } from "../../src/lib/report-calculations";
import type {
  PortfolioProfitLossMetadata,
  PortfolioProfitLossResult,
} from "../../src/lib/business-groups/portfolio-profit-loss-model";
import { buildPortfolioProfitLossCsv } from "../../src/lib/business-groups/portfolio-profit-loss-export";

function metadata(
  overrides: Partial<PortfolioProfitLossMetadata> = {},
): PortfolioProfitLossMetadata {
  return {
    enterpriseAccountId: "account-1",
    selectedGroups: [{ id: "group-1", name: "Operating, North" }],
    includedBusinesses: [
      {
        organizationId: "org-1",
        name: 'Northwind "Trading"',
        groupIds: ["group-1"],
        groupNames: ["Operating, North"],
      },
    ],
    selectedGroupCount: 1,
    uniqueEntityCount: 1,
    totalEntityCount: 2,
    omittedEntityCount: 1,
    duplicateMembershipCount: 0,
    currency: "USD",
    dateFrom: "2026-07-01",
    dateTo: "2026-07-31",
    compare: "prior_period",
    sourceMode: "live_ledger",
    generatedAt: "2026-08-01T12:00:00.000Z",
    projectionAsOf: null,
    projectionLagSeconds: null,
    projectionStatus: "not_applicable",
    incompleteEntityCount: 0,
    warnings: ["1 linked business was omitted because you do not have direct access."],
    ...overrides,
  };
}

function populatedResult(): PortfolioProfitLossResult {
  return {
    metadata: metadata(),
    report: buildProfitLoss(
      [
        {
          accountId: "revenue",
          accountName: "Service Revenue",
          accountNumber: "4000",
          accountType: "revenue",
          subtype: "sales",
          parentId: null,
          totalDebit: "0",
          totalCredit: "100",
        },
        {
          accountId: "rent",
          accountName: "Rent",
          accountNumber: "6000",
          accountType: "expense",
          subtype: "rent_or_lease",
          parentId: null,
          totalDebit: "25",
          totalCredit: "0",
        },
      ],
      "2026-07-01",
      "2026-07-31",
      "prior_period",
      [
        {
          accountId: "revenue",
          accountName: "Service Revenue",
          accountNumber: "4000",
          accountType: "revenue",
          subtype: "sales",
          parentId: null,
          totalDebit: "0",
          totalCredit: "80",
        },
      ],
    ),
  };
}

describe("portfolio Profit & Loss CSV", () => {
  it("exports the authorized scope, warnings, source semantics, and financial rows", () => {
    const output = buildPortfolioProfitLossCsv(populatedResult());

    expect(output.filename).toBe("portfolio-profit-loss-2026-07-01-2026-07-31.csv");
    expect(output.csv).toContain('"Selected groups","Operating, North [group-1]"');
    expect(output.csv).toContain('"Included businesses","Northwind ""Trading"" [org-1]"');
    expect(output.csv).toContain('"Source mode","live_ledger"');
    expect(output.csv).toContain('"Omitted businesses","1"');
    expect(output.csv).toContain(
      '"Warning","1 linked business was omitted because you do not have direct access."',
    );
    expect(output.csv).toContain('"Revenue","4000","Service Revenue",100.00,80.00');
    expect(output.csv).toContain('"Summary","","Net Income",75.00,80.00');
  });

  it("exports withheld-state metadata without inventing financial rows", () => {
    const output = buildPortfolioProfitLossCsv({
      report: null,
      metadata: metadata({
        currency: null,
        projectionStatus: "stale",
        incompleteEntityCount: 1,
        warnings: ["Projected financial data is not current for every included business."],
      }),
    });

    expect(output.csv).toContain('"Currency","Unavailable - statement withheld"');
    expect(output.csv).toContain('"Projection status","stale"');
    expect(output.csv).toContain('"Incomplete businesses","1"');
    expect(output.csv).toContain('"Status","Financial rows withheld.');
    expect(output.csv).not.toContain('"Summary","","Net Income"');
  });

  it("neutralizes spreadsheet formulas in names and warnings", () => {
    const output = buildPortfolioProfitLossCsv({
      report: null,
      metadata: metadata({
        selectedGroups: [{ id: "group-1", name: '=HYPERLINK("https://invalid")' }],
        warnings: ["+SUM(1,1)"],
      }),
    });

    expect(output.csv).toContain("'=HYPERLINK");
    expect(output.csv).toContain("'+SUM(1,1)");
  });
});
