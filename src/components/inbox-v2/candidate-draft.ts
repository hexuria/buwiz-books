/**
 * Candidate ⇄ editor draft, for the Inbox v2 reading pane.
 *
 * `candidateToEditorDraft` prefills the matching extracted editor from an Inbox candidate;
 * `*ToCorrection` turns what the user left in that editor back into the existing candidate
 * correction's input. Approval then posts the corrected candidate through the posting cores, so
 * the pane adds no posting path of its own.
 *
 * Money stays exact: amounts are decimal strings parsed to scale-8 integers (src/lib/inbox/money),
 * never floats. A candidate an editor cannot hold without dropping something falls back to the
 * Journal tab, which can hold any entry.
 */
import { parseMoneyToScaled, scaledToMoney, sumMoney } from "@/lib/inbox/money";
import type { InboxV2Kind } from "@/lib/inbox/v2/triage";
import type { BillDraft, BillDraftLine } from "@/components/bills/BillEditor";
import type { TransactionDraft } from "@/components/transactions/editor/transaction-draft";
import type { JournalLine, PayForLine, TabType } from "@/components/transactions/shared/types";

// ============================================================================
// Shapes
// ============================================================================

/** The candidate fields the pane reads (a subset of getInboxItem's detail). */
export interface DraftSourceLine {
  id: string;
  accountId: string | null;
  originalDebit: string | null;
  originalCredit: string | null;
  lineDescription: string | null;
  departmentId: string | null;
  locationId: string | null;
}

export interface DraftSourceCandidate {
  transactionType: string;
  transactionDate: string;
  memo: string | null;
  referenceNumber: string | null;
  partyId: string | null;
  originalTotal: string | null;
  lines: DraftSourceLine[];
}

/** The payable (or paid-from) side of a bill, which the Bills editor does not show. */
export interface BillCreditLine {
  accountId: string | null;
  lineDescription: string | null;
  departmentId: string | null;
  locationId: string | null;
}

export type EditorDraft =
  | { editor: "bill"; draft: BillDraft; creditLine: BillCreditLine | null }
  | {
      editor: "transaction";
      draft: TransactionDraft;
      /**
       * Why the entry opened on the Journal tab instead: a bill that is not expense lines against
       * one payable, or a Pay / Transfer entry those tabs could not hold without dropping a line,
       * description, or dimension.
       */
      fallback: "bill_shape" | "tab_shape" | null;
    };

/** updateInboxCandidate's input, less the item id and the concurrency tokens. */
export interface CandidateCorrection {
  transactionDate: string;
  transactionType: TabType;
  economicEventClass?: "purchase" | "sale" | "bill_accrual" | "transfer";
  memo: string | null;
  referenceNumber: string | null;
  partyId: string | null;
  originalCurrency: string;
  exchangeRate: string | null;
  lines: Array<{
    accountId: string;
    debit: string | null;
    credit: string | null;
    lineDescription: string | null;
    departmentId: string | null;
    locationId: string | null;
  }>;
}

/** A draft that cannot become a correction; the message is for the user. */
export class DraftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DraftError";
  }
}

// ============================================================================
// Amounts
// ============================================================================

function hasAmount(value: string | null | undefined): value is string {
  return value != null && value.trim() !== "" && parseMoneyToScaled(value) !== 0n;
}

/** A stored decimal as an input shows it: exact, trailing zeros trimmed to two places. */
export function amountForInput(value: string | null | undefined): string {
  if (value == null || value.trim() === "") return "";
  const [whole, fraction = ""] = scaledToMoney(parseMoneyToScaled(value)).split(".");
  return `${whole}.${fraction.padEnd(2, "0")}`;
}

/**
 * Parse what a user typed into an amount field. Returns null for blank or zero (no money on that
 * line); throws DraftError for anything that is not a plain positive number.
 */
export function parseAmountInput(raw: string, label: string): string | null {
  let value = raw.trim();
  if (value === "") return null;
  if (!/^(\d+(\.\d*)?|\.\d+)$/.test(value)) {
    throw new DraftError(`${label}: enter the amount as a plain number, like 120.50.`);
  }
  if (value.startsWith(".")) value = `0${value}`;
  if (value.endsWith(".")) value = value.slice(0, -1);
  let scaled: bigint;
  try {
    scaled = parseMoneyToScaled(value);
  } catch {
    throw new DraftError(`${label}: use at most 8 decimal places.`);
  }
  return scaled > 0n ? scaledToMoney(scaled) : null;
}

