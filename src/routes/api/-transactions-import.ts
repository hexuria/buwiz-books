/**
 * Transactions CSV Import Server Functions
 * Import bank transactions and journal entries from CSV files
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { accounts } from "../../db/schema/accounts";
import { dimensions } from "../../db/schema/dimensions";
import { parties } from "../../db/schema/parties";
import { eq, and } from "drizzle-orm";
import { withMutationPermissionOrgContext } from "../../lib/server-context";
import { createTransactionCandidate } from "../../lib/inbox/service";
import { centsToMoney, moneyToCents } from "../../lib/money";
import { bankCsvSourceId, hashCsvFileContent, journalCsvSourceId } from "../../lib/csv-idempotency";
import { resolveMappedAccountId } from "../../lib/coa/resolve-mapped-account";

// ============================================================================
// CSV Parsing Utilities (shared with -accounts-import.server.ts)
// ============================================================================

/** Parse a single CSV line respecting quoted fields */
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && i + 1 < line.length && line[i + 1] === '"') {
        current += '"';
        i++; // skip escaped quote
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      fields.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current.trim());
  return fields;
}

/** Parse CSV text into array of key-value records */
function parseCSV(content: string): Record<string, string>[] {
  const lines = content.split("\n").filter((line) => line.trim());
  if (lines.length < 2) return [];

  const headers = parseCsvLine(lines[0]);
  const rows: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const values = parseCsvLine(lines[i]);
    const row: Record<string, string> = {};
    headers.forEach((header, index) => {
      row[header] = values[index] || "";
    });
    rows.push(row);
  }
  return rows;
}

// ============================================================================
// Bank Transaction CSV
// ============================================================================

const bankRowSchema = z.object({
  date: z.string().min(1, "Date is required"),
  amount: z.string().min(1, "Amount is required"),
  description: z.string().min(1, "Description is required"),
  department: z.string().optional(),
  location: z.string().optional(),
});

export type BankCsvRow = z.infer<typeof bankRowSchema>;

export type ValidatedBankRow = {
  row: number;
  valid: boolean;
  data?: BankCsvRow;
  errors?: string[];
};

const validateBankTransactionCsvSchema = z.object({
  content: z.string(),
  sourceContent: z.string(),
});

const importBankTransactionsSchema = z.object({
  accountId: z.string().uuid(),
  fileHash: z.string().regex(/^[a-f0-9]{64}$/),
  rows: z.array(
    bankRowSchema.extend({
      sourceRow: z.number().int().positive(),
    }),
  ),
});

/** Parse a date string flexibly (MM/DD/YYYY, YYYY-MM-DD, M/D/YYYY, etc.) */
/**
 * Parse a CSV money field ($ and , tolerated) to INTEGER CENTS, or null when
 * it is not a valid amount. Audit PR-15: parseFloat let garbage through as
 * NaN (which passed the ===0 checks) and float sums drifted the group
 * balance check; every comparison below is now exact integer arithmetic.
 */
function csvMoneyCents(raw: string | null | undefined): number | null {
  if (!raw) return 0;
  const normalized = raw.replace(/[,$]/g, "").trim();
  if (normalized === "") return 0;
  if (!/^-?\d+(?:\.\d+)?$/.test(normalized)) return null;
  return moneyToCents(normalized, "amount");
}

function parseFlexibleDate(dateStr: string): string | null {
  // Try ISO format first (YYYY-MM-DD)
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return dateStr;
  }
  // Try MM/DD/YYYY or M/D/YYYY
  const slashMatch = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slashMatch) {
    const month = slashMatch[1].padStart(2, "0");
    const day = slashMatch[2].padStart(2, "0");
    return `${slashMatch[3]}-${month}-${day}`;
  }
  return null;
}

/**
 * Validate a bank transaction CSV file.
 * Returns validation results per row.
 */
