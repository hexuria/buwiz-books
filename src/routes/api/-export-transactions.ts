/**
 * Transaction Export Server Functions
 * Download CSV, Export CSV to Documents, Download Financial Package
 *
 * XLSX format:
 * - Header rows: Company Name, Report Title, Date Range, Export Timestamp, blank
 * - Account numbers in col A, indented names in col B, amounts in col C+
 * - Currency format: "$"#,##0.00_)
 * - Column widths optimized for readability
 */
import { createServerFn } from "@tanstack/react-start";
import { serverBrand } from "@/config/brand";
import type { DbExecutor } from "../../db";
import { effectiveJournalPredicate, journalHeaders, journalLines } from "../../db/schema/journals";
import { accounts } from "../../db/schema/accounts";
import { parties } from "../../db/schema/parties";
import { organization } from "../../db/schema/auth";
import { eq, and, inArray, gte, lte, desc, asc, ilike, or, type SQL } from "drizzle-orm";
import { z } from "zod";
import { TRANSACTION_TYPES, JOURNAL_STATUSES } from "../../db/validation/journals";
import { withMutationPermissionOrgContext, withSessionOrgContext } from "../../lib/server-context";

// ============================================================================
// Schemas
// ============================================================================

const exportCSVSchema = z.object({
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  types: z.array(z.enum(TRANSACTION_TYPES)).optional().default([]),
  statuses: z.array(z.enum(JOURNAL_STATUSES)).optional().default([]),
  partyIds: z.array(z.string().uuid()).optional(),
  accountId: z.string().uuid().optional(),
  departmentIds: z.array(z.string().uuid()).optional(),
  locationIds: z.array(z.string().uuid()).optional(),
  search: z.string().optional(),
});

const financialPackageSchema = z.object({
  dateFrom: z.string(),
  dateTo: z.string(),
  includeTransactionList: z.boolean().optional().default(true),
  includeTrialBalance: z.boolean().optional().default(true),
  includeProfitLoss: z.boolean().optional().default(true),
  includeBalanceSheet: z.boolean().optional().default(true),
  includeCashFlow: z.boolean().optional().default(true),
});

// ============================================================================
// Helpers
// ============================================================================

interface CSVLine {
  categoryNumber: string;
  categoryName: string;
  splitCategoryNumber: string;
  splitCategoryName: string;
  partyName: string;
  date: string;
  debit: string;
  credit: string;
  memo: string;
}