function isTab(value: string): value is TabType {
  return value === "journal" || value === "pay_in" || value === "pay_out" || value === "transfer";
}

function isDebitLine(line: DraftSourceLine) {
  return hasAmount(line.originalDebit) && !hasAmount(line.originalCredit);
}

function isCreditLine(line: DraftSourceLine) {
  return hasAmount(line.originalCredit) && !hasAmount(line.originalDebit);
}

/** A line with an account was finalized by someone; one without carries guidance text only. */
function keepsDescription(line: DraftSourceLine) {
  return line.accountId !== null && Boolean(line.lineDescription?.trim());
}

function hasDimensions(line: DraftSourceLine) {
  return Boolean(line.departmentId || line.locationId);
}

// ============================================================================
// Candidate → draft
// ============================================================================

function candidateToBillDraft(
  candidate: DraftSourceCandidate,
): Extract<EditorDraft, { editor: "bill" }> | null {
  const { lines } = candidate;
  if (lines.some((line) => !isDebitLine(line) && !isCreditLine(line))) return null;
  const debits = lines.filter(isDebitLine);
  const credits = lines.filter(isCreditLine);

  const base = {
    vendorId: candidate.partyId ?? "",
    billNumber: candidate.referenceNumber ?? "",
    billDate: candidate.transactionDate,
    // A candidate has no due date and the Inbox hides the field; approval dates the bill.
    dueDate: candidate.transactionDate,
    memo: candidate.memo ?? "",
  };

  if (lines.length === 0) {
    // Nothing extracted into lines yet: one line for the paper's total, category to choose.
    const lineItems: BillDraftLine[] = hasAmount(candidate.originalTotal)
      ? [
          {
            id: "paper-total",
            description: "",
            amount: amountForInput(candidate.originalTotal),
            accountId: "",
          },
        ]
      : [];
    return { editor: "bill", draft: { ...base, lineItems }, creditLine: null };
  }

  // A bill is expense debits against one payable credit that equals them.
  if (debits.length === 0 || credits.length !== 1) return null;
  const [credit] = credits;
  if (
    parseMoneyToScaled(sumMoney(debits.map((line) => line.originalDebit))) !==
    parseMoneyToScaled(credit.originalCredit)
  ) {
    return null;
  }

  return {
    editor: "bill",
    draft: {
      ...base,
      lineItems: debits.map((line) => ({
        id: line.id,
        description: line.lineDescription ?? "",
        amount: amountForInput(line.originalDebit),
        accountId: line.accountId ?? "",
        departmentId: line.departmentId,
        locationId: line.locationId,
      })),
    },
    creditLine: {
      accountId: credit.accountId,
      lineDescription: keepsDescription(credit) ? credit.lineDescription : null,
      departmentId: credit.departmentId,
      locationId: credit.locationId,
    },
  };
}

function journalLinesFor(lines: DraftSourceLine[]): JournalLine[] {
  const journalLines: JournalLine[] = lines.map((line) => ({
    key: line.id,
    description: line.lineDescription ?? "",
    categoryId: line.accountId ?? "",
    // One party per candidate, chosen in the editor's header.
    partyId: "",
    departmentId: line.departmentId ?? "",
    locationId: line.locationId ?? "",
    debit: amountForInput(line.originalDebit),
    credit: amountForInput(line.originalCredit),
  }));
  while (journalLines.length < 2) {
    journalLines.push({
      key: `blank-${journalLines.length}`,
      description: "",
      categoryId: "",
      partyId: "",
      departmentId: "",
      locationId: "",
      debit: "",
      credit: "",
    });
  }
  return journalLines;
}

function blankPayForLine(key: string): PayForLine {
  return { key, description: "", categoryId: "", departmentId: "", locationId: "", amount: "" };
}

/**
 * Fill the Pay tab when the entry is one bank-side line against the lines it paid for: Pay Out
 * credits the bank side, Pay In debits it. Null when that shape would drop something.
 */