export const validateBankTransactionCsv = createServerFn({ method: "POST" })
  .inputValidator((data: z.input<typeof validateBankTransactionCsvSchema>) =>
    validateBankTransactionCsvSchema.parse(data),
  )
  .handler(async ({ data: rawData }: { data: unknown }) => {
    const parsed = validateBankTransactionCsvSchema.parse(rawData);
    const rows = parseCSV(parsed.content);

    const validated: ValidatedBankRow[] = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const mapped = {
        date: row["Date"] || row["date"] || "",
        amount: row["Amount"] || row["amount"] || "",
        description: row["Description"] || row["description"] || "",
        department: row["Department"] || row["department"] || "",
        location: row["Location"] || row["location"] || "",
      };

      const result = bankRowSchema.safeParse(mapped);
      if (!result.success) {
        validated.push({
          row: i + 1,
          valid: false,
          errors: result.error.issues.map((e) => `${String(e.path.join("."))}: ${e.message}`),
        });
        continue;
      }

      // Validate date format
      const isoDate = parseFlexibleDate(result.data.date);
      if (!isoDate) {
        validated.push({
          row: i + 1,
          valid: false,
          errors: [`Invalid date format: "${result.data.date}". Use MM/DD/YYYY or YYYY-MM-DD.`],
        });
        continue;
      }

      // Validate amount is numeric
      const amountCents = csvMoneyCents(result.data.amount);
      if (amountCents === null || amountCents === 0) {
        validated.push({
          row: i + 1,
          valid: false,
          errors: [`Invalid amount: "${result.data.amount}". Must be a non-zero number.`],
        });
        continue;
      }

      validated.push({
        row: i + 1,
        valid: true,
        data: {
          ...result.data,
          date: isoDate,
          amount: centsToMoney(amountCents),
        },
      });
    }

    return {
      fileHash: hashCsvFileContent(parsed.sourceContent),
      total: rows.length,
      valid: validated.filter((v) => v.valid).length,
      invalid: validated.filter((v) => !v.valid).length,
      rows: validated,
    };
  });

/**
 * Import validated bank transactions into Inbox.
 * Each row becomes a pay_in (positive) or pay_out (negative) entry with:
 *   - Line 1: Selected bank/credit card account
 *   - Line 2: Uncategorized suspense account (for later re-categorization)
 */
export const importBankTransactions = createServerFn({ method: "POST" })
  .inputValidator((data: z.input<typeof importBankTransactionsSchema>) =>
    importBankTransactionsSchema.parse(data),
  )
  .handler(async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "inbox",
      "create",
      { routeKey: "transactions:import-bank", limit: 10, windowMs: 60_000 },
      async ({ orgId, userId, role, db }) => {
        const parsed = importBankTransactionsSchema.parse(rawData);

        const [selectedAccount] = await db
          .select({ id: accounts.id })
          .from(accounts)
          .where(
            and(
              eq(accounts.id, parsed.accountId),
              eq(accounts.organizationId, orgId),
              eq(accounts.isActive, true),
            ),
          )
          .limit(1);
        if (!selectedAccount) {
          throw new Error("The selected import account is unavailable for this organization");
        }

        // Look up the "Uncategorized Expenses" account as the default contra
        // Both fall through the same server-side chain as every other posting
        // path: the configured mapping first, then a deterministic subtype
        // match. Uncategorized expense is preferred; the asset bucket is the
        // fallback for orgs whose chart has no expense side yet.
        let contraAccountId =
          (await resolveMappedAccountId(db, orgId, "bill", "default_expense")) ?? undefined;
        if (!contraAccountId) {
          contraAccountId = (await resolveMappedAccountId(db, orgId, "bank", "other")) ?? undefined;
        }

        if (!contraAccountId) {
          throw new Error(
            "No uncategorized account found. Please create an Uncategorized Expenses or Uncategorized Assets category first.",
          );
        }

        // Pre-resolve dimension names (departments & locations)
        const dimensionRows = await db
          .select({ id: dimensions.id, name: dimensions.name, type: dimensions.dimensionType })
          .from(dimensions)
          .where(and(eq(dimensions.organizationId, orgId), eq(dimensions.isActive, true)));

        const deptMap = new Map<string, string>();
        const locMap = new Map<string, string>();
        for (const dim of dimensionRows) {
          if (dim.type === "department") deptMap.set(dim.name.toLowerCase(), dim.id);
          if (dim.type === "location") locMap.set(dim.name.toLowerCase(), dim.id);
        }

        const results: Array<{
          row: number;
          success: boolean;
          transactionNumber?: string;
          error?: string;
        }> = [];

        for (const row of parsed.rows) {
          try {
            const signedCents = csvMoneyCents(row.amount);
            if (signedCents === null || signedCents === 0) {
              throw new Error(`Invalid amount: "${row.amount}"`);
            }
            const amount = centsToMoney(Math.abs(signedCents));
            const isPayIn = signedCents > 0;
            const txnType = isPayIn ? "pay_in" : "pay_out";

            const isoDate = parseFlexibleDate(row.date) ?? row.date;
            const deptId = row.department ? deptMap.get(row.department.toLowerCase()) : undefined;
            const locId = row.location ? locMap.get(row.location.toLowerCase()) : undefined;
            const externalId = bankCsvSourceId(parsed.fileHash, row.sourceRow);
            const result = await createTransactionCandidate(
              { orgId, userId, role, db },
              {
                transactionDate: isoDate,
                transactionType: txnType,
                memo: row.description,
                sourceChannel: "csv",
                sourceProvider: "csv_bank_import",
                externalId,
                lines: [
                  {
                    accountId: parsed.accountId,
                    debit: isPayIn ? amount : null,
                    credit: isPayIn ? null : amount,
                    lineDescription: row.description,
                    departmentId: deptId ?? null,
                    locationId: locId ?? null,
                    sortOrder: 0,
                  },
                  {
                    accountId: contraAccountId,
                    debit: isPayIn ? null : amount,
                    credit: isPayIn ? amount : null,
                    lineDescription: row.description,
                    departmentId: deptId ?? null,
                    locationId: locId ?? null,
                    sortOrder: 1,
                  },
                ],
              },
            );
            results.push({
              row: row.sourceRow,
              success: true,
              transactionNumber: `Inbox ${result.inboxItem.id.slice(0, 8)}`,
            });
          } catch (error) {
            results.push({
              row: row.sourceRow,
              success: false,
              error: error instanceof Error ? error.message : "Unknown error",
            });
          }
        }

        return {
          imported: results.filter((r) => r.success).length,
          failed: results.filter((r) => !r.success).length,
          total: results.length,
          results,
        };
      },
    );
  });

