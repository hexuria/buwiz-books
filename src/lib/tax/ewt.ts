/**
 * Expanded withholding tax on purchases — Stage 3b.
 *
 * The mirror of Stage 3a. There we RECEIVED a 2307 because a customer withheld
 * from us; here we are the withholding agent, deducting from what we pay a
 * supplier and remitting it ourselves. The obligations that follow are real and
 * personal: an agent who fails to withhold is liable for the tax it should have
 * withheld, plus penalties, and the expense itself becomes non-deductible.
 *
 * WHO HAS TO WITHHOLD. Not everyone. The duty attaches to a taxpayer the BIR
 * has designated a withholding agent — top withholding agents (TWA) by
 * revenue-based criteria, government, and specific payment types that carry the
 * duty regardless of agent status (professional fees, rentals, contractors).
 * That distinction is the first thing this module models, because withholding
 * when you are not required to is its own problem: the supplier is short-paid
 * and holds a certificate for tax you had no duty to deduct.
 *
 * THE ENTRY, when a bill is paid with tax withheld:
 *
 *     DR  Accounts payable          the full invoice amount
 *         CR  Cash                  what the supplier actually receives
 *         CR  EWT payable           the tax withheld, owed to the BIR
 *
 * The payable is settled in full — the supplier's claim is extinguished even
 * though less cash left. The credit sits in EWT payable until remitted, and
 * that account's movement is what 0619-E and 1601-EQ have to reconcile against.
 *
 * REMITTANCE IS SPLIT ACROSS TWO FORMS, which is the part that surprises
 * people. Months 1 and 2 of a quarter are remitted on 0619-E; the quarter
 * itself is filed on 1601-EQ with the QAP attached. So a quarter produces
 * two monthly remittances and one quarterly return, and the return's total
 * must equal the three months of withholding — not just the third.
 */
import {
  addAll,
  applyRateBps,
  fromScaled,
  toScaled,
  ZERO,
  type ScaledMoney,
} from "@/lib/tax/money";
import { ATC_EXPECTED_RATE_BPS } from "@/lib/tax/certificate-2307";

/**
 * Why a payment is subject to withholding.
 *
 * Modelled explicitly rather than inferred from the amount, because the answer
 * changes the duty: `agent_status` applies only while we are a designated
 * agent, while `payment_type` applies to everyone making that kind of payment.
 */
export type WithholdingBasis = "agent_status" | "payment_type" | "not_required";

export interface EwtAssessment {
  required: boolean;
  basis: WithholdingBasis;
  atc: string | null;
  rateBps: number | null;
  reason: string;
}

/**
 * Payment types that carry the withholding duty regardless of whether the
 * payor is a designated top withholding agent.
 *
 * Deliberately a small explicit list. An unrecognised expense category returns
 * "not required" WITH a reason saying the check could not be made — silently
 * answering "no" would let a genuine obligation pass unnoticed, and the whole
 * risk of this module is failing to withhold.
 */
const DUTY_BY_PAYMENT_TYPE: Record<string, { atcIndividual: string; atcCorporate: string }> = {
  professional_fees: { atcIndividual: "WI010", atcCorporate: "WC010" },
  rental: { atcIndividual: "WI100", atcCorporate: "WC100" },
  contractor: { atcIndividual: "WI120", atcCorporate: "WC120" },
};

/** ATCs a top withholding agent uses for ordinary purchases. */
const TWA_ATC = {
  goods: { individual: "WI158", corporate: "WC158" },
  services: { individual: "WI160", corporate: "WC160" },
};