function escapeCSV(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function formatAmount(val: string | null): string {
  if (!val) return "";
  const num = Number.parseFloat(val);
  if (num === 0) return "";
  return num.toFixed(2);
}

/** Get the organization's display name for XLSX headers (e.g. "Hugo's Demo Client") */
async function getOrgDisplayName(db: DbExecutor, orgId: string): Promise<string> {
  const [org] = await db
    .select({ name: organization.name })
    .from(organization)
    .where(eq(organization.id, orgId))
    .limit(1);
  return org?.name ?? "My Organization";
}

// ── Date formatting helpers ────────────────────────────────────────

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** "2017-01-01" → "January 2017" */
function formatMonthYear(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  return `${MONTH_NAMES[d.getMonth()]} ${d.getFullYear()}`;
}

/** "2026-12-31" → "December 31, 2026" */
function formatFullDate(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  return `${MONTH_NAMES[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

/** "January 2017 - December 2026" */
function formatDateRange(dateFrom: string, dateTo: string): string {
  return `${formatMonthYear(dateFrom)} - ${formatMonthYear(dateTo)}`;
}

/** Short year range for column headers: "'17 - '26" */
function formatShortYearRange(dateFrom: string, dateTo: string): string {
  const fromYear = new Date(dateFrom + "T00:00:00").getFullYear() % 100;
  const toYear = new Date(dateTo + "T00:00:00").getFullYear() % 100;
  return `'${String(fromYear).padStart(2, "0")} - '${String(toYear).padStart(2, "0")}`;
}

/** Year range for filenames: "2017 - 2026" */
function formatYearRange(dateFrom: string, dateTo: string): string {
  const fromYear = new Date(dateFrom + "T00:00:00").getFullYear();
  const toYear = new Date(dateTo + "T00:00:00").getFullYear();
  return `${fromYear} - ${toYear}`;
}

/** Current export timestamp: "February 11, 2026 at 02:02 AM" */
function formatExportTimestamp(): string {
  const now = new Date();
  const month = MONTH_NAMES[now.getMonth()];
  const day = now.getDate();
  const year = now.getFullYear();
  let hours = now.getHours();
  const minutes = String(now.getMinutes()).padStart(2, "0");
  const ampm = hours >= 12 ? "PM" : "AM";
  hours = hours % 12;
  if (hours === 0) hours = 12;
  return `${month} ${day}, ${year} at ${String(hours).padStart(2, "0")}:${minutes} ${ampm}`;
}

// ── XLSX cell helpers ────────────────────────────────────────────────

const CURRENCY_FMT = '"$"#,##0.00_)';

/** Build the standard 4-row XLSX header block used by all reports */
function buildXLSXHeader(
  orgName: string,
  reportTitle: string,
  dateLine: string,
): Array<Array<{ v: string | number | null; t?: string; z?: string }>> {
  return [
    [{ v: orgName }, { v: null }, { v: null }],
    [{ v: reportTitle }, { v: null }, { v: null }],
    [{ v: dateLine }, { v: null }, { v: null }],
    [{ v: `Export date: ${formatExportTimestamp()}` }, { v: null }, { v: null }],
    [{ v: null }, { v: null }, { v: null }], // blank row
  ];
}

/** Create a cell object with optional currency formatting */
function cell(
  v: string | number | null,
  opts?: { fmt?: string },
): { v: string | number | null; t?: string; z?: string } {
  const c: { v: string | number | null; t?: string; z?: string } = { v };
  if (typeof v === "number" && opts?.fmt) {
    c.t = "n";
    c.z = opts.fmt;
  }
  return c;
}

/** Convert our cell array to a proper XLSX worksheet with formatting */
function createFormattedWorksheet(
  XLSX: typeof import("xlsx"),
  data: Array<Array<{ v: string | number | null; t?: string; z?: string }>>,
  colWidths: number[],
) {
  // Create the worksheet from values
  const plainData = data.map((row) => row.map((c) => c.v));
  const ws = XLSX.utils.aoa_to_sheet(plainData);

  // Apply cell formatting (number formats)
  for (let r = 0; r < data.length; r++) {
    for (let c = 0; c < data[r].length; c++) {
      const cellDef = data[r][c];
      if (cellDef.z) {
        const cellAddress = XLSX.utils.encode_cell({ r, c });
        if (ws[cellAddress]) {
          ws[cellAddress].z = cellDef.z;
        }
      }
    }
  }

  // Set column widths
  ws["!cols"] = colWidths.map((w) => ({ wch: w }));

  return ws;
}

// ============================================================================
// Export Transactions CSV
// ============================================================================

/**
 * Build CSV string of all transactions matching the filters.
 * Format: Category #, Category Name, Split Category #,
 * Split Category Name, Party Name, Date, Debit, Credit, Memo
 */
export const exportTransactionsCSV = createServerFn({ method: "GET" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    return withSessionOrgContext(async ({ orgId, db }) => {
      const parsed = exportCSVSchema.parse(rawData ?? {});
      const { csv, filename } = await buildTransactionsCSV(db, orgId, parsed);
      return { csv, filename };
    });
  },
);

async function buildTransactionsCSV(
  db: DbExecutor,
  orgId: string,
  filters: z.infer<typeof exportCSVSchema>,
): Promise<{ csv: string; filename: string }> {
  const {
    dateFrom,
    dateTo,
    types,
    statuses,
    partyIds,
    accountId,
    departmentIds,
    locationIds,
    search,
  } = filters;

  // Build conditions
  const conditions = [eq(journalHeaders.organizationId, orgId), effectiveJournalPredicate()];

  if (types.length > 0) {
    conditions.push(inArray(journalHeaders.transactionType, types));
  }
  if (statuses.length > 0) {
    conditions.push(inArray(journalHeaders.status, statuses));
  }
  if (dateFrom) {
    conditions.push(gte(journalHeaders.transactionDate, dateFrom));
  }
  if (dateTo) {
    conditions.push(lte(journalHeaders.transactionDate, dateTo));
  }
  if (partyIds && partyIds.length > 0) {
    conditions.push(inArray(journalHeaders.partyId, partyIds));
  }
  if (search && search.trim()) {
    const q = `%${search.trim()}%`;
    conditions.push(
      or(ilike(journalHeaders.memo, q), ilike(journalHeaders.transactionNumber, q)) as SQL<unknown>,
    );
  }

  // Filter by account — only get transactions touching that account
  if (accountId) {
    const matchingLines = await db
      .selectDistinct({ headerId: journalLines.journalHeaderId })
      .from(journalLines)
      .where(eq(journalLines.accountId, accountId));
    const headerIds = matchingLines.map((l) => l.headerId);
    if (headerIds.length === 0) {
      return {
        csv: "Category #,Category Name,Split Category #,Split Category Name,Party Name,Date,Debit,Credit,Memo\n",
        filename: "export.csv",
      };
    }
    conditions.push(inArray(journalHeaders.id, headerIds));
  }

  // Filter by department
  if (departmentIds && departmentIds.length > 0) {
    const deptLines = await db
      .selectDistinct({ headerId: journalLines.journalHeaderId })
      .from(journalLines)
      .where(inArray(journalLines.departmentId, departmentIds));
    const deptHeaderIds = deptLines.map((l) => l.headerId);
    if (deptHeaderIds.length === 0) {
      return {
        csv: "Category #,Category Name,Split Category #,Split Category Name,Party Name,Date,Debit,Credit,Memo\n",
        filename: "export.csv",
      };
    }
    conditions.push(inArray(journalHeaders.id, deptHeaderIds));
  }

  // Filter by location
  if (locationIds && locationIds.length > 0) {
    const locLines = await db
      .selectDistinct({ headerId: journalLines.journalHeaderId })
      .from(journalLines)
      .where(inArray(journalLines.locationId, locationIds));
    const locHeaderIds = locLines.map((l) => l.headerId);
    if (locHeaderIds.length === 0) {
      return {
        csv: "Category #,Category Name,Split Category #,Split Category Name,Party Name,Date,Debit,Credit,Memo\n",
        filename: "export.csv",
      };
    }
    conditions.push(inArray(journalHeaders.id, locHeaderIds));
  }

  // Fetch all matching headers
  const headers = await db
    .select({
      id: journalHeaders.id,
      transactionDate: journalHeaders.transactionDate,
      memo: journalHeaders.memo,
      partyId: journalHeaders.partyId,
      partyName: parties.name,
    })
    .from(journalHeaders)
    .leftJoin(parties, eq(journalHeaders.partyId, parties.id))
    .where(and(...conditions))
    .orderBy(desc(journalHeaders.transactionDate), desc(journalHeaders.createdAt));

  const orgName = await getOrgDisplayName(db, orgId);
  const yearRange = formatYearRange(dateFrom ?? "2017-01-01", dateTo ?? "2099-12-31");

  if (headers.length === 0) {
    return {
      csv: "Category #,Category Name,Split Category #,Split Category Name,Party Name,Date,Debit,Credit,Memo\n",
      filename: `${orgName} - ${yearRange} - Transaction List.csv`,
    };
  }

  // Fetch all lines for these headers with account info
  const headerIds = headers.map((h) => h.id);
  const allLines = await db
    .select({
      journalHeaderId: journalLines.journalHeaderId,
      accountId: journalLines.accountId,
      debit: journalLines.debit,
      credit: journalLines.credit,
      accountNumber: accounts.accountNumber,
      accountName: accounts.name,
    })
    .from(journalLines)
    .innerJoin(accounts, eq(journalLines.accountId, accounts.id))
    .where(inArray(journalLines.journalHeaderId, headerIds))
    .orderBy(asc(journalLines.sortOrder));

  // Group lines by header
  const linesByHeader = new Map<
    string,
    Array<{
      accountId: string;
      accountNumber: string | null;
      accountName: string;
      debit: string | null;
      credit: string | null;
    }>
  >();
  for (const line of allLines) {
    if (!linesByHeader.has(line.journalHeaderId)) {
      linesByHeader.set(line.journalHeaderId, []);
    }
    linesByHeader.get(line.journalHeaderId)!.push({
      accountId: line.accountId,
      accountNumber: line.accountNumber,
      accountName: line.accountName,
      debit: line.debit,
      credit: line.credit,
    });
  }

  // Build CSV rows
  const csvLines: CSVLine[] = [];

  for (const header of headers) {
    const lines = linesByHeader.get(header.id) ?? [];
    if (lines.length === 0) continue;

    for (const line of lines) {
      // Determine split category (contra account)
      const contraLines = lines.filter((l) => l.accountId !== line.accountId);
      let splitCategoryNumber = "";
      let splitCategoryName = "";

      if (contraLines.length === 1) {
        splitCategoryNumber = contraLines[0].accountNumber ?? "";
        splitCategoryName = contraLines[0].accountName;
      } else if (contraLines.length > 1) {
        // Multiple contra accounts
        splitCategoryName = "Multiple Categories";
      }

      csvLines.push({
        categoryNumber: line.accountNumber ?? "",
        categoryName: line.accountName,
        splitCategoryNumber,
        splitCategoryName,
        partyName: header.partyName ?? "",
        date: header.transactionDate,
        debit: formatAmount(line.debit),
        credit: formatAmount(line.credit),
        memo: header.memo ?? "",
      });
    }
  }

  // Build CSV string
  const headerRow =
    "Category #,Category Name,Split Category #,Split Category Name,Party Name,Date,Debit,Credit,Memo";
  const dataRows = csvLines.map(
    (r) =>
      `${escapeCSV(r.categoryNumber)},${escapeCSV(r.categoryName)},${escapeCSV(r.splitCategoryNumber)},${escapeCSV(r.splitCategoryName)},${escapeCSV(r.partyName)},${escapeCSV(r.date)},${r.debit},${r.credit},${escapeCSV(r.memo)}`,
  );

  const csv = [headerRow, ...dataRows].join("\n");
  // Filename format: "<OrgName> - <YearRange> - Transaction List.csv"
  const filename = `${orgName} - ${yearRange} - Transaction List.csv`;

  return { csv, filename };
}

// ============================================================================
// Export CSV to Documents
// ============================================================================

/**
 * Generate CSV and upload it to the Documents folder, returning the document ID.
 */
export const exportCSVToDocuments = createServerFn({ method: "POST" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "document",
      "upload",
      { routeKey: "transactions:export-csv-to-documents", limit: 20, windowMs: 300_000 },
      async ({ orgId, db }) => {
        const parsed = exportCSVSchema.parse(rawData ?? {});
        const { csv, filename } = await buildTransactionsCSV(db, orgId, parsed);

        // Upload via the existing document upload flow
        const { uploadDocument } = await import("./-documents");
        const fileBase64 = Buffer.from(csv, "utf-8").toString("base64");

        const result = await (uploadDocument as (opts: { data: unknown }) => Promise<any>)({
          data: {
            filename,
            contentType: "text/csv",
            fileBase64,
            documentType: "other",
            displayTitle: filename,
            intakeMode: "evidence_only",
          },
        });

        return { documentId: result.document.id, filename };
      },
    );
  },
);

// ============================================================================
// Export Financial Package (ZIP)
// ============================================================================

/**
 * Generate a financial package ZIP containing selected reports.
 * Each XLSX export format:
 * - 4-row header (company name, report title, date range, export timestamp)
 * - Blank row separator
 * - Data with account numbers, indented names, currency-formatted amounts
 * - Matching column widths
 */
export const exportFinancialPackage = createServerFn({ method: "GET" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    return withSessionOrgContext(async ({ orgId, db }) => {
      const parsed = financialPackageSchema.parse(rawData ?? {});
      const { dateFrom, dateTo } = parsed;

      const JSZip = (await import("jszip")).default;
      const XLSX = await import("xlsx");
      const zip = new JSZip();

      const orgName = await getOrgDisplayName(db, orgId);
      const yearRange = formatYearRange(dateFrom, dateTo);
      const dateRange = formatDateRange(dateFrom, dateTo);
      const shortRange = formatShortYearRange(dateFrom, dateTo);

      // ── Transaction List CSV ───────────────────────────────────────────
      if (parsed.includeTransactionList) {
        const { csv } = await buildTransactionsCSV(db, orgId, {
          dateFrom,
          dateTo,
          types: [],
          statuses: [],
        });
        zip.file(`${orgName} - ${yearRange} - Transaction List.csv`, csv);
      }

      // ── Trial Balance XLSX ─────────────────────────────────────────────
      if (parsed.includeTrialBalance) {
        const { computeTrialBalance } = await import("../../services/reports");
        const tb = await computeTrialBalance(orgId, dateTo, db);

        // Columns: A=Number, B=Parent Accounts, C=Account Name, D=Debit, E=Credit
        const data: Array<Array<{ v: string | number | null; t?: string; z?: string }>> = [
          [{ v: orgName }, { v: null }, { v: null }, { v: null }, { v: null }],
          [{ v: "Trial Balance" }, { v: null }, { v: null }, { v: null }, { v: null }],
          [
            { v: `as of ${formatFullDate(dateTo)}` },
            { v: null },
            { v: null },
            { v: null },
            { v: null },
          ],
          [
            { v: `Exported from ${serverBrand.appName} on ${formatExportTimestamp()}` },
            { v: null },
            { v: null },
            { v: null },
            { v: null },
          ],
          [{ v: null }, { v: null }, { v: null }, { v: null }, { v: null }],
          // Column headers
          [
            { v: "Number" },
            { v: "Parent Accounts" },
            { v: "Account Name" },
            { v: "Debit" },
            { v: "Credit" },
          ],
        ];

        // Build parent path lookup from account type
        const TYPE_LABELS: Record<string, string> = {
          asset: "Assets",
          liability: "Liabilities",
          equity: "Equity",
          revenue: "Revenue",
          expense: "Expenses",
          cost_of_revenue: "Cost of Revenue",
          other_income: "Other Income",
          other_expense: "Other Expenses",
        };

        for (const acct of tb.accounts) {
          const parentLabel = TYPE_LABELS[acct.accountType] ?? acct.accountType;
          // Subtype can add detail like "Assets:Asset Clearing"
          const parentPath = acct.subtype
            ? `${parentLabel}:${acct.subtype.replace(/_/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase())}`
            : parentLabel;

          data.push([
            { v: acct.accountNumber ?? "" },
            { v: parentPath },
            { v: acct.name },
            cell(acct.debit > 0 ? acct.debit : 0, { fmt: CURRENCY_FMT }),
            cell(acct.credit > 0 ? acct.credit : 0, { fmt: CURRENCY_FMT }),
          ]);
        }

        // Retained Earnings row (no account number)
        const retainedEarnings = tb.totalDebit - tb.totalCredit;
        if (Math.abs(retainedEarnings) > 0.001) {
          data.push([
            { v: null },
            { v: null },
            { v: "Retained Earnings" },
            cell(retainedEarnings < 0 ? 0 : 0, { fmt: CURRENCY_FMT }),
            cell(retainedEarnings < 0 ? Math.abs(retainedEarnings) : 0, { fmt: CURRENCY_FMT }),
          ]);
        }

        // Total row
        data.push([
          { v: null },
          { v: null },
          { v: "Total Balance" },
          cell(tb.totalDebit, { fmt: CURRENCY_FMT }),
          cell(tb.totalCredit, { fmt: CURRENCY_FMT }),
        ]);

        const wb = XLSX.utils.book_new();
        const ws = createFormattedWorksheet(XLSX, data, [7, 31, 28, 14, 14]);
        XLSX.utils.book_append_sheet(wb, ws, "Trial Balance");
        const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
        zip.file(`${orgName} - as of ${formatFullDate(dateTo)} - Trial Balance.xlsx`, buf);
      }

      // ── Balance Sheet XLSX ─────────────────────────────────────────────
      if (parsed.includeBalanceSheet) {
        const { computeBalanceSheet } = await import("../../services/reports");
        const bs = await computeBalanceSheet(orgId, dateTo, "none", db);

        // Short date label for column header, e.g. "Feb 10 '26"
        const d = new Date(dateTo + "T00:00:00");
        const shortMonths = [
          "Jan",
          "Feb",
          "Mar",
          "Apr",
          "May",
          "Jun",
          "Jul",
          "Aug",
          "Sep",
          "Oct",
          "Nov",
          "Dec",
        ];
        const colLabel = `${shortMonths[d.getMonth()]} ${d.getDate()} '${String(d.getFullYear() % 100).padStart(2, "0")}`;

        const data: Array<Array<{ v: string | number | null; t?: string; z?: string }>> = [
          ...buildXLSXHeader(orgName, "Balance Sheet", `as of ${formatFullDate(dateTo)}`),
          // Column header row
          [{ v: null }, { v: null }, { v: colLabel }],
        ];

        // Helper to add section with proper indentation
        const addBSSection = (label: string, sectionAccts: any[]) => {
          data.push([{ v: " " }, { v: label.toUpperCase() }, { v: null }]);
          data.push([{ v: " " }, { v: "   Current " + label }, { v: null }]);
          for (const acct of sectionAccts) {
            const indent = "       ";
            data.push([
              { v: acct.accountNumber ?? " " },
              { v: `${indent}${acct.name}` },
              cell(acct.balance, { fmt: CURRENCY_FMT }),
            ]);
          }
        };

        // ASSETS
        const assetAccts = bs.sections.asset?.accounts ?? [];
        addBSSection("Assets", assetAccts);
        data.push([
          { v: " " },
          { v: "   Total Current Assets" },
          cell(bs.totalAssets, { fmt: CURRENCY_FMT }),
        ]);
        data.push([
          { v: "10000" },
          { v: "TOTAL ASSETS" },
          cell(bs.totalAssets, { fmt: CURRENCY_FMT }),
        ]);

        // LIABILITIES
        const liabilityAccts = bs.sections.liability?.accounts ?? [];
        addBSSection("Liabilities", liabilityAccts);
        data.push([
          { v: " " },
          { v: "   Total Current Liabilities" },
          cell(bs.totalLiabilities, { fmt: CURRENCY_FMT }),
        ]);
        data.push([
          { v: "20000" },
          { v: "TOTAL LIABILITIES" },
          cell(bs.totalLiabilities, { fmt: CURRENCY_FMT }),
        ]);

        // EQUITY
        const equityAccts = bs.sections.equity?.accounts ?? [];
        data.push([{ v: " " }, { v: "EQUITY" }, { v: null }]);
        for (const acct of equityAccts) {
          data.push([
            { v: acct.accountNumber ?? "38000" },
            { v: `   ${acct.name}` },
            cell(acct.balance, { fmt: CURRENCY_FMT }),
          ]);
        }
        data.push([
          { v: "30000" },
          { v: "TOTAL EQUITY" },
          cell(bs.totalEquity, { fmt: CURRENCY_FMT }),
        ]);
        data.push([
          { v: " " },
          { v: "TOTAL LIABILITIES AND EQUITY" },
          cell(bs.totalLiabilitiesAndEquity, { fmt: CURRENCY_FMT }),
        ]);

        const wb = XLSX.utils.book_new();
        const ws = createFormattedWorksheet(XLSX, data, [6, 41, 14]);
        XLSX.utils.book_append_sheet(wb, ws, "Balance Sheet");
        const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
        zip.file(`${orgName} - as of ${formatFullDate(dateTo)} - Balance Sheet.xlsx`, buf);
      }

      // ── Profit & Loss XLSX ─────────────────────────────────────────────
      if (parsed.includeProfitLoss) {
        const { computeProfitLoss } = await import("../../services/reports");
        const pl = await computeProfitLoss(orgId, dateFrom, dateTo, "none", db);

        const data: Array<Array<{ v: string | number | null; t?: string; z?: string }>> = [
          ...buildXLSXHeader(orgName, "Profit & Loss", dateRange),
          // Column header row with short year range
          [{ v: null }, { v: null }, { v: shortRange }],
        ];

        // Helper: add a P&L section with sub-accounts
        const addPLSection = (sectionLabel: string, section: any, totalPrefix = "TOTAL ") => {
          if (!section) return;

          data.push([{ v: " " }, { v: sectionLabel.toUpperCase() }, { v: null }]);

          // Group accounts by subtype for hierarchical display
          for (const acct of section.accounts) {
            data.push([
              { v: acct.accountNumber ?? " " },
              { v: `   ${acct.name}` },
              cell(acct.current, { fmt: CURRENCY_FMT }),
            ]);
          }

          data.push([
            { v: " " },
            { v: `${totalPrefix}${sectionLabel.toUpperCase()}` },
            cell(section.total, { fmt: CURRENCY_FMT }),
          ]);
        };

        // REVENUE
        addPLSection("Revenue", pl.revenue);

        // COST OF REVENUE
        addPLSection("Cost of Revenue", pl.costOfRevenue);

        // GROSS PROFIT
        data.push([{ v: " " }, { v: "GROSS PROFIT" }, cell(pl.grossProfit, { fmt: CURRENCY_FMT })]);

        // OPERATING EXPENSES
        if (pl.expenses && pl.expenses.accounts.length > 0) {
          data.push([{ v: " " }, { v: "OPERATING EXPENSES" }, { v: null }]);
          for (const acct of pl.expenses.accounts) {
            data.push([
              { v: acct.accountNumber ?? " " },
              { v: `   ${acct.name}` },
              cell(acct.current, { fmt: CURRENCY_FMT }),
            ]);
          }
          data.push([
            { v: pl.expenses.accounts[0]?.accountNumber?.slice(0, 3) + "00" || "60000" },
            { v: "TOTAL OPERATING EXPENSES" },
            cell(pl.expenses.total, { fmt: CURRENCY_FMT }),
          ]);
        }

        // NET OPERATING INCOME
        const netOperating = pl.grossProfit - (pl.expenses?.total ?? 0);
        data.push([
          { v: " " },
          { v: "NET OPERATING INCOME" },
          cell(netOperating, { fmt: CURRENCY_FMT }),
        ]);

        // OTHER EXPENSES
        if (pl.otherExpenses && pl.otherExpenses.accounts.length > 0) {
          addPLSection("Other Expenses", pl.otherExpenses);
          data.push([
            { v: " " },
            { v: "NET OTHER INCOME" },
            cell(-pl.otherExpenses.total, { fmt: CURRENCY_FMT }),
          ]);
        }

        // OTHER INCOME
        if (pl.otherIncome && pl.otherIncome.accounts.length > 0) {
          addPLSection("Other Income", pl.otherIncome);
        }

        // NET INCOME
        data.push([{ v: " " }, { v: "NET INCOME" }, cell(pl.netIncome, { fmt: CURRENCY_FMT })]);

        const wb = XLSX.utils.book_new();
        const ws = createFormattedWorksheet(XLSX, data, [6, 36, 14]);
        XLSX.utils.book_append_sheet(wb, ws, "Profit & Loss");
        const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
        zip.file(`${orgName} - ${dateRange} - Profit & Loss.xlsx`, buf);
      }

      // ── Cash Flow XLSX ─────────────────────────────────────────────────
      if (parsed.includeCashFlow) {
        const { computeCashFlow } = await import("../../services/reports");
        const cf = await computeCashFlow(orgId, dateFrom, dateTo, db);

        const data: Array<Array<{ v: string | number | null; t?: string; z?: string }>> = [
          ...buildXLSXHeader(orgName, "Cash Flow", dateRange),
          // Column header row with short year range
          [{ v: null }, { v: null }, { v: shortRange }],
        ];

        // Separate P&L items (Net Income) from BS adjustments in operating
        const plItems = cf.operating.items.filter(
          (item: any) =>
            item.accountType === "revenue" ||
            item.accountType === "expense" ||
            item.accountType === "cost_of_revenue" ||
            item.accountType === "other_income" ||
            item.accountType === "other_expense",
        );
        const bsAdjustments = cf.operating.items.filter(
          (item: any) =>
            item.accountType !== "revenue" &&
            item.accountType !== "expense" &&
            item.accountType !== "cost_of_revenue" &&
            item.accountType !== "other_income" &&
            item.accountType !== "other_expense",
        );

        // Net Income = sum of P&L items
        const netIncome = plItems.reduce((s: number, i: any) => s + i.amount, 0);
        // Total adjustments = sum of BS adjustments
        const totalAdjustments = bsAdjustments.reduce((s: number, i: any) => s + i.amount, 0);

        // OPERATING ACTIVITIES
        data.push([{ v: " " }, { v: "OPERATING ACTIVITIES" }, { v: null }]);
        data.push([{ v: " " }, { v: "   Net Income" }, cell(netIncome, { fmt: CURRENCY_FMT })]);
        data.push([
          { v: " " },
          { v: "   Adjustments to reconcile Net Income to Net Cash provided by operations" },
          { v: null },
        ]);

        // BS adjustment items with account numbers
        for (const item of bsAdjustments) {
          data.push([
            { v: item.accountNumber ?? " " },
            { v: `       ${item.name}` },
            cell(item.amount, { fmt: CURRENCY_FMT }),
          ]);
        }

        // Total Adjustments row
        data.push([
          { v: " " },
          { v: "   Total Adjustments to reconcile Net Income to Net Cash provided by operations" },
          cell(totalAdjustments, { fmt: CURRENCY_FMT }),
        ]);

        data.push([
          { v: " " },
          { v: "NET CASH PROVIDED BY OPERATING ACTIVITIES" },
          cell(cf.operating.total, { fmt: CURRENCY_FMT }),
        ]);

        // INVESTING ACTIVITIES
        data.push([{ v: " " }, { v: "INVESTING ACTIVITIES" }, { v: null }]);
        for (const item of cf.investing.items) {
          data.push([
            { v: item.accountNumber ?? " " },
            { v: `   ${item.name}` },
            cell(item.amount, { fmt: CURRENCY_FMT }),
          ]);
        }
        data.push([
          { v: " " },
          { v: "NET CASH PROVIDED BY INVESTING ACTIVITIES" },
          cell(cf.investing.total, { fmt: CURRENCY_FMT }),
        ]);

        // FINANCING ACTIVITIES
        data.push([{ v: " " }, { v: "FINANCING ACTIVITIES" }, { v: null }]);
        for (const item of cf.financing.items) {
          data.push([
            { v: item.accountNumber ?? " " },
            { v: `   ${item.name}` },
            cell(item.amount, { fmt: CURRENCY_FMT }),
          ]);
        }
        data.push([
          { v: " " },
          { v: "NET CASH PROVIDED BY FINANCING ACTIVITIES" },
          cell(cf.financing.total, { fmt: CURRENCY_FMT }),
        ]);

        // Summary
        data.push([
          { v: " " },
          { v: "NET CASH INCREASE FOR PERIOD" },
          cell(cf.netChange, { fmt: CURRENCY_FMT }),
        ]);
        data.push([
          { v: " " },
          { v: "CASH AT BEGINNING OF PERIOD" },
          cell(0, { fmt: CURRENCY_FMT }),
        ]);
        data.push([
          { v: " " },
          { v: "CASH AT END OF PERIOD" },
          cell(cf.netChange, { fmt: CURRENCY_FMT }),
        ]);

        const wb = XLSX.utils.book_new();
        const ws = createFormattedWorksheet(XLSX, data, [6, 80, 14]);
        XLSX.utils.book_append_sheet(wb, ws, "Cash Flow");
        const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
        zip.file(`${orgName} - ${dateRange} - Cash Flow.xlsx`, buf);
      }

      const zipBuffer = await zip.generateAsync({ type: "base64" });
      // Filename format: "<OrgName> - Financial Package - <YearRange>"
      const zipFilename = `${orgName} - Financial Package - ${yearRange}.zip`;

      return { zipBase64: zipBuffer, filename: zipFilename };
    });
  },
);