function payFields(
  lines: DraftSourceLine[],
  type: "pay_in" | "pay_out",
): Pick<TransactionDraft, "payCategoryId" | "payForLines"> | null {
  if (lines.some((line) => !isDebitLine(line) && !isCreditLine(line))) return null;
  const categoryLines = lines.filter(type === "pay_out" ? isCreditLine : isDebitLine);
  const paidFor = lines.filter(type === "pay_out" ? isDebitLine : isCreditLine);
  if (categoryLines.length !== 1 || paidFor.length === 0) return null;
  const [category] = categoryLines;
  // The Pay tab's bank-side line has no description or dimension fields.
  if (keepsDescription(category) || hasDimensions(category)) return null;
  const amountOf = (line: DraftSourceLine) =>
    type === "pay_out" ? line.originalDebit : line.originalCredit;
  const categoryAmount = type === "pay_out" ? category.originalCredit : category.originalDebit;
  if (parseMoneyToScaled(sumMoney(paidFor.map(amountOf))) !== parseMoneyToScaled(categoryAmount)) {
    return null;
  }
  return {
    payCategoryId: category.accountId ?? "",
    payForLines: paidFor.map((line) => ({
      key: line.id,
      description: line.lineDescription ?? "",
      categoryId: line.accountId ?? "",
      departmentId: line.departmentId ?? "",
      locationId: line.locationId ?? "",
      amount: amountForInput(amountOf(line)),
    })),
  };
}

/** Fill the Transfer tab when the entry is exactly one debit and one equal credit. */
function transferFields(
  lines: DraftSourceLine[],
): Pick<TransactionDraft, "transferFromCategory" | "transferToCategory" | "transferAmount"> | null {
  if (lines.length !== 2) return null;
  const debit = lines.find(isDebitLine);
  const credit = lines.find(isCreditLine);
  if (!debit || !credit) return null;
  if (lines.some((line) => keepsDescription(line) || hasDimensions(line))) return null;
  if (parseMoneyToScaled(debit.originalDebit) !== parseMoneyToScaled(credit.originalCredit)) {
    return null;
  }
  return {
    transferFromCategory: credit.accountId ?? "",
    transferToCategory: debit.accountId ?? "",
    transferAmount: amountForInput(debit.originalDebit),
  };
}

function candidateToTransactionDraft(candidate: DraftSourceCandidate): {
  draft: TransactionDraft;
  representable: boolean;
} {
  const requested: TabType = isTab(candidate.transactionType)
    ? candidate.transactionType
    : "journal";
  const draft: TransactionDraft = {
    type: "journal",
    date: candidate.transactionDate,
    referenceNumber: candidate.referenceNumber ?? "",
    memo: candidate.memo ?? "",
    journalLines: journalLinesFor(candidate.lines),
    payPartyId: candidate.partyId ?? "",
    payCategoryId: "",
    payForLines: [blankPayForLine("pay-blank-0")],
    transferFromParty: "",
    transferFromCategory: "",
    transferToParty: "",
    transferToCategory: "",
    transferAmount: "",
  };
  if (requested === "journal") return { draft, representable: true };

  // No lines yet: open the requested tab with the paper's total to categorize.
  if (candidate.lines.length === 0) {
    const amount = hasAmount(candidate.originalTotal)
      ? amountForInput(candidate.originalTotal)
      : "";
    if (requested === "transfer") {
      return { draft: { ...draft, type: "transfer", transferAmount: amount }, representable: true };
    }
    return {
      draft: {
        ...draft,
        type: requested,
        payForLines: [{ ...blankPayForLine("paper-total"), amount }],
      },
      representable: true,
    };
  }

  if (requested === "transfer") {
    const fields = transferFields(candidate.lines);
    return fields
      ? { draft: { ...draft, type: "transfer", ...fields }, representable: true }
      : { draft, representable: false };
  }
  const fields = payFields(candidate.lines, requested);
  return fields
    ? { draft: { ...draft, type: requested, ...fields }, representable: true }
    : { draft, representable: false };
}

/**
 * The editor and prefilled draft for a candidate. Vendor bills open the Bills editor; every other
 * kind opens the New transaction editor on its own tab. Sales invoices also use the transaction
 * editor: approval does not create invoice records yet, so an invoice editor would collect fields
 * nothing could save.
 */
