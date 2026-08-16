/**
 * Accounts Import Server Functions
 * CSV import for Chart of Accounts template
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { accounts } from "../../db/schema/accounts";
import { eq, and } from "drizzle-orm";
import { withMutationPermissionOrgContext, withSessionOrgContext } from "../../lib/server-context";

// CSV row schema
export const csvRowSchema = z.object({
  categoryName: z.string().min(1, "Category Name is required"),
  categoryNumber: z.string().optional(),
  parentName: z.string().optional(),
  parentCategoryNumber: z.string().optional(),
  type: z.enum([
    "Bank",
    "Credit Card",
    "Assets",
    "Liabilities",
    "Equity",
    "Revenue",
    "Cost of Revenue",
    "Operating Expenses",
    "Other Income",
    "Other Expenses",
  ]),
  status: z.enum(["Active", "Deactivated", "Inactive", "Archived"]).optional(),
  description: z.string().optional(),
});

// Map CSV type to our enum
function mapCsvTypeToEnum(
  csvType: string,
):
  | "asset"
  | "liability"
  | "equity"
  | "revenue"
  | "expense"
  | "cost_of_revenue"
  | "other_income"
  | "other_expense" {
  const mapping: Record<string, ReturnType<typeof mapCsvTypeToEnum>> = {
    Bank: "asset",
    "Credit Card": "liability",
    Assets: "asset",
    Liabilities: "liability",
    Equity: "equity",
    Revenue: "revenue",
    "Cost of Revenue": "cost_of_revenue",
    "Operating Expenses": "expense",
    "Other Income": "other_income",
    "Other Expenses": "other_expense",
  };
  return mapping[csvType] || "asset";
}

// Map CSV status to our enum
function mapCsvStatusToEnum(
  csvStatus?: string,
): "active" | "inactive" | "deactivated" | "archived" {
  if (!csvStatus) return "active";
  return csvStatus.toLowerCase() as ReturnType<typeof mapCsvStatusToEnum>;
}

// Parse a single CSV line respecting quoted fields
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

// Parse CSV content
function parseCSV(content: string): Record<string, string>[] {
  const lines = content.split("\n").filter((line) => line.trim());
  if (lines.length < 2) return [];

  // Get headers from first line
  const headers = parseCsvLine(lines[0]);

  // Parse remaining rows
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

// Validate and transform CSV rows
const validateCsvImportSchema = z.object({ content: z.string() });

export const validateCsvImport = createServerFn({ method: "POST" })
  .inputValidator((data: z.input<typeof validateCsvImportSchema>) =>
    validateCsvImportSchema.parse(data),
  )
  .handler(async ({ data: rawData }: { data: unknown }) => {
    // Session-gated even though it touches no table: this parses arbitrary
    // caller-supplied CSV and must not be reachable unauthenticated.
    return withSessionOrgContext(async () => {
      const parsed = validateCsvImportSchema.parse(rawData);
      const rows = parseCSV(parsed.content);

      const validated: Array<{
        row: number;
        valid: boolean;
        data?: z.infer<typeof csvRowSchema>;
        errors?: string[];
      }> = [];

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];

        // Map CSV column names to our schema
        const mapped = {
          categoryName: row["Category Name"] || row["categoryName"] || "",
          categoryNumber: row["Category Number"] || row["categoryNumber"],
          parentName: row["Parent Name"] || row["parentName"],
          parentCategoryNumber: row["Parent Category Number"] || row["parentCategoryNumber"],
          type: row["Type"] || row["type"] || "Assets",
          status: row["Status"] || row["status"],
          description: row["Description"] || row["description"],
        };

        const result = csvRowSchema.safeParse(mapped);

        if (result.success) {
          validated.push({ row: i + 1, valid: true, data: result.data });
        } else {
          validated.push({
            row: i + 1,
            valid: false,
            errors: result.error.issues.map((e) => `${String(e.path.join("."))}: ${e.message}`),
          });
        }
      }

      return {
        total: rows.length,
        valid: validated.filter((v) => v.valid).length,
        invalid: validated.filter((v) => !v.valid).length,
        rows: validated,
      };
    });
  });

// Import categories from validated CSV
const importCategoriesSchema = z.object({ rows: z.array(csvRowSchema) });

export const importCategories = createServerFn({ method: "POST" })
  .inputValidator((data: z.input<typeof importCategoriesSchema>) =>
    importCategoriesSchema.parse(data),
  )
  .handler(async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "organization",
      "update",
      { routeKey: "accounts:import-categories", limit: 10, windowMs: 300_000 },
      async ({ orgId, db }) => {
        const parsed = importCategoriesSchema.parse(rawData);

        const results: Array<{
          name: string;
          success: boolean;
          id?: string;
          error?: string;
        }> = [];

        // First pass: create all categories without parents
        const categoryMap = new Map<string, string>(); // name -> id

        for (const row of parsed.rows) {
          try {
            // Check for existing category by account number within same org
            // This matches the composite unique constraint (org_id, account_number)
            const existing = row.categoryNumber
              ? await db
                  .select()
                  .from(accounts)
                  .where(
                    and(
                      eq(accounts.accountNumber, row.categoryNumber),
                      eq(accounts.organizationId, orgId),
                    ),
                  )
                  .limit(1)
              : await db
                  .select()
                  .from(accounts)
                  .where(
                    and(eq(accounts.name, row.categoryName), eq(accounts.organizationId, orgId)),
                  )
                  .limit(1);

            if (existing.length > 0) {
              categoryMap.set(row.categoryName, existing[0].id);
              results.push({
                name: row.categoryName,
                success: true,
                id: existing[0].id,
                error: "Already exists (skipped)",
              });
              continue;
            }

            // Create new category
            const [created] = await db
              .insert(accounts)
              .values({
                organizationId: orgId,
                name: row.categoryName,
                accountNumber: row.categoryNumber || undefined,
                accountType: mapCsvTypeToEnum(row.type),
                status: mapCsvStatusToEnum(row.status),
                isActive: row.status !== "Deactivated" && row.status !== "Archived",
                description: row.description || undefined,
              })
              .returning({ id: accounts.id });

            categoryMap.set(row.categoryName, created.id);
            results.push({ name: row.categoryName, success: true, id: created.id });
          } catch (error) {
            results.push({
              name: row.categoryName,
              success: false,
              error: error instanceof Error ? error.message : "Unknown error",
            });
          }
        }

        // Second pass: update parent relationships
        for (const row of parsed.rows) {
          if (!row.parentName) continue;

          const categoryId = categoryMap.get(row.categoryName);
          if (!categoryId) continue;

          // Find parent by name within the same org
          const parents = await db
            .select()
            .from(accounts)
            .where(and(eq(accounts.name, row.parentName), eq(accounts.organizationId, orgId)))
            .limit(10);

          let parentId: string | undefined;
          if (parents.length === 1) {
            parentId = parents[0].id;
          } else if (parents.length > 1 && row.parentCategoryNumber) {
            // Disambiguate by number
            const match = parents.find((p) => p.accountNumber === row.parentCategoryNumber);
            parentId = match?.id;
          }

          if (parentId) {
            await db.update(accounts).set({ parentId }).where(eq(accounts.id, categoryId));
          }
        }

        return {
          imported: results.filter((r) => r.success && !r.error?.includes("skipped")).length,
          skipped: results.filter((r) => r.error?.includes("skipped")).length,
          failed: results.filter((r) => !r.success).length,
          results,
        };
      },
    );
  });
