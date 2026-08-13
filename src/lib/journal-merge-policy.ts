import { isDateLocked } from "./period-lock-policy";

export type JournalMergeTransactionType = "pay_in" | "pay_out" | "journal" | "transfer";
export type JournalMergeStatus = "draft" | "posted" | "voided";

export interface JournalMergeFact {
  id: string;
  transactionNumber: string | null;
  transactionDate: string;
  transactionType: JournalMergeTransactionType;
  status: JournalMergeStatus;
  totalAmount: string | null;
  currency: string;
  functionalCurrency: string;
  duplicateOfHeaderId: string | null;
  debitTotal: string;
  creditTotal: string;
  originalDebitTotal: string;
  originalCreditTotal: string;
  originalAmountsComplete: boolean;
  originalCurrencies: string[];
  reconciliationCount: number;
  domainOwners: string[];
  economicEventClasses: string[];
  operationalOrigins: JournalOperationalOriginFact[];
  paymentIdentityTokens: string[];
}

export interface JournalOperationalOriginFact {
  sourceRecordId: string;
  integrationSourceId: string | null;
  provider: string | null;
  externalId: string | null;
  normalizedReference: string | null;
  recordType: string;
  economicEventClass: string;
}

export interface JournalMergeCheck {
  key:
    | "distinct"
    | "posted"
    | "effective"
    | "not_already_merged"
    | "balanced"
    | "non_zero"
    | "amount"
    | "currency"
    | "direction"
    | "event_class"
    | "payment_identity"
    | "period"
    | "reconciliation"
    | "domain";
  passed: boolean;
  message: string;
}

export interface JournalMergeFacts {
  canonical: JournalMergeFact;
  duplicate: JournalMergeFact;
  closedThrough: string | null;
  activeMergeIds: string[];
}

export interface JournalMergePreview {
  eligible: boolean;
  canonical: JournalMergeFact;
  duplicate: JournalMergeFact;
  checks: JournalMergeCheck[];
  blockers: string[];
}

const DECIMAL_SCALE = 8;

function decimalUnits(value: string | null): bigint | null {
  if (value === null) return null;
  const match = value.trim().match(/^(-?)(\d+)(?:\.(\d+))?$/);
  if (!match) return null;

  const sign = match[1] === "-" ? -1n : 1n;
  const whole = match[2];
  const rawFraction = match[3] ?? "";
  const discarded = rawFraction.slice(DECIMAL_SCALE);
  if (discarded.replace(/0/g, "").length > 0) return null;

  const fraction = rawFraction.slice(0, DECIMAL_SCALE).padEnd(DECIMAL_SCALE, "0");
  return sign * (BigInt(whole) * 10n ** BigInt(DECIMAL_SCALE) + BigInt(fraction));
}

export function buildJournalMergePairKey(leftId: string, rightId: string): string {
  return [leftId, rightId].sort().join(":");
}

export function classifyJournalDirection(
  transactionType: JournalMergeTransactionType,
): "inflow" | "outflow" | "journal" | "transfer" {
  if (transactionType === "pay_in") return "inflow";
  if (transactionType === "pay_out") return "outflow";
  return transactionType;
}

function sameDomainOwner(facts: JournalMergeFacts): boolean {
  const canonicalOwners = new Set(facts.canonical.domainOwners);
  const duplicateOwners = new Set(facts.duplicate.domainOwners);
  if (canonicalOwners.size === 0 && duplicateOwners.size > 0) return false;
  if (duplicateOwners.size === 0) return true;
  return (
    canonicalOwners.size === 1 &&
    duplicateOwners.size === 1 &&
    [...canonicalOwners][0] === [...duplicateOwners][0]
  );
}

function eventClassesCompatible(leftClasses: string[], rightClasses: string[]): boolean {
  const compatiblePair = (left: string, right: string) => {
    if (left === "transfer" || right === "transfer") return false;
    if (left === right || left === "other" || right === "other") return true;
    const pair = new Set([left, right]);
    return (
      (pair.has("purchase") && pair.has("bill_accrual")) ||
      (pair.has("sale") && pair.has("invoice_accrual"))
    );
  };
  return leftClasses.every((left) => rightClasses.every((right) => compatiblePair(left, right)));
}