export function candidateToEditorDraft(
  candidate: DraftSourceCandidate,
  kind: InboxV2Kind,
): EditorDraft {
  if (kind === "vendor_bill") {
    const bill = candidateToBillDraft(candidate);
    if (bill) return bill;
    return { editor: "transaction", draft: journalOnly(candidate), fallback: "bill_shape" };
  }
  return candidateToTransactionEditorDraft(candidate);
}

/** The candidate on the Journal tab, which holds any entry as it stands. */
export function journalOnly(candidate: DraftSourceCandidate): TransactionDraft {
  return candidateToTransactionDraft({ ...candidate, transactionType: "journal" }).draft;
}

/** The transaction editor's draft for a candidate, whatever its kind ("Book as" a transaction). */
export function candidateToTransactionEditorDraft(candidate: DraftSourceCandidate): EditorDraft {
  const { draft, representable } = candidateToTransactionDraft(candidate);
  return { editor: "transaction", draft, fallback: representable ? null : "tab_shape" };
}

/**
 * The Bills editor's draft, or null when the entry is not a bill shape ("Book as" a bill).
 *
 * `rebook` is a reviewer turning a paper that was not a bill into one: its credit side was a
 * payment account, and a bill accrues to Accounts Payable, so the payable side is re-pointed at
 * the org's mapped A/P (resolved when the correction is built). Without it, approval would book
 * the "bill" against cash and write no bill record.
 */
export function candidateToBillEditorDraft(
  candidate: DraftSourceCandidate,
  options: { rebook?: boolean } = {},
): EditorDraft | null {
  const bill = candidateToBillDraft(candidate);
  if (!bill || !options.rebook || !bill.creditLine) return bill;
  return { ...bill, creditLine: { ...bill.creditLine, accountId: null, lineDescription: null } };
}

// ============================================================================
// Draft → correction
// ============================================================================

export interface CorrectionContext {
  originalCurrency: string;
  functionalCurrency: string;
  exchangeRate: string;
}

function exchangeRateFor(context: CorrectionContext): string {
  return context.originalCurrency === context.functionalCurrency ? "1" : context.exchangeRate;
}

/**
 * The Bills editor's draft as a bill accrual: the line items as debits and one credit for their
 * exact total to the bill's existing payable side, or the org's mapped Accounts Payable when the
 * paper had none yet.
 */
export function billDraftToCorrection(
  draft: BillDraft,
  context: CorrectionContext & {
    creditLine: BillCreditLine | null;
    payableAccountId: string | null;
  },
): CandidateCorrection {
  if (!draft.vendorId) throw new DraftError("Choose the vendor for this bill.");

  const debits: CandidateCorrection["lines"] = [];
  draft.lineItems.forEach((line, index) => {
    const amount = parseAmountInput(line.amount, `Line ${index + 1}`);
    if (amount === null) return;
    if (!line.accountId) throw new DraftError(`Line ${index + 1}: choose a category.`);
    debits.push({
      accountId: line.accountId,
      debit: amount,
      credit: null,
      lineDescription: line.description.trim() || null,
      departmentId: line.departmentId || null,
      locationId: line.locationId || null,
    });
  });
  if (debits.length === 0) {
    throw new DraftError("Add at least one line with a category and an amount.");
  }

  const creditAccountId = context.creditLine?.accountId ?? context.payableAccountId;
  if (!creditAccountId) {
    throw new DraftError(
      "No Accounts Payable account is mapped. Set it under Settings → Mappings, then save again.",
    );
  }
  const billNumber = draft.billNumber.trim();

  return {
    transactionDate: draft.billDate,
    transactionType: "journal",
    economicEventClass: "bill_accrual",
    memo: draft.memo.trim() || null,
    referenceNumber: billNumber || null,
    partyId: draft.vendorId,
    originalCurrency: context.originalCurrency,
    exchangeRate: exchangeRateFor(context),
    lines: [
      ...debits,
      {
        accountId: creditAccountId,
        debit: null,
        credit: sumMoney(debits.map((line) => line.debit)),
        lineDescription: context.creditLine?.lineDescription ?? `A/P: ${billNumber || "Bill"}`,
        departmentId: context.creditLine?.departmentId ?? null,
        locationId: context.creditLine?.locationId ?? null,
      },
    ],
  };
}

const TAB_EVENT_CLASS: Partial<Record<TabType, CandidateCorrection["economicEventClass"]>> = {
  pay_out: "purchase",
  pay_in: "sale",
  transfer: "transfer",
};