export interface EwtAssessmentInput {
  /** Whether WE are a designated top withholding agent. */
  isTopWithholdingAgent: boolean;
  /** The supplier's taxpayer class — decides which ATC of a pair applies. */
  payeeType: "individual" | "corporate";
  /** What the payment is for. */
  paymentType: string;
  /**
   * Whether the supplier has filed a sworn declaration of gross receipts not
   * exceeding ₱3,000,000, which lowers professional-fee withholding.
   */
  hasSwornDeclaration?: boolean;
  /** Whether the supplier is VAT-registered — some ATCs differ. */
  payeeIsVatRegistered?: boolean;
  /**
   * Corporate professional fees only: gross income for the current year
   * exceeds ₱720,000, which moves the rate from 10% (WC010) to 15% (WC011).
   * The corporate analog of the individual sworn-declaration split.
   */
  grossIncomeOver720k?: boolean;
}

/**
 * Decide whether a payment must have tax withheld, and at what rate.
 *
 * Returns a REASON in every case, including when nothing is required. "No
 * withholding" and "we could not tell" are different answers and must not look
 * alike to whoever reviews the bill.
 */
export function assessEwt(input: EwtAssessmentInput): EwtAssessment {
  const paymentType = input.paymentType.trim().toLowerCase();
  const duty = DUTY_BY_PAYMENT_TYPE[paymentType];

  if (duty) {
    const atc = input.payeeType === "individual" ? duty.atcIndividual : duty.atcCorporate;
    // A sworn declaration of gross receipts ≤ ₱3M lowers the professional-fee
    // rate. It applies to the individual code only; the corporate rate is not
    // affected by the individual threshold.
    let effectiveAtc = atc;
    if (paymentType === "professional_fees" && input.payeeType === "individual") {
      if (!input.hasSwornDeclaration) effectiveAtc = "WI011";
    } else if (paymentType === "professional_fees" && input.payeeType === "corporate") {
      // RR 11-2018: 10% while gross income ≤ ₱720k, 15% above — WC011.
      if (input.grossIncomeOver720k) effectiveAtc = "WC011";
    }
    const rateBps = ATC_EXPECTED_RATE_BPS[effectiveAtc] ?? null;
    return {
      required: true,
      basis: "payment_type",
      atc: effectiveAtc,
      rateBps,
      reason:
        `${paymentType.replace(/_/g, " ")} carries the withholding duty for every payor, ` +
        `not only designated agents.`,
    };
  }

  if (input.isTopWithholdingAgent && (paymentType === "goods" || paymentType === "services")) {
    const pair = TWA_ATC[paymentType];
    const atc = input.payeeType === "individual" ? pair.individual : pair.corporate;
    return {
      required: true,
      basis: "agent_status",
      atc,
      rateBps: ATC_EXPECTED_RATE_BPS[atc] ?? null,
      reason: `We are a designated top withholding agent, so ordinary ${paymentType} purchases are covered.`,
    };
  }

  if (paymentType === "goods" || paymentType === "services") {
    return {
      required: false,
      basis: "not_required",
      atc: null,
      rateBps: null,
      reason:
        "Ordinary purchases are only covered while we are a designated top withholding agent, " +
        "and we are not currently flagged as one.",
    };
  }

  // The honest answer. Silently returning "not required" for an unrecognised
  // category is how a genuine obligation gets missed, and the penalty falls on
  // the agent.
  return {
    required: false,
    basis: "not_required",
    atc: null,
    rateBps: null,
    reason:
      `Payment type ${JSON.stringify(input.paymentType)} is not in the withholding table, so the ` +
      `duty could NOT be determined. Check it before paying — an agent that fails to withhold ` +
      `is liable for the tax plus penalties, and the expense becomes non-deductible.`,
  };
}

export interface EwtComputation {
  taxBase: string;
  taxWithheld: string;
  netPayable: string;
  atc: string;
  rateBps: number;
}

/**
 * Compute the withholding on a payment.
 *
 * The base is the amount NET of VAT. Withholding on the VAT-inclusive amount
 * over-withholds by the VAT rate applied to the tax — a supplier short-paid
 * that way has a real claim, and the certificate we issue would overstate what
 * we remitted.
 */
