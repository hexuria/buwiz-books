import { describe, it, expect } from "vitest";
import { validateStatement, type ReconciliationContext } from "../../src/lib/statement-validator";
import type { ParsedStatementData } from "../../src/routes/api/-ai-statement-ocr";

// ============================================================================
// Helpers — build mock data with sensible defaults
// ============================================================================

function makeContext(overrides?: Partial<ReconciliationContext>): ReconciliationContext {
  return {
    organizationName: "Buwiz Platform Inc",
    periodStart: "2026-01-01",
    periodEnd: "2026-01-31",
    accountType: "checking",
    accountLastFour: "4321",
    accountName: "Mercury Checking ****4321",
    ...overrides,
  };
}

function makeParsedStatement(overrides?: {
  classification?: Partial<ParsedStatementData["classification"]>;
  metadata?: Partial<ParsedStatementData["metadata"]>;
  transactions?: ParsedStatementData["transactions"];
  totalPages?: number;
}): ParsedStatementData {
  const txns = overrides?.transactions ?? [
    { date: "2026-01-05", description: "Stripe deposit", amount: 1500.0 },
    { date: "2026-01-10", description: "AWS hosting", amount: -200.0 },
    { date: "2026-01-20", description: "Payroll", amount: -800.0 },
  ];

  // Default: beginning + txn sum = ending (balanced)
  const txnSum = txns.reduce((s, t) => s + t.amount, 0);

  return {
    classification: {
      isStatement: true,
      documentType: "bank_statement",
      confidence: 98,
      ...overrides?.classification,
    },
    metadata: {
      institutionName: "Mercury",
      accountHolderName: "Buwiz Platform Inc",
      accountType: "checking",
      accountNumberLast4: "4321",
      statementPeriodStart: "2026-01-01",
      statementPeriodEnd: "2026-01-31",
      beginningBalance: 10000.0,
      endingBalance: 10000.0 + txnSum,
      currency: "USD",
      ...overrides?.metadata,
    },
    transactions: txns,
    totalPages: overrides?.totalPages ?? 1,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe("Statement Validator", () => {
  // ── Happy Path ────────────────────────────────────────────────────────────

  it("should pass all checks for a fully valid statement", () => {
    const result = validateStatement(makeParsedStatement(), makeContext());

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);

    // Verify each check passed
    const checkNames = result.checks.map((c) => c.check);
    expect(checkNames).toContain("document_type");
    expect(checkNames).toContain("organization_name");
    expect(checkNames).toContain("account_type");
    expect(checkNames).toContain("account_last_four");
    expect(checkNames).toContain("date_range");
    expect(checkNames).toContain("balance_integrity");
    expect(checkNames).toContain("transaction_count");

    for (const check of result.checks) {
      expect(check.passed).toBe(true);
    }
  });

  // ── Document Classification ───────────────────────────────────────────────

  it("should reject a non-statement document immediately", () => {
    const parsed = makeParsedStatement({
      classification: {
        isStatement: false,
        documentType: "receipt",
        confidence: 92,
        rejectionReason: "This appears to be a restaurant receipt",
      },
    });

    const result = validateStatement(parsed, makeContext());

    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("Not a financial statement");

    // Early exit — only the document_type check should be present
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0].check).toBe("document_type");
  });

  // ── Organization Name Fuzzy Matching ──────────────────────────────────────

  it("should pass org name check with partial containment", () => {
    // "Buwiz Platform" is contained in "Buwiz Platform Inc"
    const parsed = makeParsedStatement({
      metadata: { accountHolderName: "Buwiz Platform" },
    });

    const result = validateStatement(parsed, makeContext());
    const orgCheck = result.checks.find((c) => c.check === "organization_name");
    expect(orgCheck).toBeDefined();
    expect(orgCheck!.passed).toBe(true);
  });

  it("should warn on low-similarity org name", () => {
    const parsed = makeParsedStatement({
      metadata: { accountHolderName: "Totally Different Corp" },
    });

    const result = validateStatement(parsed, makeContext());
    const orgCheck = result.checks.find((c) => c.check === "organization_name");
    expect(orgCheck).toBeDefined();
    expect(orgCheck!.passed).toBe(false);
  });

  // ── Account Type Normalization ────────────────────────────────────────────

  it("should normalize 'DDA' to 'checking'", () => {
    const parsed = makeParsedStatement({
      metadata: { accountType: "DDA" },
    });

    const result = validateStatement(parsed, makeContext({ accountType: "checking" }));
    const typeCheck = result.checks.find((c) => c.check === "account_type");
    expect(typeCheck).toBeDefined();
    expect(typeCheck!.passed).toBe(true);
  });

  it("should normalize 'Visa' to 'credit_card'", () => {
    const parsed = makeParsedStatement({
      metadata: { accountType: "Visa" },
    });

    const result = validateStatement(parsed, makeContext({ accountType: "credit_card" }));
    const typeCheck = result.checks.find((c) => c.check === "account_type");
    expect(typeCheck).toBeDefined();
    expect(typeCheck!.passed).toBe(true);
  });

  it("should fail for mismatched account types", () => {
    const parsed = makeParsedStatement({
      metadata: { accountType: "savings" },
    });

    const result = validateStatement(parsed, makeContext({ accountType: "checking" }));
    const typeCheck = result.checks.find((c) => c.check === "account_type");
    expect(typeCheck).toBeDefined();
    expect(typeCheck!.passed).toBe(false);
    expect(typeCheck!.severity).toBe("warning");
  });

  // ── Account Number Last 4 ────────────────────────────────────────────────

  it("should fail when last 4 digits do not match", () => {
    const parsed = makeParsedStatement({
      metadata: { accountNumberLast4: "9999" },
    });

    const result = validateStatement(parsed, makeContext());
    const last4Check = result.checks.find((c) => c.check === "account_last_four");
    expect(last4Check).toBeDefined();
    expect(last4Check!.passed).toBe(false);
    expect(last4Check!.severity).toBe("error");
    expect(result.valid).toBe(false);
  });

  // ── Date Range Validation ─────────────────────────────────────────────────

  it("should pass with exact date range match", () => {
    const result = validateStatement(makeParsedStatement(), makeContext());
    const dateCheck = result.checks.find((c) => c.check === "date_range");
    expect(dateCheck).toBeDefined();
    expect(dateCheck!.passed).toBe(true);
  });

  it("should pass with partial date overlap (warning)", () => {
    // Statement covers Jan 15-Feb 15, reconciliation covers Jan 1-Jan 31
    const parsed = makeParsedStatement({
      metadata: {
        statementPeriodStart: "2026-01-15",
        statementPeriodEnd: "2026-02-15",
      },
    });

    const result = validateStatement(parsed, makeContext());
    const dateCheck = result.checks.find((c) => c.check === "date_range");
    expect(dateCheck).toBeDefined();
    expect(dateCheck!.passed).toBe(true);
    expect(dateCheck!.severity).toBe("warning"); // Overlap but not exact
  });

  it("should fail with no date range overlap", () => {
    // Statement covers Mar 1-Mar 31, reconciliation covers Jan 1-Jan 31
    const parsed = makeParsedStatement({
      metadata: {
        statementPeriodStart: "2026-03-01",
        statementPeriodEnd: "2026-03-31",
      },
    });

    const result = validateStatement(parsed, makeContext());
    const dateCheck = result.checks.find((c) => c.check === "date_range");
    expect(dateCheck).toBeDefined();
    expect(dateCheck!.passed).toBe(false);
    expect(dateCheck!.severity).toBe("error");
    expect(result.valid).toBe(false);
  });

  // ── Balance Integrity ─────────────────────────────────────────────────────

  it("should pass balance check when off by less than $0.02 (rounding)", () => {
    // Default: beginning=10000, txnSum=500, so ending should be 10500
    // Set ending to 10500.01 — within tolerance
    const txns = [{ date: "2026-01-05", description: "Deposit", amount: 500.0 }];
    const parsed = makeParsedStatement({
      transactions: txns,
      metadata: {
        beginningBalance: 10000.0,
        endingBalance: 10500.01, // Off by $0.01
      },
    });

    const result = validateStatement(parsed, makeContext());
    const balCheck = result.checks.find((c) => c.check === "balance_integrity");
    expect(balCheck).toBeDefined();
    expect(balCheck!.passed).toBe(true);
  });

  it("should warn on balance discrepancy greater than $0.02", () => {
    const txns = [{ date: "2026-01-05", description: "Deposit", amount: 500.0 }];
    const parsed = makeParsedStatement({
      transactions: txns,
      metadata: {
        beginningBalance: 10000.0,
        endingBalance: 10501.0, // Off by $1.00
      },
    });

    const result = validateStatement(parsed, makeContext());
    const balCheck = result.checks.find((c) => c.check === "balance_integrity");
    expect(balCheck).toBeDefined();
    expect(balCheck!.passed).toBe(false);
    expect(balCheck!.severity).toBe("warning");
  });

  // ── Empty Transactions ────────────────────────────────────────────────────

  it("should fail when zero transactions are extracted", () => {
    const parsed = makeParsedStatement({
      transactions: [],
      metadata: {
        beginningBalance: 10000.0,
        endingBalance: 10000.0, // No txns → balances match
      },
    });

    const result = validateStatement(parsed, makeContext());
    const txnCheck = result.checks.find((c) => c.check === "transaction_count");
    expect(txnCheck).toBeDefined();
    expect(txnCheck!.passed).toBe(false);
    expect(txnCheck!.severity).toBe("error");
    expect(result.valid).toBe(false);
  });
});