/**
 * The transaction editor's draft as the active tab's balanced entry — the same line structure
 * /transactions/new submits, with exact amounts.
 *
 * For a reviewer-editable source (an emailed or uploaded paper) the tab is the reviewer's
 * statement of what happened, so Pay Out / Pay In / Transfer also reclassify the source. Any other
 * source keeps its own classification, which the server enforces.
 */
export function transactionDraftToCorrection(
  draft: TransactionDraft,
  context: CorrectionContext & { sourceReviewerEditable: boolean },
): CandidateCorrection {
  let lines: CandidateCorrection["lines"];
  const line = (
    accountId: string,
    side: "debit" | "credit",
    amount: string,
    extra: { description?: string; departmentId?: string; locationId?: string } = {},
  ) => ({
    accountId,
    debit: side === "debit" ? amount : null,
    credit: side === "credit" ? amount : null,
    lineDescription: extra.description?.trim() || null,
    departmentId: extra.departmentId || null,
    locationId: extra.locationId || null,
  });

  if (draft.type === "journal") {
    lines = [];
    draft.journalLines.forEach((entry, index) => {
      const label = `Line ${index + 1}`;
      const debit = parseAmountInput(entry.debit, label);
      const credit = parseAmountInput(entry.credit, label);
      if (debit === null && credit === null) return;
      if (debit !== null && credit !== null) {
        throw new DraftError(`${label}: enter a debit or a credit, not both.`);
      }
      if (!entry.categoryId) throw new DraftError(`${label}: choose a category.`);
      lines.push(
        line(entry.categoryId, debit !== null ? "debit" : "credit", (debit ?? credit)!, {
          description: entry.description,
          departmentId: entry.departmentId,
          locationId: entry.locationId,
        }),
      );
    });
    if (lines.length < 2) {
      throw new DraftError("At least 2 journal lines with amounts are required.");
    }
    const debits = sumMoney(lines.map((entry) => entry.debit));
    const credits = sumMoney(lines.map((entry) => entry.credit));
    if (parseMoneyToScaled(debits) !== parseMoneyToScaled(credits)) {
      throw new DraftError(`Debits (${debits}) must equal credits (${credits}).`);
    }
  } else if (draft.type === "pay_in" || draft.type === "pay_out") {
    const label = draft.type === "pay_in" ? "Pay In" : "Pay Out";
    if (!draft.payCategoryId) throw new DraftError(`Choose the ${label} category.`);
    const paidFor: CandidateCorrection["lines"] = [];
    const side = draft.type === "pay_out" ? "debit" : "credit";
    draft.payForLines.forEach((entry, index) => {
      const amount = parseAmountInput(entry.amount, `Line ${index + 1}`);
      if (amount === null) return;
      if (!entry.categoryId) throw new DraftError(`Line ${index + 1}: choose a category.`);
      paidFor.push(
        line(entry.categoryId, side, amount, {
          description: entry.description,
          departmentId: entry.departmentId,
          locationId: entry.locationId,
        }),
      );
    });
    if (paidFor.length === 0) throw new DraftError("At least 1 line with an amount is required.");
    const total = sumMoney(paidFor.map((entry) => entry.debit ?? entry.credit));
    lines = [
      line(draft.payCategoryId, draft.type === "pay_out" ? "credit" : "debit", total),
      ...paidFor,
    ];
  } else {
    const amount = parseAmountInput(draft.transferAmount, "Transfer");
    if (amount === null) throw new DraftError("Enter a transfer amount.");
    if (!draft.transferFromCategory || !draft.transferToCategory) {
      throw new DraftError("Choose both the Transfer From and Transfer To categories.");
    }
    lines = [
      line(draft.transferToCategory, "debit", amount),
      line(draft.transferFromCategory, "credit", amount),
    ];
  }

  const economicEventClass = context.sourceReviewerEditable
    ? TAB_EVENT_CLASS[draft.type]
    : undefined;
  return {
    transactionDate: draft.date,
    transactionType: draft.type,
    ...(economicEventClass ? { economicEventClass } : {}),
    memo: draft.memo.trim() || null,
    referenceNumber: draft.referenceNumber.trim() || null,
    partyId: draft.payPartyId || null,
    originalCurrency: context.originalCurrency,
    exchangeRate: exchangeRateFor(context),
    lines,
  };
}