export function computeEwt(input: {
  grossAmount: string;
  /** VAT included in `grossAmount`, if any. Excluded from the base. */
  vatAmount?: string;
  atc: string;
  rateBps: number;
}): EwtComputation {
  const gross = toScaled(input.grossAmount);
  const vat = toScaled(input.vatAmount ?? "0");
  if (vat > gross) {
    throw new Error(
      `VAT (${input.vatAmount}) exceeds the gross amount (${input.grossAmount}); the withholding ` +
        `base would be negative.`,
    );
  }

  const base = (gross - vat) as ScaledMoney;
  // ONE rounding, at the end — computing on a pre-rounded base drifts.
  const withheld = applyRateBps(base, input.rateBps);
  const net = (gross - withheld) as ScaledMoney;

  return {
    taxBase: fromScaled(base),
    taxWithheld: fromScaled(withheld),
    netPayable: fromScaled(net),
    atc: input.atc,
    rateBps: input.rateBps,
  };
}

// ── Remittance periods ─────────────────────────────────────────────────────

export type EwtFormCode = "0619E" | "1601EQ";

export interface RemittanceObligation {
  formCode: EwtFormCode;
  periodStart: string;
  periodEnd: string;
  dueDate: string;
  /** Why this form and not the other. */
  note: string;
}

function iso(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * The forms a given month generates.
 *
 * The split is the thing worth knowing: months 1 and 2 of a quarter produce a
 * 0619-E monthly remittance, and month 3 produces NO 0619-E — the quarter is
 * filed on 1601-EQ instead, covering all three months. Filing a 0619-E for the
 * third month double-remits; omitting the quarterly return under-reports two
 * thirds of the quarter.
 */
export function remittanceObligationsFor(month: number, year: number): RemittanceObligation[] {
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error(`Invalid month: ${month}`);
  }

  const monthInQuarter = ((month - 1) % 3) + 1;

  if (monthInQuarter < 3) {
    // month is 1, 2, 4, 5, 7, 8, 10, or 11 here — never December, which is
    // always a quarter's third month and handled below. The year can never
    // roll over in this arm.
    const dueYear = year;
    const dueMonth = month + 1;
    return [
      {
        formCode: "0619E",
        periodStart: iso(year, month, 1),
        periodEnd: iso(year, month, lastDayOfMonth(year, month)),
        dueDate: iso(dueYear, dueMonth, 10),
        note: `Month ${monthInQuarter} of the quarter — remitted monthly on 0619-E.`,
      },
    ];
  }

  // Third month: the quarterly return covers the WHOLE quarter, not just this
  // month, and there is no 0619-E for it.
  const quarterStartMonth = month - 2;
  const dueYear = month === 12 ? year + 1 : year;
  const dueMonth = month === 12 ? 1 : month + 1;
  return [
    {
      formCode: "1601EQ",
      periodStart: iso(year, quarterStartMonth, 1),
      periodEnd: iso(year, month, lastDayOfMonth(year, month)),
      dueDate: iso(dueYear, dueMonth, lastDayOfMonth(dueYear, dueMonth)),
      note:
        "Third month of the quarter — no 0619-E. The quarterly return covers all three months " +
        "and carries the QAP.",
    },
  ];
}

// ── QAP ────────────────────────────────────────────────────────────────────

export interface QapPayment {
  payeeTin: string;
  payeeRegisteredName: string;
  atc: string;
  incomePayment: string;
  taxWithheld: string;
  /** Whether we have issued the payee their 2307 for this quarter. */
  certificateIssued: boolean;
}

export interface QapLine {
  payeeTin: string;
  payeeRegisteredName: string;
  atc: string;
  incomePayment: string;
  taxWithheld: string;
  paymentCount: number;
}

export interface Qap {
  periodStart: string;
  periodEnd: string;
  lines: QapLine[];
  totalIncomePayment: string;
  totalTaxWithheld: string;
  paymentCount: number;
  /** Payees we withheld from but have not yet issued a certificate to. */
  certificatesNotIssued: number;
  blockingIssues: string[];
}

