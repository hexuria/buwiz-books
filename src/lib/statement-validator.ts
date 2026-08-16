// ============================================================================
// Statement Validator — Validates uploaded bank statements against reconciliation
// Checks: document type, org name, account type, last 4 digits, date range, balances
// ============================================================================

import type { ParsedStatementData } from "../routes/api/-ai-statement-ocr";

// ============================================================================
// Types
// ============================================================================

export interface ReconciliationContext {
  organizationName: string;
  periodStart: string; // YYYY-MM-DD
  periodEnd: string; // YYYY-MM-DD
  accountType: string; // "checking" | "savings" | "credit_card" etc.
  accountLastFour: string; // Last 4 digits
  accountName: string; // e.g. "Mercury Checking ****1234"
}

export interface ValidationCheck {
  check: string;
  passed: boolean;
  expected?: string;
  actual?: string;
  severity: "error" | "warning" | "info";
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  checks: ValidationCheck[];
  errors: string[];
  warnings: string[];
}

// ============================================================================
// Validation
// ============================================================================

/**
 * Validate an AI-parsed statement against the reconciliation context.
 * Returns a structured result with pass/fail for each check.
 */
export function validateStatement(
  parsed: ParsedStatementData,
  context: ReconciliationContext,
): ValidationResult {
  const checks: ValidationCheck[] = [];

  // ── Check 1: Document Classification ────────────────────────────────────
  const isStatement = parsed.classification.isStatement;
  checks.push({
    check: "document_type",
    passed: isStatement,
    expected: "bank_statement or credit_card_statement",
    actual: parsed.classification.documentType,
    severity: "error",
    message: isStatement
      ? `Document classified as ${parsed.classification.documentType} (${parsed.classification.confidence}% confidence)`
      : `Not a financial statement: ${parsed.classification.rejectionReason || parsed.classification.documentType}`,
  });

  // If not a statement, skip remaining checks
  if (!isStatement) {
    return {
      valid: false,
      checks,
      errors: checks.filter((c) => !c.passed && c.severity === "error").map((c) => c.message),
      warnings: checks.filter((c) => !c.passed && c.severity === "warning").map((c) => c.message),
    };
  }

  // ── Check 2: Organization Name ──────────────────────────────────────────
  const orgMatch = fuzzyMatch(parsed.metadata.accountHolderName, context.organizationName);
  checks.push({
    check: "organization_name",
    passed: orgMatch >= 0.6,
    expected: context.organizationName,
    actual: parsed.metadata.accountHolderName,
    severity: orgMatch >= 0.4 ? "warning" : "error",
    message:
      orgMatch >= 0.6
        ? `Organization name matches: "${parsed.metadata.accountHolderName}"`
        : `Organization name mismatch: expected "${context.organizationName}", found "${parsed.metadata.accountHolderName}"`,
  });

  // ── Check 3: Account Type ──────────────────────────────────────────────
  const typeMatch =
    normalizeAccountType(parsed.metadata.accountType) === normalizeAccountType(context.accountType);
  checks.push({
    check: "account_type",
    passed: typeMatch,
    expected: context.accountType,
    actual: parsed.metadata.accountType,
    severity: "warning",
    message: typeMatch
      ? `Account type matches: ${parsed.metadata.accountType}`
      : `Account type mismatch: expected "${context.accountType}", found "${parsed.metadata.accountType}"`,
  });

  // ── Check 4: Account Number Last 4 ─────────────────────────────────────
  const last4Match = parsed.metadata.accountNumberLast4 === context.accountLastFour;
  checks.push({
    check: "account_last_four",
    passed: last4Match,
    expected: context.accountLastFour,
    actual: parsed.metadata.accountNumberLast4,
    severity: "error",
    message: last4Match
      ? `Account number matches: ****${parsed.metadata.accountNumberLast4}`
      : `Account number mismatch: expected ****${context.accountLastFour}, found ****${parsed.metadata.accountNumberLast4}`,
  });

  // ── Check 5: Date Range Overlap ─────────────────────────────────────────
  const stmtStart = new Date(parsed.metadata.statementPeriodStart);
  const stmtEnd = new Date(parsed.metadata.statementPeriodEnd);
  const reconStart = new Date(context.periodStart);
  const reconEnd = new Date(context.periodEnd);

  const hasOverlap = stmtStart <= reconEnd && stmtEnd >= reconStart;
  const isExactMatch =
    parsed.metadata.statementPeriodStart === context.periodStart &&
    parsed.metadata.statementPeriodEnd === context.periodEnd;

  checks.push({
    check: "date_range",
    passed: hasOverlap,
    expected: `${context.periodStart} to ${context.periodEnd}`,
    actual: `${parsed.metadata.statementPeriodStart} to ${parsed.metadata.statementPeriodEnd}`,
    severity: hasOverlap ? (isExactMatch ? "info" : "warning") : "error",
    message: isExactMatch
      ? `Statement period exactly matches reconciliation period`
      : hasOverlap
        ? `Statement period overlaps reconciliation (statement: ${parsed.metadata.statementPeriodStart} to ${parsed.metadata.statementPeriodEnd})`
        : `Statement period does not overlap reconciliation period`,
  });

  // ── Check 6: Balance Sanity ─────────────────────────────────────────────
  const txnSum = parsed.transactions.reduce((sum, t) => sum + t.amount, 0);
  const expectedEnd = parsed.metadata.beginningBalance + txnSum;
  const balanceDiff = Math.abs(expectedEnd - parsed.metadata.endingBalance);
  const balancesMatch = balanceDiff < 0.02; // Allow for rounding

  checks.push({
    check: "balance_integrity",
    passed: balancesMatch,
    expected: `Beginning (${parsed.metadata.beginningBalance}) + Transactions (${txnSum.toFixed(2)}) = ${expectedEnd.toFixed(2)}`,
    actual: `Ending balance: ${parsed.metadata.endingBalance}`,
    severity: balancesMatch ? "info" : "warning",
    message: balancesMatch
      ? `Balance check passes: beginning + transactions = ending balance`
      : `Balance discrepancy: expected ending ${expectedEnd.toFixed(2)}, statement shows ${parsed.metadata.endingBalance} (diff: ${balanceDiff.toFixed(2)})`,
  });

  // ── Check 7: Transaction Count ──────────────────────────────────────────
  const txnCount = parsed.transactions.length;
  checks.push({
    check: "transaction_count",
    passed: txnCount > 0,
    expected: "> 0 transactions",
    actual: `${txnCount} transactions extracted`,
    severity: txnCount === 0 ? "error" : "info",
    message:
      txnCount > 0
        ? `Extracted ${txnCount} transactions from statement`
        : `No transactions found on the statement`,
  });

  // Compile result
  const errors = checks.filter((c) => !c.passed && c.severity === "error").map((c) => c.message);
  const warnings = checks
    .filter((c) => !c.passed && c.severity === "warning")
    .map((c) => c.message);

  return {
    valid: errors.length === 0,
    checks,
    errors,
    warnings,
  };
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Fuzzy string similarity (Sørensen–Dice coefficient).
 * Returns 0-1 where 1 = exact match.
 */
function fuzzyMatch(a: string, b: string): number {
  const normalize = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  const na = normalize(a);
  const nb = normalize(b);

  if (na === nb) return 1;
  if (na.length < 2 || nb.length < 2) return 0;

  // Check containment (one contains the other)
  if (na.includes(nb) || nb.includes(na)) return 0.85;

  // Bigram similarity
  const bigramsA = new Set<string>();
  for (let i = 0; i < na.length - 1; i++) {
    bigramsA.add(na.slice(i, i + 2));
  }

  const bigramsB = new Set<string>();
  let intersection = 0;
  for (let i = 0; i < nb.length - 1; i++) {
    const bigram = nb.slice(i, i + 2);
    bigramsB.add(bigram);
    if (bigramsA.has(bigram)) intersection++;
  }

  return (2 * intersection) / (bigramsA.size + bigramsB.size);
}

/**
 * Normalize account type strings for comparison.
 */
function normalizeAccountType(type: string): string {
  const t = type.toLowerCase().replace(/[_\s-]/g, "");
  if (t.includes("check") || t === "dda") return "checking";
  if (t.includes("saving")) return "savings";
  if (t.includes("credit") || t.includes("visa") || t.includes("mastercard")) return "credit_card";
  if (t.includes("money") || t.includes("market")) return "money_market";
  return t;
}
