/**
 * Pure line rules for the posting cores. No database access, so they are unit
 * tested directly and shared by every core that writes a journal or a bill.
 */
import { centsToMoney } from "@/lib/money";
import {
  compareMoney,
  formatMoney,
  parseMoneyToScaled,
  scaledToMoney,
  sumMoney,
} from "@/lib/inbox/money";

/** One journal line as a posting core receives it. Amounts are exact decimal strings. */
export interface PostingLineDraft {
  accountId: string;
  /** Functional-currency amounts: what the ledger balances on. */
  debit: string | null;
  credit: string | null;
  originalDebit?: string | null;
  originalCredit?: string | null;
  originalCurrency?: string | null;
  exchangeRate?: string | null;
  lineDescription?: string | null;
  partyId?: string | null;
  departmentId?: string | null;
  locationId?: string | null;
  sortOrder: number;
}

/**
 * The ledger invariants checked before any journal is written: at least two
 * lines, every line on an account, and debits equal to credits exactly at the
 * stored 8-decimal scale (never rounded first). Returns the debit total, which
 * the header caches as its total amount.
 */
export function assertPostableLines(lines: readonly PostingLineDraft[]): { totalAmount: string } {
  if (lines.length < 2) throw new Error("At least two posting lines are required.");
  if (lines.some((line) => !line.accountId)) {
    throw new Error("Every posting line must have an account.");
  }
  const debits = sumMoney(lines.map((line) => line.debit));
  const credits = sumMoney(lines.map((line) => line.credit));
  if (compareMoney(debits, credits) !== 0) {
    throw new Error(
      `Unbalanced entry: debits ${formatMoney(debits)} do not equal credits ${formatMoney(credits)}.`,
    );
  }
  return { totalAmount: debits };
}

// ---------------------------------------------------------------------------
// Bills: cent policy and the accrual shape
// ---------------------------------------------------------------------------

/**
 * Bills store two decimals (`bills.amount` is decimal(15,2)) while candidates
 * and journals are exact at eight. A sub-cent amount is refused, never rounded:
 * Postgres would round it silently on insert and the bill would stop matching
 * the A/P credit it was created from.
 */
export const BILL_SUB_CENT_MESSAGE = "Amounts must have at most 2 decimal places for bills";

export class SubCentBillAmountError extends Error {
  constructor(readonly amount: string) {
    super(`${BILL_SUB_CENT_MESSAGE} (found ${amount}).`);
    this.name = "SubCentBillAmountError";
  }
}

/** One cent at the 8-decimal internal scale. */
const SCALED_CENT = 10n ** 6n;

/** The bills-table rendering ("84.25") of an exact amount, refusing anything below a cent. */
export function toBillAmount(amount: string): string {
  const scaled = parseMoneyToScaled(amount);
  if (scaled % SCALED_CENT !== 0n) throw new SubCentBillAmountError(scaledToMoney(scaled));
  return centsToMoney(Number(scaled / SCALED_CENT));
}

export const BILL_ACCRUAL_SHAPE_MESSAGE =
  "A vendor bill must credit Accounts Payable for its full amount on one line, with every other line a debit. Correct the entry, or change the event type if this was not a bill.";

export class BillAccrualShapeError extends Error {
  constructor(message: string = BILL_ACCRUAL_SHAPE_MESSAGE) {
    super(message);
    this.name = "BillAccrualShapeError";
  }
}

/** One bill line item as the bill core writes it. */
export interface BillLineDraft {
  description?: string | null;
  amount: string;
  accountId: string;
  departmentId?: string | null;
  locationId?: string | null;
}

type AccrualLine = Pick<
  PostingLineDraft,
  "accountId" | "debit" | "credit" | "lineDescription" | "departmentId" | "locationId"
>;

const present = (amount: string | null | undefined): amount is string =>
  amount != null && amount !== "";

/** `bill_line_items.description` is varchar(500). */
const BILL_LINE_DESCRIPTION_LIMIT = 500;

/**
 * The bill an accrual journal describes, the same shape the Bills editor
 * produces: every debit line is a bill line, and exactly one credit line
 * credits the mapped Accounts Payable account for the total. Anything else
 * (a bank credit, a second credit, a zero line) is not a bill, and posting it
 * as one would leave the payables subledger disagreeing with the ledger.
 */
export function billLinesFromAccrual(
  lines: readonly AccrualLine[],
  apAccountId: string,
): { lineItems: BillLineDraft[]; total: string } {
  const creditLines = lines.filter((line) => present(line.credit));
  const debitLines = lines.filter((line) => present(line.debit) && !present(line.credit));
  const [apLine] = creditLines;
  if (
    creditLines.length !== 1 ||
    apLine.accountId !== apAccountId ||
    present(apLine.debit) ||
    debitLines.length === 0 ||
    debitLines.length + 1 !== lines.length
  ) {
    throw new BillAccrualShapeError();
  }

  const lineItems = debitLines.map((line) => {
    const amount = toBillAmount(line.debit!);
    if (parseMoneyToScaled(amount) <= 0n) {
      throw new BillAccrualShapeError("Bill line amounts must be greater than zero.");
    }
    return {
      description: line.lineDescription?.slice(0, BILL_LINE_DESCRIPTION_LIMIT) ?? null,
      amount,
      accountId: line.accountId,
      departmentId: line.departmentId ?? null,
      locationId: line.locationId ?? null,
    };
  });
  const total = toBillAmount(apLine.credit!);
  if (compareMoney(sumMoney(lineItems.map((line) => line.amount)), total) !== 0) {
    throw new BillAccrualShapeError(
      "The bill lines do not add up to the Accounts Payable credit. Correct the entry before approving.",
    );
  }
  return { lineItems, total };
}
