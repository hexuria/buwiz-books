import type { CandidateLineInput, CreateCandidateInput, ReviewFindingDraft } from "./types";
import { compareMoney, multiplyMoney, sumMoney } from "./money";
import { centsToMoney, moneyToCents } from "@/lib/money";

/** A stored decimal(20,8) amount as people read it: "75.00000000" → "75.00". */
function displayMoney(amount: string): string {
  try {
    return centsToMoney(moneyToCents(amount));
  } catch {
    return amount;
  }
}

/** Every rule key evaluateBookRules can emit. Re-evaluation resolves exactly these. */
export const BOOK_RULE_KEYS = [
  "uncategorized",
  "low_confidence_category",
  "missing_vendor",
  "missing_customer",
  "missing_department",
  "missing_location",
  "transaction_in_parent_category",
  "missing_receipt",
  "missing_invoice",
] as const;

export interface BookRuleAccount {
  id: string;
  accountType: string;
  subtype: string | null;
  childCount: number;
}

export interface BookRuleParty {
  id: string;
  partyType: string;
}

export interface BookRuleSettings {
  lowConfidenceThreshold: string;
  missingReceiptThreshold: string;
  missingReceiptCurrency: string;
  functionalCurrency: string;
}

export interface BookRuleDocument {
  id: string;
  documentType: string;
}

function isExpenseAccount(account: BookRuleAccount | undefined): boolean {
  return (
    account?.accountType === "expense" ||
    account?.accountType === "other_expense" ||
    account?.accountType === "cost_of_revenue"
  );
}

function isIncomeAccount(account: BookRuleAccount | undefined): boolean {
  return account?.accountType === "revenue" || account?.accountType === "other_income";
}