/**
 * Build the Quarterly Alphalist of Payees.
 *
 * Grouped by (payee TIN, ATC) — the QAP's own grain, since one supplier can be
 * paid under two ATCs in a quarter and those are separate rows.
 */
export function buildQap(input: {
  periodStart: string;
  periodEnd: string;
  payments: QapPayment[];
}): Qap {
  const grouped = new Map<string, { line: QapLine; payment: ScaledMoney; withheld: ScaledMoney }>();
  let totalPayment = ZERO;
  let totalWithheld = ZERO;
  let notIssued = 0;

  for (const payment of input.payments) {
    // Explicit VISIBLE separator. This used to be an invisible \x01 control
    // byte — it worked, but a control character as a load-bearing delimiter
    // is a trap for every editor, diff, and grep that touches this file.
    const key = `${payment.payeeTin}|${payment.atc}`;
    const amount = toScaled(payment.incomePayment);
    const withheld = toScaled(payment.taxWithheld);

    totalPayment = addAll(totalPayment, amount);
    totalWithheld = addAll(totalWithheld, withheld);
    if (!payment.certificateIssued) notIssued += 1;

    const existing = grouped.get(key);
    if (existing) {
      existing.payment = addAll(existing.payment, amount);
      existing.withheld = addAll(existing.withheld, withheld);
      existing.line.paymentCount += 1;
    } else {
      grouped.set(key, {
        payment: amount,
        withheld,
        line: {
          payeeTin: payment.payeeTin,
          payeeRegisteredName: payment.payeeRegisteredName,
          atc: payment.atc,
          incomePayment: "0",
          taxWithheld: "0",
          paymentCount: 1,
        },
      });
    }
  }

  const lines = [...grouped.values()]
    .map(({ line, payment, withheld }) => ({
      ...line,
      incomePayment: fromScaled(payment),
      taxWithheld: fromScaled(withheld),
    }))
    .sort((a, b) =>
      a.payeeTin === b.payeeTin ? a.atc.localeCompare(b.atc) : a.payeeTin.localeCompare(b.payeeTin),
    );

  const blockingIssues: string[] = [];
  if (notIssued > 0) {
    // Our obligation, not the payee's. §2.58(B) requires the agent to issue the
    // certificate; the payee cannot claim their credit without it.
    blockingIssues.push(
      `${notIssued} payee(s) have not been issued their 2307. We are required to issue it, and ` +
        `without it they cannot claim the credit for tax we already deducted from them.`,
    );
  }
  if (input.payments.length === 0) {
    blockingIssues.push("No payments in the quarter — a nil QAP should be deliberate.");
  }

  return {
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    lines,
    totalIncomePayment: fromScaled(totalPayment),
    totalTaxWithheld: fromScaled(totalWithheld),
    paymentCount: input.payments.length,
    certificatesNotIssued: notIssued,
    blockingIssues,
  };
}

/**
 * Reconcile a quarter's return against its monthly remittances.
 *
 * The 1601-EQ total must equal all three months of withholding, and the two
 * 0619-E remittances are credited against it. A quarter that files only the
 * third month's figure under-reports by two thirds.
 */
export function reconcileQuarter(input: {
  quarterWithheld: string;
  remittedMonth1: string;
  remittedMonth2: string;
}): { stillDue: string; reconciled: boolean; issues: string[] } {
  const total = toScaled(input.quarterWithheld);
  const remitted = addAll(toScaled(input.remittedMonth1), toScaled(input.remittedMonth2));
  const stillDue = (total - remitted) as ScaledMoney;

  const issues: string[] = [];
  if (stillDue < ZERO) {
    issues.push(
      `The monthly remittances (${fromScaled(remitted)}) exceed the quarter's withholding ` +
        `(${input.quarterWithheld}). Either a month was over-remitted or a payment is missing ` +
        `from the quarter.`,
    );
  }

  return { stillDue: fromScaled(stillDue), reconciled: issues.length === 0, issues };
}
