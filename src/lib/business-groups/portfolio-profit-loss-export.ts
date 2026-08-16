import type { PortfolioProfitLossResult } from "./portfolio-profit-loss";

function protectSpreadsheetFormula(value: string): string {
  return /^\s*[=+\-@]/.test(value) || /^[\t\r]/.test(value) ? `'${value}` : value;
}

interface RawCsvNumber {
  raw: string;
}

type CsvCell = string | number | null | undefined | RawCsvNumber;

function csvText(value: CsvCell): string {
  if (typeof value === "object" && value !== null) return value.raw;
  const safe = protectSpreadsheetFormula(value == null ? "" : String(value));
  return `"${safe.replaceAll('"', '""')}"`;
}

function csvRow(values: CsvCell[]): string {
  return values.map(csvText).join(",");
}

function amount(value: number | null): string | RawCsvNumber {
  if (value === null) return "";
  if (!Number.isFinite(value)) throw new Error("Portfolio export contains an invalid amount");
  return { raw: value.toFixed(2) };
}

function scopeList(values: Array<{ id?: string; organizationId?: string; name: string }>): string {
  return values
    .map((value) => `${value.name} [${value.id ?? value.organizationId ?? ""}]`)
    .join("; ");
}

export interface PortfolioProfitLossCsv {
  filename: string;
  csv: string;
}

/** Serialize only the server-authorized report and its explanatory metadata. */
export function buildPortfolioProfitLossCsv(
  result: PortfolioProfitLossResult,
): PortfolioProfitLossCsv {
  const { metadata, report } = result;
  const rows: string[] = [
    csvRow(["Portfolio Profit & Loss"]),
    csvRow(["Metadata", "Value"]),
    csvRow(["Enterprise account ID", metadata.enterpriseAccountId]),
    csvRow(["Selected group count", metadata.selectedGroupCount]),
    csvRow(["Selected groups", scopeList(metadata.selectedGroups)]),
    csvRow(["Period", `${metadata.dateFrom} to ${metadata.dateTo}`]),
    csvRow(["Comparison", metadata.compare]),
    csvRow(["Currency", metadata.currency ?? "Unavailable - statement withheld"]),
    csvRow(["Source mode", metadata.sourceMode]),
    csvRow(["Generated at", metadata.generatedAt]),
    csvRow(["Projection status", metadata.projectionStatus]),
    csvRow(["Projection as of", metadata.projectionAsOf]),
    csvRow(["Projection lag seconds", metadata.projectionLagSeconds]),
    csvRow(["Linked business assignments", metadata.totalEntityCount]),
    csvRow(["Unique included businesses", metadata.uniqueEntityCount]),
    csvRow(["Included businesses", scopeList(metadata.includedBusinesses)]),
    csvRow(["Omitted businesses", metadata.omittedEntityCount]),
    csvRow(["Incomplete businesses", metadata.incompleteEntityCount]),
    csvRow(["Deduplicated overlapping assignments", metadata.duplicateMembershipCount]),
    "",
    csvRow(["Warnings"]),
  ];

  if (metadata.warnings.length === 0) {
    rows.push(csvRow(["Warning", "None"]));
  } else {
    rows.push(...metadata.warnings.map((warning) => csvRow(["Warning", warning])));
  }

  rows.push("", csvRow(["Statement"]));
  if (!report) {
    rows.push(
      csvRow([
        "Status",
        "Financial rows withheld. Review the currency, projection, access, and warning metadata above.",
      ]),
    );
    return {
      filename: `portfolio-profit-loss-${metadata.dateFrom}-${metadata.dateTo}.csv`,
      csv: `${rows.join("\r\n")}\r\n`,
    };
  }

  rows.push(csvRow(["Section", "Account number", "Account", "Current", "Prior"]));
  const sections = [
    report.revenue,
    report.costOfRevenue,
    report.expenses,
    report.otherIncome,
    report.otherExpenses,
  ];
  for (const section of sections) {
    for (const account of section.accounts) {
      rows.push(
        csvRow([
          section.label,
          account.accountNumber,
          account.name,
          amount(account.current),
          amount(account.prior),
        ]),
      );
    }
    rows.push(
      csvRow([section.label, "", "Total", amount(section.total), amount(section.priorTotal)]),
    );
  }
  rows.push(
    csvRow([
      "Summary",
      "",
      "Gross Profit",
      amount(report.grossProfit),
      amount(report.priorGrossProfit),
    ]),
    csvRow([
      "Summary",
      "",
      "Operating Income",
      amount(report.operatingIncome),
      amount(report.priorOperatingIncome),
    ]),
    csvRow(["Summary", "", "Net Income", amount(report.netIncome), amount(report.priorNetIncome)]),
  );

  return {
    filename: `portfolio-profit-loss-${metadata.dateFrom}-${metadata.dateTo}.csv`,
    csv: `${rows.join("\r\n")}\r\n`,
  };
}