function isPaymentEventClass(value: string): boolean {
  return value === "bill_payment" || value === "invoice_payment";
}

function paymentIdentityCompatible(facts: JournalMergeFacts): boolean {
  const paymentIdentityRequired =
    facts.canonical.economicEventClasses.some(isPaymentEventClass) ||
    facts.duplicate.economicEventClasses.some(isPaymentEventClass);
  if (!paymentIdentityRequired) return true;
  if (
    facts.canonical.operationalOrigins.length > 1 ||
    facts.duplicate.operationalOrigins.length > 1
  ) {
    return false;
  }

  const canonicalIdentities = new Set(facts.canonical.paymentIdentityTokens);
  return (
    canonicalIdentities.size > 0 &&
    facts.duplicate.paymentIdentityTokens.length > 0 &&
    facts.duplicate.paymentIdentityTokens.some((identity) => canonicalIdentities.has(identity))
  );
}

function originalLineCurrencyIsValid(fact: JournalMergeFact): boolean {
  const transactionCurrency = fact.currency.toUpperCase();
  const currenciesMatch = fact.originalCurrencies.every(
    (currency) => currency.toUpperCase() === transactionCurrency,
  );
  if (!currenciesMatch) return false;

  const isForeignCurrency = transactionCurrency !== fact.functionalCurrency.toUpperCase();
  return (
    !isForeignCurrency ||
    (fact.originalAmountsComplete &&
      fact.originalCurrencies.length === 1 &&
      fact.originalCurrencies[0]?.toUpperCase() === transactionCurrency)
  );
}

