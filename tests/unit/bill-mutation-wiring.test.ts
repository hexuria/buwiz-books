import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertBillFinanciallyEditable,
  deriveBillBalanceDue,
} from "../../src/lib/bill-mutation-guards";

/**
 * Audit PR-13 — the pure halves of the bill mutation guards, plus wiring
 * asserts that the server functions actually call them.
 *
 * The exploit the editability guard closes: pay a bill partially, then raise
 * its amount — updateBill recomputed balanceDue from the client value with
 * float math and no posting check, silently detaching the bill from its A/P
 * accrual.
 */
describe("bill financial editability", () => {
  const draft = { journalHeaderId: null, status: "in_review", amountPaid: "0" };

  it("a clean unposted bill is editable", () => {
    expect(() => assertBillFinanciallyEditable(draft)).not.toThrow();
    expect(() => assertBillFinanciallyEditable({ ...draft, amountPaid: null })).not.toThrow();
  });

  it("a posted accrual freezes the amount — amend, don't edit", () => {
    expect(() =>
      assertBillFinanciallyEditable({
        ...draft,
        journalHeaderId: "9d5b0000-0000-4000-8000-000000000001",
      }),
    ).toThrow(/amend/i);
  });

  it("recorded payments freeze the amount — the partial-payment exploit", () => {
    expect(() =>
      assertBillFinanciallyEditable({ ...draft, status: "partial", amountPaid: "40.00" }),
    ).toThrow(/recorded payments/i);
  });

  it("a voided bill is never editable", () => {
    expect(() => assertBillFinanciallyEditable({ ...draft, status: "voided" })).toThrow(/voided/i);
  });
});

describe("derived balance due", () => {
  it("is exact cents arithmetic, not float", () => {
    expect(deriveBillBalanceDue("100.10", "0.03")).toBe("100.07");
    expect(deriveBillBalanceDue("0.30", "0.10")).toBe("0.20");
  });

  it("floors at zero on overpayment", () => {
    expect(deriveBillBalanceDue("100.00", "150.00")).toBe("0.00");
  });

  it("treats a null amountPaid as zero", () => {
    expect(deriveBillBalanceDue("55.55", null)).toBe("55.55");
  });
});

describe("bill mutation wiring", () => {
  const source = readFileSync(join(__dirname, "../..", "src/routes/api/-bills.ts"), "utf-8");

  it("createBill validates references before persisting", () => {
    const createBlock = source.slice(
      source.indexOf("export const createBill"),
      source.indexOf("export const updateBill"),
    );
    expect(createBlock).toContain(
      "await assertBillReferences(db, orgId, parsed.vendorId, parsed.lineItems)",
    );
  });

  it("updateBill guards amount edits and derives balanceDue in cents", () => {
    const updateBlock = source.slice(
      source.indexOf("export const updateBill"),
      source.indexOf("export const transitionBillStatus"),
    );
    expect(updateBlock).toContain("assertBillFinanciallyEditable(existing)");
    expect(updateBlock).toContain("deriveBillBalanceDue(updates.amount, existing.amountPaid)");
    expect(updateBlock).not.toContain("Number.parseFloat");
  });

  it("saveBillLineItems refuses posted/paid bills, org-checks accounts, recomputes totals", () => {
    const saveBlock = source.slice(source.indexOf("export const saveBillLineItems"));
    expect(saveBlock).toContain("assertBillFinanciallyEditable(bill)");
    expect(saveBlock).toContain(
      "await assertBillReferences(db, orgId, undefined, parsed.lineItems)",
    );
    expect(saveBlock).toContain("deriveBillBalanceDue(totalAmount, bill.amountPaid)");
  });

  it("the AI upload resolves suggestions only against the expense-filtered list", () => {
    const store = readFileSync(join(__dirname, "../..", "src/lib/bill-upload-store.ts"), "utf-8");
    const resolveBlock = store.slice(store.indexOf("const expenseAccounts = accounts.filter"));
    expect(resolveBlock).toContain("expenseAccounts.find");
    // The unfiltered list must no longer serve suggestion matching.
    expect(resolveBlock).not.toContain(" accounts.find(");
  });
});