export function evaluateBookRules(input: {
  candidate: CreateCandidateInput;
  lines: CandidateLineInput[];
  accounts: Map<string, BookRuleAccount>;
  party: BookRuleParty | null;
  documents: BookRuleDocument[];
  settings: BookRuleSettings;
  /**
   * The org's configured A/P account family, unioned with the subtype check
   * below. Optional: callers that cannot resolve it simply get today's
   * behavior — this is a pure heuristic path and must never throw.
   */
  apAccountIds?: ReadonlySet<string>;
}): ReviewFindingDraft[] {
  const { candidate, lines, accounts, party, documents, settings } = input;
  const apAccountIds = input.apAccountIds ?? new Set<string>();
  const findings: ReviewFindingDraft[] = [];
  const resolvedAccounts = lines.map((line) =>
    line.accountId ? accounts.get(line.accountId) : undefined,
  );

  const uncategorizedIndexes = resolvedAccounts
    .map((account, index) => ({ account, index }))
    .filter(({ account }) => !account || account.subtype?.startsWith("uncategorized_") === true)
    .map(({ index }) => index);
  if (uncategorizedIndexes.length > 0) {
    findings.push({
      ruleKey: "uncategorized",
      impact: "blocking",
      message: "Choose a leaf category for every posting line.",
      evidence: { lineIndexes: uncategorizedIndexes },
    });
  }

  const lowConfidenceIndexes = lines
    .map((line, index) => ({ line, index }))
    .filter(
      ({ line }) =>
        line.categoryConfidence != null &&
        Number(line.categoryConfidence) < Number(settings.lowConfidenceThreshold),
    )
    .map(({ index }) => index);
  if (lowConfidenceIndexes.length > 0) {
    findings.push({
      ruleKey: "low_confidence_category",
      impact: "blocking",
      message: "Confirm or change the low-confidence category prediction.",
      evidence: {
        lineIndexes: lowConfidenceIndexes,
        threshold: settings.lowConfidenceThreshold,
      },
    });
  }

  const expenseLineIndexes = resolvedAccounts
    .map((account, index) => ({ account, index }))
    .filter(({ account }) => isExpenseAccount(account))
    .map(({ index }) => index);
  const incomeLineIndexes = resolvedAccounts
    .map((account, index) => ({ account, index }))
    .filter(({ account }) => isIncomeAccount(account))
    .map(({ index }) => index);

  if (expenseLineIndexes.length > 0 && (!party || !["vendor", "both"].includes(party.partyType))) {
    findings.push({
      ruleKey: "missing_vendor",
      impact: "blocking",
      message: "Assign a vendor to this expense transaction.",
      evidence: { lineIndexes: expenseLineIndexes },
    });
  }

  if (incomeLineIndexes.length > 0 && (!party || !["customer", "both"].includes(party.partyType))) {
    findings.push({
      ruleKey: "missing_customer",
      impact: "blocking",
      message: "Assign a customer to this income transaction.",
      evidence: { lineIndexes: incomeLineIndexes },
    });
  }

  if (lines.every((line) => !line.departmentId)) {
    findings.push({
      ruleKey: "missing_department",
      impact: "blocking",
      message: "Assign a department to this transaction.",
      evidence: {},
    });
  }

  if (lines.every((line) => !line.locationId)) {
    findings.push({
      ruleKey: "missing_location",
      impact: "blocking",
      message: "Assign a location to this transaction.",
      evidence: {},
    });
  }

  const parentIndexes = resolvedAccounts
    .map((account, index) => ({ account, index }))
    .filter(({ account }) => (account?.childCount ?? 0) > 0)
    .map(({ index }) => index);
  if (parentIndexes.length > 0) {
    findings.push({
      ruleKey: "transaction_in_parent_category",
      impact: "warning",
      message: "Post to a leaf category instead of a parent category.",
      evidence: { lineIndexes: parentIndexes },
    });
  }

  // Every comparison here happens in the FUNCTIONAL currency, in exact
  // scale-8 decimals (audit P8 — float drift joined the money ratchet).
  //
  // The lines carry original-currency amounts (callers pass the entry's own
  // amounts), so a foreign-currency total converts through the candidate's
  // rate — the same original-to-functional mapping posting uses. It used to
  // be compared unconverted: EUR 70 at 1.10 (USD 77) slipped under a USD 75
  // threshold, and JPY 10,000 (about USD 67) tripped it.
  const functionalCurrency = settings.functionalCurrency.trim().toUpperCase();
  const originalCurrency = (candidate.originalCurrency ?? functionalCurrency).trim().toUpperCase();
  const expenseTotalOriginal = sumMoney(
    lines.map((line, index) => (expenseLineIndexes.includes(index) ? (line.debit ?? "0") : "0")),
  );
  const convertsExpense = originalCurrency !== functionalCurrency;
  const expenseTotal = convertsExpense
    ? multiplyMoney(expenseTotalOriginal, candidate.exchangeRate ?? "1")
    : expenseTotalOriginal;
  // The threshold converts with the candidate's OWN exchange rate only when
  // that rate is actually the right pair — i.e. the candidate's original
  // currency IS the threshold's currency (rate maps it into functional).
  // The old code applied that rate to ANY threshold currency, converting
  // with a wholly unrelated pair. When no correct pair is available the
  // threshold is used as-is, which is the pre-conversion behavior made
  // explicit rather than a silently wrong multiplication.
  const thresholdCurrency = settings.missingReceiptCurrency.trim().toUpperCase();
  const thresholdInFunctionalCurrency =
    thresholdCurrency === functionalCurrency
      ? settings.missingReceiptThreshold
      : thresholdCurrency === originalCurrency
        ? multiplyMoney(settings.missingReceiptThreshold, candidate.exchangeRate ?? "1")
        : settings.missingReceiptThreshold;
  // A payable (a vendor bill booked to pay later) is supported by the vendor's
  // bill, which missing_invoice below asks for. Asking for a receipt as well
  // made one missing PDF read as two blocking checks with two names, and a
  // vendor bill is not a receipt.
  const hasApCredit = lines.some((line, index) => {
    const account = resolvedAccounts[index];
    const isAp =
      account?.subtype === "accounts_payable" ||
      (line.accountId ? apAccountIds.has(line.accountId) : false);
    return isAp && Number(line.credit ?? 0) > 0;
  });
  const hasReceipt = documents.some((document) => document.documentType === "receipt");
  if (
    !hasApCredit &&
    compareMoney(expenseTotal, "0") > 0 &&
    compareMoney(expenseTotal, thresholdInFunctionalCurrency) > 0 &&
    !hasReceipt
  ) {
    findings.push({
      ruleKey: "missing_receipt",
      impact: "blocking",
      message: `Attach a receipt for expenses over ${settings.missingReceiptCurrency} ${displayMoney(settings.missingReceiptThreshold)}.`,
      evidence: {
        // Functional currency: what was compared with the threshold.
        expenseTotal,
        threshold: settings.missingReceiptThreshold,
        thresholdCurrency: settings.missingReceiptCurrency,
        ...(convertsExpense
          ? {
              originalExpenseTotal: expenseTotalOriginal,
              originalCurrency,
              exchangeRate: candidate.exchangeRate ?? "1",
            }
          : {}),
      },
    });
  }

  const hasInvoice = documents.some((document) =>
    ["invoice", "bill"].includes(document.documentType),
  );
  if (hasApCredit && !hasInvoice) {
    findings.push({
      ruleKey: "missing_invoice",
      impact: "blocking",
      message: "Attach the vendor's bill: the invoice the vendor sent you for this payable.",
      evidence: {},
    });
  }

  return findings;
}