// ============================================================================
// Journal Entry CSV
// ============================================================================

const journalRowSchema = z.object({
  referenceNumber: z.string().min(1, "Reference Number is required"),
  date: z.string().min(1, "Date is required"),
  categoryName: z.string().min(1, "Category Name is required"),
  categoryNumber: z.string().optional(),
  department: z.string().optional(),
  location: z.string().optional(),
  party: z.string().optional(),
  debitAmount: z.string().optional(),
  creditAmount: z.string().optional(),
  memo: z.string().optional(),
  description: z.string().optional(),
});

export type JournalCsvRow = z.infer<typeof journalRowSchema>;

export type ValidatedJournalGroup = {
  referenceNumber: string;
  groupOrdinal: number;
  valid: boolean;
  lineCount: number;
  totalDebits: number;
  totalCredits: number;
  errors?: string[];
  rows: JournalCsvRow[];
};

/**
 * Validate a journal entry CSV file.
 * Groups rows by Reference Number and checks debits = credits per group.
 */
const validateJournalEntryCsvSchema = z.object({
  content: z.string(),
  sourceContent: z.string(),
});

export const validateJournalEntryCsv = createServerFn({ method: "POST" })
  .inputValidator((data: z.input<typeof validateJournalEntryCsvSchema>) =>
    validateJournalEntryCsvSchema.parse(data),
  )
  .handler(async ({ data: rawData }: { data: unknown }) => {
    const parsed = validateJournalEntryCsvSchema.parse(rawData);
    const rows = parseCSV(parsed.content);

    // First, validate and parse each row
    const parsedRows: Array<{ row: number; data?: JournalCsvRow; errors?: string[] }> = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const mapped = {
        referenceNumber: row["Reference Number"] || row["referenceNumber"] || "",
        date: row["Date"] || row["date"] || "",
        categoryName: row["Category Name"] || row["categoryName"] || "",
        categoryNumber: row["Category Number"] || row["categoryNumber"] || "",
        department: row["Department"] || row["department"] || "",
        location: row["Location"] || row["location"] || "",
        party: row["Party"] || row["party"] || "",
        debitAmount: row["Debit Amount"] || row["debitAmount"] || "",
        creditAmount: row["Credit Amount"] || row["creditAmount"] || "",
        memo: row["Memo"] || row["memo"] || "",
        description: row["Description"] || row["description"] || "",
      };

      const result = journalRowSchema.safeParse(mapped);
      if (!result.success) {
        parsedRows.push({
          row: i + 1,
          errors: result.error.issues.map(
            (e) => `Row ${i + 1}: ${String(e.path.join("."))}: ${e.message}`,
          ),
        });
        continue;
      }

      // Validate date
      const isoDate = parseFlexibleDate(result.data.date);
      if (!isoDate) {
        parsedRows.push({
          row: i + 1,
          errors: [`Row ${i + 1}: Invalid date format "${result.data.date}"`],
        });
        continue;
      }

      // Validate the amounts. parseFloat used to turn garbage into NaN,
      // which passed the ===0 check and imported as a NaN line.
      const debitCents = csvMoneyCents(result.data.debitAmount);
      const creditCents = csvMoneyCents(result.data.creditAmount);
      if (debitCents === null || creditCents === null) {
        parsedRows.push({
          row: i + 1,
          errors: [`Row ${i + 1}: Invalid amount — debit and credit must be numeric`],
        });
        continue;
      }
      if (debitCents === 0 && creditCents === 0) {
        parsedRows.push({
          row: i + 1,
          errors: [`Row ${i + 1}: At least one of Debit Amount or Credit Amount must be non-zero`],
        });
        continue;
      }

      parsedRows.push({
        row: i + 1,
        data: { ...result.data, date: isoDate },
      });
    }

    // Group valid rows by Reference Number
    const groups = new Map<string, { rows: JournalCsvRow[]; groupOrdinal: number }>();
    const rowErrors: string[] = [];
    for (const pr of parsedRows) {
      if (pr.errors) {
        rowErrors.push(...pr.errors);
        continue;
      }
      if (!pr.data) continue;
      const existing = groups.get(pr.data.referenceNumber);
      if (existing) {
        existing.rows.push(pr.data);
      } else {
        groups.set(pr.data.referenceNumber, {
          rows: [pr.data],
          groupOrdinal: pr.row,
        });
      }
    }

    // Validate each group
    const validatedGroups: ValidatedJournalGroup[] = [];
    for (const [refNum, group] of groups) {
      const groupRows = group.rows;
      let totalDebitsCents = 0;
      let totalCreditsCents = 0;
      const groupErrors: string[] = [];

      for (const row of groupRows) {
        totalDebitsCents += csvMoneyCents(row.debitAmount) ?? 0;
        totalCreditsCents += csvMoneyCents(row.creditAmount) ?? 0;
      }

      if (groupRows.length < 2) {
        groupErrors.push(
          `Entry "${refNum}" has only ${groupRows.length} line(s). At least 2 are required.`,
        );
      }

      // Exact: balanced means the cents AGREE — the old float diff > 0.01
      // waved through one-cent imbalances. A bad group fails alone; the
      // other groups still import.
      if (totalDebitsCents !== totalCreditsCents) {
        const diffCents = Math.abs(totalDebitsCents - totalCreditsCents);
        groupErrors.push(
          `Entry "${refNum}" is unbalanced: Debits $${centsToMoney(totalDebitsCents)} ≠ Credits $${centsToMoney(totalCreditsCents)} (diff: $${centsToMoney(diffCents)})`,
        );
      }

      validatedGroups.push({
        referenceNumber: refNum,
        groupOrdinal: group.groupOrdinal,
        valid: groupErrors.length === 0,
        lineCount: groupRows.length,
        totalDebits: totalDebitsCents / 100,
        totalCredits: totalCreditsCents / 100,
        errors: groupErrors.length > 0 ? groupErrors : undefined,
        rows: groupRows,
      });
    }

    return {
      fileHash: hashCsvFileContent(parsed.sourceContent),
      totalRows: rows.length,
      totalGroups: validatedGroups.length,
      validGroups: validatedGroups.filter((g) => g.valid).length,
      invalidGroups: validatedGroups.filter((g) => !g.valid).length,
      rowErrors,
      groups: validatedGroups,
    };
  });

