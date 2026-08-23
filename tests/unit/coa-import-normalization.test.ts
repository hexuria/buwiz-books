import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  importedAccountActivity,
  inferImportSubtype,
} from "../../src/lib/coa/import-normalization";

/**
 * Audit PR-14, pure halves. Imported accounts used to land with NO subtype —
 * and report-calculations silently drops balance-sheet accounts whose
 * subtype is outside its cash-flow sets — plus a CSV "Inactive" row imported
 * as status=inactive but isActive=TRUE.
 */
describe("import subtype inference", () => {
  it("Bank and Credit Card name their subtype outright", () => {
    expect(inferImportSubtype("Bank", "asset")).toBe("bank_accounts");
    expect(inferImportSubtype("Credit Card", "liability")).toBe("credit_cards");
  });

  it("every other type gets its canonical bucket — never null", () => {
    expect(inferImportSubtype("Assets", "asset")).toBe("uncategorized_assets");
    expect(inferImportSubtype("Liabilities", "liability")).toBe("other_current_liabilities");
    expect(inferImportSubtype("Equity", "equity")).toBe("uncategorized_equity");
    expect(inferImportSubtype("Operating Expenses", "expense")).toBe("uncategorized_expenses");
    expect(inferImportSubtype("Revenue", "revenue")).toBe("uncategorized_income");
  });

  it("honors a legal explicit subtype and discards an illegal one", () => {
    expect(inferImportSubtype("Assets", "asset", "inventory")).toBe("inventory");
    // accounts_payable is a liability subtype — illegal on an asset.
    expect(inferImportSubtype("Assets", "asset", "accounts_payable")).toBe("uncategorized_assets");
  });
});

describe("imported account activity", () => {
  it("exactly one status means active", () => {
    expect(importedAccountActivity("active")).toBe(true);
    expect(importedAccountActivity("inactive")).toBe(false);
    expect(importedAccountActivity("deactivated")).toBe(false);
    expect(importedAccountActivity("archived")).toBe(false);
  });
});

describe("mapping and account guard wiring", () => {
  const read = (rel: string) => readFileSync(join(__dirname, "../..", rel), "utf-8");

  it("upsertCategoryMapping validates the assignment before writing", () => {
    const source = read("src/routes/api/-category-mappings.ts");
    expect(source).toContain(
      "await assertMappingTargetAssignable(db, orgId, mappingType, sourceKey, targetCategoryId)",
    );
  });

  it("deactivation and deletion refuse live mapping targets; parent moves are guarded", () => {
    const source = read("src/routes/api/-accounts.ts");
    expect(source).toContain('await assertNotMappingTarget(db, orgId, id, "deactivate")');
    expect(source).toContain('await assertNotMappingTarget(db, orgId, parsed.id, "delete")');
    expect(source).toContain(
      "await assertValidParentAssignment(db, orgId, id, updates.parentId, existing.accountType)",
    );
  });

  it("the CSV import infers subtypes, derives activity, and org-scopes the parent write", () => {
    const source = read("src/routes/api/-accounts-import.ts");
    expect(source).toContain("subtype: inferImportSubtype(row.type, accountType)");
    expect(source).toContain("isActive: importedAccountActivity(status)");
    const parentPass = source.slice(source.indexOf("Second pass"));
    expect(parentPass).toContain("p.accountType === childType");
    expect(parentPass).toContain("eq(accounts.organizationId, orgId)");
  });
});
