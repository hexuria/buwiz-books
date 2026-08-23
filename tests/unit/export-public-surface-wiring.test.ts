import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { escapeHtml } from "../../src/services/email";

/**
 * Audit PR-16 — the financial-package export, the public invoice surface,
 * and the export/import fold-ins. The sheet builders live inline in server
 * functions, so the load-bearing shapes are pinned wiring-style (the repo's
 * lint substitute) and the one extracted primitive is tested directly.
 */
describe("email HTML escaping", () => {
  it("neutralizes markup in user-controlled values", () => {
    expect(escapeHtml('<img src=x onerror="alert(1)">')).toBe(
      "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;",
    );
    expect(escapeHtml("Fish & Chips <Co>")).toBe("Fish &amp; Chips &lt;Co&gt;");
    expect(escapeHtml(null)).toBe("");
    expect(escapeHtml(undefined)).toBe("");
  });

  it("every dynamic field in both email HTML bodies goes through escapeHtml", () => {
    const source = readFileSync(join(__dirname, "../..", "src/services/email.ts"), "utf-8");
    // Scope to the HTML template literals — plain-text fields like the SMTP
    // from header legitimately interpolate raw values.
    const htmlBodies = source.match(/const htmlBody = `[\s\S]*?`;/g) ?? [];
    expect(htmlBodies.length).toBe(2);
    const html = htmlBodies.join("\n");
    for (const raw of [
      "${data.fromCompany}",
      "${data.invoiceNumber}",
      "${data.customerName}",
      "${data.memo}",
      "${data.workspaceName}",
      "${data.inviterName}",
      "${data.joinUrl}",
      "${amount}",
    ]) {
      expect(html, `unescaped ${raw} in an email HTML body`).not.toContain(raw);
    }
    expect(html.match(/escapeHtml\(/g)!.length).toBeGreaterThanOrEqual(12);
  });
});

describe("financial package export wiring", () => {
  const source = readFileSync(
    join(__dirname, "../..", "src/routes/api/-export-transactions.ts"),
    "utf-8",
  );

  it("the retained-earnings plug lands on the correct side and inside the totals", () => {
    expect(source).toContain("const rePlugDebitCents = reCents < 0 ? -reCents : 0;");
    expect(source).toContain("const rePlugCreditCents = reCents > 0 ? reCents : 0;");
    expect(source).toContain("cell(tb.totalDebit + rePlugDebitCents / 100");
    expect(source).toContain("cell(tb.totalCredit + rePlugCreditCents / 100");
    // The no-op plug (`? 0 : 0`) must never return.
    expect(source).not.toContain("? 0 : 0");
  });

  it("the balance sheet stops claiming a current/non-current split it does not compute", () => {
    expect(source).not.toContain('"   Current " + label');
    expect(source).not.toContain("Total Current Assets");
    expect(source).not.toContain("Total Current Liabilities");
  });

  it("NET OTHER INCOME nets both components and the undefined00 fallback is fixed", () => {
    expect(source).toContain("Math.round((pl.otherIncome?.total ?? 0) * 100)");
    expect(source).toContain("Math.round((pl.otherExpenses?.total ?? 0) * 100)");
    expect(source).toContain(
      'firstExpenseNumber ? firstExpenseNumber.slice(0, 3) + "00" : "60000"',
    );
    expect(source).not.toContain('+ "00" || "60000"');
  });

  it("the cash flow renders the unclassified section and real opening cash", () => {
    expect(source).toContain("UNCLASSIFIED (REVIEW SUBTYPES)");
    expect(source).toContain('acct.subtype === "bank_accounts"');
    expect(source).toContain("cell(openingCashCents / 100");
    expect(source).toContain("cell((openingCashCents + netChangeCents) / 100");
  });
});

describe("public invoice surface wiring", () => {
  const source = readFileSync(
    join(__dirname, "../..", "src/routes/api/-public-invoice.ts"),
    "utf-8",
  );

  it("drafts are indistinguishable from missing; voided invoices never show a due amount", () => {
    expect(source).toContain('if (invoice.status === "draft") return null;');
    expect(source).toContain('invoice.status === "voided" ? "0.00" : String(invoice.balanceDue)');
  });
});

describe("export/import fold-ins", () => {
  const source = readFileSync(
    join(__dirname, "../..", "src/routes/api/-export-import.ts"),
    "utf-8",
  );

  it("number sequences export by scope SUFFIX — the old prefix filter matched nothing", () => {
    expect(source).toContain("const orgSuffix = `:${orgId}`;");
    expect(source).toContain("r.scope.endsWith(orgSuffix)");
    expect(source).not.toContain("r.scope.startsWith(orgId)");
  });

  it("validateImport requires an authenticated org session", () => {
    const block = source.slice(
      source.indexOf("export const validateImport"),
      source.indexOf("// Execute Import"),
    );
    expect(block).toContain("withSessionOrgContext(");
  });
});

describe("export/import fidelity wiring (P4)", () => {
  const source = readFileSync(
    join(__dirname, "../..", "src/routes/api/-export-import.ts"),
    "utf-8",
  );

  it("executeImport enforces the row schemas — validation is no longer advisory", () => {
    const block = source.slice(source.indexOf("export const executeImport"));
    expect(block).toContain("const rowSchema = getRowSchema(entityType)");
    expect(block).toContain("rowSchema.safeParse(raw)");
    expect(block).toMatch(/Row \$\{index \+ 1\}/);
  });

  it("banks round-trip the ledger link as a resolvable pair, never a raw uuid", () => {
    const exportBlock = source.slice(
      source.indexOf('case "banks"'),
      source.indexOf('case "vendors"'),
    );
    expect(exportBlock).toContain("ledgerAccountNumber: accounts.accountNumber");
    expect(exportBlock).not.toContain("ledgerAccountId: financialAccounts.ledgerAccountId");
    const importBlock = source.slice(source.indexOf("export const executeImport"));
    expect(importBlock).toContain("ledgerAccountId: await resolveAccountRef(");
    expect(importBlock).toContain("defaultAccountId: await resolveAccountRef(");
  });

  it("party and bank exports carry the fields the importers accept", () => {
    for (const field of [
      "swiftCode: financialAccounts.swiftCode",
      "iban: financialAccounts.iban",
      "defaultAccountNumber: accounts.accountNumber",
      "creditLimit: parties.creditLimit",
    ]) {
      expect(source).toContain(field);
    }
  });
});