/**
 * Import validated journal entries into the ledger.
 * Each group (by Reference Number) becomes one journal_header + N journal_lines.
 */
const importJournalEntriesSchema = z.object({
  fileHash: z.string().regex(/^[a-f0-9]{64}$/),
  groups: z.array(
    z.object({
      referenceNumber: z.string(),
      groupOrdinal: z.number().int().positive(),
      rows: z.array(journalRowSchema),
    }),
  ),
});

export const importJournalEntries = createServerFn({ method: "POST" })
  .inputValidator((data: z.input<typeof importJournalEntriesSchema>) =>
    importJournalEntriesSchema.parse(data),
  )
  .handler(async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "inbox",
      "create",
      { routeKey: "transactions:import-journal", limit: 10, windowMs: 60_000 },
      async ({ orgId, userId, role, db }) => {
        const parsed = importJournalEntriesSchema.parse(rawData);

        // Pre-resolve lookups
        const [accountRows, dimensionRows, partyRows] = await Promise.all([
          db
            .select({
              id: accounts.id,
              name: accounts.name,
              accountNumber: accounts.accountNumber,
            })
            .from(accounts)
            .where(and(eq(accounts.organizationId, orgId), eq(accounts.isActive, true))),
          db
            .select({
              id: dimensions.id,
              name: dimensions.name,
              type: dimensions.dimensionType,
            })
            .from(dimensions)
            .where(and(eq(dimensions.organizationId, orgId), eq(dimensions.isActive, true))),
          db
            .select({ id: parties.id, name: parties.name })
            .from(parties)
            .where(and(eq(parties.organizationId, orgId), eq(parties.isActive, true))),
        ]);

        // Build lookup maps (case-insensitive)
        const accountByName = new Map<string, string>();
        const accountByNumber = new Map<string, string>();
        for (const acc of accountRows) {
          accountByName.set(acc.name.toLowerCase(), acc.id);
          if (acc.accountNumber) accountByNumber.set(acc.accountNumber, acc.id);
        }

        const deptMap = new Map<string, string>();
        const locMap = new Map<string, string>();
        for (const dim of dimensionRows) {
          if (dim.type === "department") deptMap.set(dim.name.toLowerCase(), dim.id);
          if (dim.type === "location") locMap.set(dim.name.toLowerCase(), dim.id);
        }

        const partyMap = new Map<string, string>();
        for (const p of partyRows) {
          partyMap.set(p.name.toLowerCase(), p.id);
        }

        const results: Array<{
          referenceNumber: string;
          success: boolean;
          transactionNumber?: string;
          error?: string;
        }> = [];

        for (const group of parsed.groups) {
          try {
            const firstRow = group.rows[0];
            const isoDate = parseFlexibleDate(firstRow.date) ?? firstRow.date;
            // Resolve party
            const partyId = firstRow.party ? partyMap.get(firstRow.party.toLowerCase()) : undefined;

            // Compute totals and reject unbalanced groups before posting.
            let totalDebitsCents = 0;
            let totalCreditsCents = 0;
            for (const row of group.rows) {
              totalDebitsCents += csvMoneyCents(row.debitAmount) ?? 0;
              totalCreditsCents += csvMoneyCents(row.creditAmount) ?? 0;
            }
            if (totalDebitsCents !== totalCreditsCents) {
              throw new Error(
                `Unbalanced entry: debits ${centsToMoney(totalDebitsCents)} ≠ credits ${centsToMoney(totalCreditsCents)}`,
              );
            }

            // Resolve every line before creating the header so a bad account cannot leave
            // behind an orphaned zero-line journal.
            const resolvedLines = group.rows.map((row, idx) => {
              // Resolve account by number first, then by name
              let accountId: string | undefined;
              if (row.categoryNumber) {
                accountId = accountByNumber.get(row.categoryNumber);
              }
              if (!accountId) {
                accountId = accountByName.get(row.categoryName.toLowerCase());
              }
              if (!accountId) {
                throw new Error(
                  `Account "${row.categoryName}"${row.categoryNumber ? ` (${row.categoryNumber})` : ""} not found`,
                );
              }

              const debitCents = csvMoneyCents(row.debitAmount) ?? 0;
              const creditCents = csvMoneyCents(row.creditAmount) ?? 0;

              return {
                accountId,
                debit: debitCents > 0 ? centsToMoney(debitCents) : null,
                credit: creditCents > 0 ? centsToMoney(creditCents) : null,
                lineDescription: row.description || row.memo || null,
                departmentId: row.department
                  ? (deptMap.get(row.department.toLowerCase()) ?? null)
                  : null,
                locationId: row.location ? (locMap.get(row.location.toLowerCase()) ?? null) : null,
                sortOrder: idx,
              };
            });

            const externalId = journalCsvSourceId(parsed.fileHash, group.groupOrdinal);
            const result = await createTransactionCandidate(
              { orgId, userId, role, db },
              {
                transactionDate: isoDate,
                transactionType: "journal",
                referenceNumber: group.referenceNumber,
                memo: firstRow.memo || firstRow.description || undefined,
                partyId: partyId ?? null,
                sourceChannel: "csv",
                sourceProvider: "csv_journal_import",
                externalId,
                lines: resolvedLines,
              },
            );

            results.push({
              referenceNumber: group.referenceNumber,
              success: true,
              transactionNumber: `Inbox ${result.inboxItem.id.slice(0, 8)}`,
            });
          } catch (error) {
            results.push({
              referenceNumber: group.referenceNumber,
              success: false,
              error: error instanceof Error ? error.message : "Unknown error",
            });
          }
        }

        return {
          imported: results.filter((r) => r.success).length,
          failed: results.filter((r) => !r.success).length,
          total: results.length,
          results,
        };
      },
    );
  });