export function evaluateJournalMergePreflight(facts: JournalMergeFacts): JournalMergePreview {
  const canonicalDebit = decimalUnits(facts.canonical.debitTotal);
  const canonicalCredit = decimalUnits(facts.canonical.creditTotal);
  const duplicateDebit = decimalUnits(facts.duplicate.debitTotal);
  const duplicateCredit = decimalUnits(facts.duplicate.creditTotal);
  const canonicalOriginalDebit = decimalUnits(facts.canonical.originalDebitTotal);
  const canonicalOriginalCredit = decimalUnits(facts.canonical.originalCreditTotal);
  const duplicateOriginalDebit = decimalUnits(facts.duplicate.originalDebitTotal);
  const duplicateOriginalCredit = decimalUnits(facts.duplicate.originalCreditTotal);
  const canonicalAmount = decimalUnits(facts.canonical.totalAmount);
  const duplicateAmount = decimalUnits(facts.duplicate.totalAmount);

  const functionallyBalanced =
    canonicalDebit !== null &&
    canonicalCredit !== null &&
    duplicateDebit !== null &&
    duplicateCredit !== null &&
    canonicalDebit === canonicalCredit &&
    duplicateDebit === duplicateCredit;
  const originallyBalanced =
    canonicalOriginalDebit !== null &&
    canonicalOriginalCredit !== null &&
    duplicateOriginalDebit !== null &&
    duplicateOriginalCredit !== null &&
    canonicalOriginalDebit === canonicalOriginalCredit &&
    duplicateOriginalDebit === duplicateOriginalCredit;
  const bothBalanced = functionallyBalanced && originallyBalanced;
  const bothNonZero =
    canonicalDebit !== null &&
    duplicateDebit !== null &&
    canonicalOriginalDebit !== null &&
    duplicateOriginalDebit !== null &&
    canonicalDebit > 0n &&
    duplicateDebit > 0n &&
    canonicalOriginalDebit > 0n &&
    duplicateOriginalDebit > 0n;
  const amountsMatch =
    functionallyBalanced &&
    originallyBalanced &&
    canonicalAmount !== null &&
    duplicateAmount !== null &&
    canonicalAmount === canonicalDebit &&
    duplicateAmount === duplicateDebit &&
    canonicalOriginalDebit === duplicateOriginalDebit;
  const currenciesMatch =
    facts.canonical.currency === facts.duplicate.currency &&
    facts.canonical.functionalCurrency === facts.duplicate.functionalCurrency &&
    originalLineCurrencyIsValid(facts.canonical) &&
    originalLineCurrencyIsValid(facts.duplicate);
  const directionMatches =
    facts.canonical.transactionType === facts.duplicate.transactionType &&
    classifyJournalDirection(facts.canonical.transactionType) !== "transfer";
  const eventClassMatches = eventClassesCompatible(
    facts.canonical.economicEventClasses,
    facts.duplicate.economicEventClasses,
  );
  const paymentIdentityMatches = paymentIdentityCompatible(facts);
  const periodsOpen =
    !isDateLocked(facts.canonical.transactionDate, facts.closedThrough) &&
    !isDateLocked(facts.duplicate.transactionDate, facts.closedThrough);

  const checks: JournalMergeCheck[] = [
    {
      key: "distinct",
      passed: facts.canonical.id !== facts.duplicate.id,
      message: "Canonical and duplicate journals must be different.",
    },
    {
      key: "posted",
      passed: facts.canonical.status === "posted" && facts.duplicate.status === "posted",
      message: "Both journals must be posted.",
    },
    {
      key: "effective",
      passed:
        facts.canonical.duplicateOfHeaderId === null &&
        facts.duplicate.duplicateOfHeaderId === null,
      message: "A journal already marked as a duplicate cannot be merged again.",
    },
    {
      key: "not_already_merged",
      passed: facts.activeMergeIds.length === 0,
      message: "One of these journals already belongs to an active duplicate merge.",
    },
    {
      key: "balanced",
      passed: bothBalanced,
      message:
        "Both journals must have exactly balanced functional and transaction-currency debit and credit lines.",
    },
    {
      key: "non_zero",
      passed: bothNonZero,
      message: "Both journals must have a non-zero accounting amount.",
    },
    {
      key: "amount",
      passed: amountsMatch,
      message:
        "Transaction-currency line totals must match exactly, and each functional header total must agree with its own functional lines.",
    },
    {
      key: "currency",
      passed: currenciesMatch,
      message:
        "Journal functional, transaction, and original line currencies must match and be complete for foreign-currency transactions.",
    },
    {
      key: "direction",
      passed: directionMatches,
      message:
        "Journal direction and type must match; transfers cannot be duplicate-merged automatically.",
    },
    {
      key: "event_class",
      passed: eventClassMatches,
      message:
        "Economic event classes are incompatible; accruals, payments, transfers, payroll, and unrelated event types must remain separate.",
    },
    {
      key: "payment_identity",
      passed: paymentIdentityMatches,
      message:
        "Payment journals require one identical provider origin or strong payment reference; distinct captures and installments must remain separate.",
    },
    {
      key: "period",
      passed: periodsOpen,
      message: facts.closedThrough
        ? `Neither journal may be in a period locked through ${facts.closedThrough}.`
        : "Neither journal may be in a locked period.",
    },
    {
      key: "reconciliation",
      passed: facts.duplicate.reconciliationCount === 0,
      message:
        facts.canonical.reconciliationCount === 0 && facts.duplicate.reconciliationCount > 0
          ? "The reconciled journal must be selected as canonical."
          : "The duplicate journal cannot have reconciliation links.",
    },
    {
      key: "domain",
      passed: sameDomainOwner(facts),
      message:
        "Operational bill/invoice ownership conflicts; select the owned journal as canonical and never combine different business documents.",
    },
  ];

  const blockers = checks.filter((check) => !check.passed).map((check) => check.message);
  return {
    eligible: blockers.length === 0,
    canonical: facts.canonical,
    duplicate: facts.duplicate,
    checks,
    blockers,
  };
}
