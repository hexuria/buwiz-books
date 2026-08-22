/**
 * Value-added tax — Stage 6.
 *
 * VAT is 12% on the net amount. The arithmetic is trivial; everything that
 * makes this hard is *timing* and *eligibility*, and EOPT changed the timing
 * for services in a way that catches people out.
 *
 * ── THE EOPT SHIFT (RA 11976, RR 3-2024 / RR 7-2024) ──────────────────────
 *
 * Output VAT on the sale of SERVICES used to be due on COLLECTION. Under EOPT
 * it is due on BILLING, like goods have always been. So a service invoice
 * issued in Q1 and collected in Q3 now carries its output VAT in Q1 — a
 * business that keeps filing on collection under-declares every quarter until
 * it is assessed.
 *
 * To stop that bankrupting anyone on paper, EOPT allows a DEDUCTION for VAT on
 * uncollected receivables, but only on conditions, and the deduction is not
 * forgiveness — it is a deferral. When the receivable is later collected, the
 * VAT is added back in the quarter of collection. Booking the deduction and
 * forgetting the add-back understates VAT in exactly the quarter the cash
 * arrived to pay it.
 *
 * That is why `ph_output_vat_uncollected` is a separate control account rather
 * than a contra entry against output VAT: the deferred amount has to stay
 * visible and individually traceable back to the invoice it came from, because
 * each one carries a future obligation.
 *
 * ── INPUT VAT ELIGIBILITY ─────────────────────────────────────────────────
 *
 * Input VAT is creditable only when substantiated by a VAT invoice from a
 * VAT-registered supplier. A supplier who is not VAT-registered cannot pass on
 * VAT at all, so an "input VAT" line on their invoice is not creditable — it is
 * part of the cost. Claiming it is a straightforward disallowance.
 *
 * Capital goods amortisation is GONE. Input VAT on capital goods exceeding
 * ₱1,000,000 used to be spread over 60 months; TRAIN ended that for purchases
 * from 1 January 2022, so it is claimed in full in the period of purchase. This
 * module does not implement amortisation, and says so rather than leaving the
 * absence to be read as an oversight.
 */
import {
  addAll,
  applyRateBps,
  fromScaled,
  toScaled,
  ZERO,
  type ScaledMoney,
} from "@/lib/tax/money";

/**
 * Divide two scaled integers, rounding half away from zero.
 *
 * Used for the VAT-inclusive extraction, where the divisor is 11,200 and no
 * whole-basis-point rate can express 1/1.12 without drift.
 */
function divideExactHalfUp(numerator: bigint, divisor: bigint): ScaledMoney {
  const negative = numerator < 0n;
  const abs = negative ? -numerator : numerator;
  const quotient = abs / divisor;
  const remainder = abs % divisor;
  const rounded = remainder * 2n >= divisor ? quotient + 1n : quotient;
  return (negative ? -rounded : rounded) as ScaledMoney;
}

/** 12%, in basis points. */
export const VAT_RATE_BPS = 1200;

/** The gross-receipts threshold above which VAT registration is mandatory. */
export const VAT_THRESHOLD = "3000000";

export type VatTreatment = "vatable" | "zero_rated" | "exempt";

export interface VatSplit {
  /** Amount before VAT. */
  netAmount: string;
  vatAmount: string;
  grossAmount: string;
}

/**
 * Split a VAT-INCLUSIVE amount into its net and tax parts.
 *
 * The common mistake is computing 12% OF the gross rather than extracting it:
 * ₱1,120 inclusive is ₱1,000 + ₱120, not ₱1,120 + ₱134.40. Dividing by 1.12 is
 * what "VAT-inclusive" means.
 *
 * PRECISION IS DELIBERATELY NOT ROUNDED TO CENTAVOS HERE. 1/1.12 does not
 * terminate, so extracting ₱0.01 gives ₱0.00892857 + ₱0.00107143. That is
 * correct for ACCUMULATION — rounding each line to two decimals and then
 * summing drifts from the quarter's true total. A document that states VAT to
 * a customer must round at the point of presentation, which is the invoice
 * issuance path, not here. The guarantee this function does make is that net
 * and VAT always sum back to the gross exactly.
 */
export function extractVat(grossAmount: string, treatment: VatTreatment = "vatable"): VatSplit {
  const gross = toScaled(grossAmount);
  if (treatment !== "vatable") {
    return { netAmount: fromScaled(gross), vatAmount: "0", grossAmount: fromScaled(gross) };
  }
  // The VAT is computed FIRST and the net derived by subtraction, so the two
  // always sum back to the gross exactly.
  //
  // Deriving net via an inverse rate does not work: 10000/1.12 is 8928.57…
  // basis points, and rounding that to a whole number makes 1,120 extract as
  // 1,000.05 + 119.95. Dividing here instead keeps the identity exact.
  const vat = divideExactHalfUp(gross * BigInt(VAT_RATE_BPS), BigInt(10000 + VAT_RATE_BPS));
  const net = (gross - vat) as ScaledMoney;
  return { netAmount: fromScaled(net), vatAmount: fromScaled(vat), grossAmount: fromScaled(gross) };
}

/** Add VAT to a VAT-EXCLUSIVE amount. */
export function addVat(netAmount: string, treatment: VatTreatment = "vatable"): VatSplit {
  const net = toScaled(netAmount);
  if (treatment !== "vatable") {
    return { netAmount: fromScaled(net), vatAmount: "0", grossAmount: fromScaled(net) };
  }
  const vat = applyRateBps(net, VAT_RATE_BPS);
  return {
    netAmount: fromScaled(net),
    vatAmount: fromScaled(vat),
    grossAmount: fromScaled(addAll(net, vat)),
  };
}

// ── Input VAT eligibility ──────────────────────────────────────────────────

export interface InputVatClaim {
  supplierIsVatRegistered: boolean;
  hasVatInvoice: boolean;
  supplierTin: string | null;
  vatAmount: string;
  /** Whether the purchase relates to exempt sales, which blocks the credit. */
  relatesToExemptSales?: boolean;
}

export interface InputVatEligibility {
  creditable: boolean;
  creditableAmount: string;
  /** Amount that must be expensed or capitalised instead. */
  nonCreditableAmount: string;
  reasons: string[];
}

/**
 * Decide whether input VAT can be credited.
 *
 * A non-creditable amount is not lost — it becomes part of the cost of the
 * purchase. So this returns BOTH figures rather than a boolean, because the
 * caller has to post the non-creditable part somewhere.
 */
export function assessInputVat(claim: InputVatClaim): InputVatEligibility {
  const reasons: string[] = [];
  const amount = toScaled(claim.vatAmount);

  if (!claim.supplierIsVatRegistered) {
    // A non-VAT supplier cannot pass on VAT at all. An "input VAT" line on
    // their invoice is part of the price, and claiming it is a plain
    // disallowance.
    reasons.push(
      "The supplier is not VAT-registered, so they cannot pass on VAT. Any VAT line on their " +
        "invoice is part of the cost, not a creditable input.",
    );
  }
  if (!claim.hasVatInvoice) {
    reasons.push(
      "No VAT invoice on file. Input VAT is creditable only when substantiated — without the " +
        "invoice the credit is disallowed regardless of the ledger.",
    );
  }
  if (!claim.supplierTin) {
    reasons.push("The supplier has no TIN on file; the SLSP cannot report this purchase.");
  }
  if (claim.relatesToExemptSales) {
    reasons.push(
      "The purchase relates to exempt sales, so its input VAT is not creditable and forms part " +
        "of the cost.",
    );
  }

  const creditable = reasons.length === 0;
  return {
    creditable,
    creditableAmount: creditable ? fromScaled(amount) : "0",
    nonCreditableAmount: creditable ? "0" : fromScaled(amount),
    reasons,
  };
}

// ── EOPT uncollected receivables ───────────────────────────────────────────

export interface UncollectedReceivable {
  invoiceId: string;
  invoiceDate: string;
  /** The date payment became contractually due. */
  dueDate: string;
  outputVat: string;
  isServiceSale: boolean;
  /** Whether the sale was already reported in a prior VAT return. */
  alreadyDeclared: boolean;
}

export interface UncollectedDeductionResult {
  eligible: Array<{ invoiceId: string; outputVat: string }>;
  ineligible: Array<{ invoiceId: string; reason: string }>;
  totalDeduction: string;
  notes: string[];
}

/**
 * The EOPT deduction for VAT on uncollected receivables.
 *
 * A DEFERRAL, NOT A FORGIVENESS. Every peso deducted here creates an obligation
 * to add it back when the receivable is collected, which is why the result
 * lists invoices individually rather than returning a single number: the
 * add-back has to be traceable to the invoice that produced it.
 *
 * Eligibility is narrow on purpose. The deduction applies to SERVICE sales
 * whose payment is contractually past due and which were already declared in a
 * prior return — deducting VAT that was never declared subtracts something
 * never added.
 */
export function computeUncollectedDeduction(input: {
  receivables: UncollectedReceivable[];
  /** End of the quarter being filed. */
  periodEnd: string;
}): UncollectedDeductionResult {
  const eligible: Array<{ invoiceId: string; outputVat: string }> = [];
  const ineligible: Array<{ invoiceId: string; reason: string }> = [];
  let total = ZERO;

  for (const receivable of input.receivables) {
    if (!receivable.isServiceSale) {
      // The EOPT relief addresses the shift of SERVICES from collection to
      // billing. Goods were always on billing and carry no equivalent relief.
      ineligible.push({
        invoiceId: receivable.invoiceId,
        reason:
          "Not a service sale. The EOPT deduction exists because services moved from collection " +
          "to billing; goods were always billed and have no equivalent relief.",
      });
      continue;
    }
    if (!receivable.alreadyDeclared) {
      ineligible.push({
        invoiceId: receivable.invoiceId,
        reason:
          "The sale has not been declared in a prior return. Deducting VAT that was never " +
          "declared subtracts something that was never added.",
      });
      continue;
    }
    if (receivable.dueDate > input.periodEnd) {
      ineligible.push({
        invoiceId: receivable.invoiceId,
        reason: `Payment is not yet contractually due (due ${receivable.dueDate}, period ends ${input.periodEnd}).`,
      });
      continue;
    }

    eligible.push({ invoiceId: receivable.invoiceId, outputVat: receivable.outputVat });
    total = addAll(total, toScaled(receivable.outputVat));
  }

  const notes: string[] = [];
  if (eligible.length > 0) {
    notes.push(
      `${eligible.length} receivable(s) deferred, totalling ${fromScaled(total)}. This is a ` +
        `DEFERRAL: each amount must be added back in the quarter its receivable is collected.`,
    );
  }

  return {
    eligible,
    ineligible,
    totalDeduction: fromScaled(total),
    notes,
  };
}

// ── The 2550Q return ───────────────────────────────────────────────────────

export interface VatReturnInput {
  quarter: 1 | 2 | 3 | 4;
  year: number;
  outputVat: string;
  /** EOPT deduction for this quarter. */
  uncollectedDeduction?: string;
  /** VAT added back because a previously deducted receivable was collected. */
  recoveredUncollected?: string;
  creditableInputVat: string;
  /** Excess input VAT carried forward from the previous quarter. */
  inputVatCarryover?: string;
  /** VAT already paid for the quarter, e.g. on an amended return. */
  taxCreditsPayments?: string;
}

export interface VatReturn {
  quarter: number;
  year: number;
  periodStart: string;
  periodEnd: string;
  dueDate: string;

  outputVat: string;
  uncollectedDeduction: string;
  recoveredUncollected: string;
  netOutputVat: string;

  creditableInputVat: string;
  inputVatCarryover: string;
  totalInputVat: string;

  /** Positive: payable. Negative: excess input VAT carried to next quarter. */
  vatPayable: string;
  carryoverToNextQuarter: string;

  blockingIssues: string[];
}

const QUARTER_END_MONTH: Record<number, number> = { 1: 3, 2: 6, 3: 9, 4: 12 };

function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function iso(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * Build the quarterly VAT return.
 *
 * 2550Q is due within 25 days after the close of the quarter. Under EOPT the
 * monthly 2550M was abolished — a filer still submitting monthly is doing work
 * that no longer exists, and one who never adjusted may have gaps.
 */
export function buildVatReturn(input: VatReturnInput): VatReturn {
  const endMonth = QUARTER_END_MONTH[input.quarter];
  if (!endMonth) throw new Error(`Invalid quarter: ${input.quarter}`);

  const startMonth = endMonth - 2;
  const periodStart = iso(input.year, startMonth, 1);
  const periodEnd = iso(input.year, endMonth, lastDayOfMonth(input.year, endMonth));

  // 25 days after quarter close.
  const dueBase = new Date(`${periodEnd}T00:00:00Z`);
  dueBase.setUTCDate(dueBase.getUTCDate() + 25);
  const dueDate = dueBase.toISOString().slice(0, 10);

  const output = toScaled(input.outputVat);
  const deduction = toScaled(input.uncollectedDeduction ?? "0");
  const recovered = toScaled(input.recoveredUncollected ?? "0");
  const netOutput = (output - deduction + recovered) as ScaledMoney;

  const creditableInput = toScaled(input.creditableInputVat);
  const carryover = toScaled(input.inputVatCarryover ?? "0");
  const totalInput = addAll(creditableInput, carryover);
  const credits = toScaled(input.taxCreditsPayments ?? "0");

  const payable = (netOutput - totalInput - credits) as ScaledMoney;

  const blockingIssues: string[] = [];
  if (deduction > output) {
    blockingIssues.push(
      `The uncollected-receivable deduction (${input.uncollectedDeduction}) exceeds output VAT ` +
        `(${input.outputVat}). The deduction can only relieve VAT that was declared.`,
    );
  }
  if (netOutput < ZERO) {
    blockingIssues.push(
      "Net output VAT is negative, which cannot be reported. Check the uncollected deduction " +
        "and the recovered amounts.",
    );
  }

  return {
    quarter: input.quarter,
    year: input.year,
    periodStart,
    periodEnd,
    dueDate,

    outputVat: fromScaled(output),
    uncollectedDeduction: fromScaled(deduction),
    recoveredUncollected: fromScaled(recovered),
    netOutputVat: fromScaled(netOutput),

    creditableInputVat: fromScaled(creditableInput),
    inputVatCarryover: fromScaled(carryover),
    totalInputVat: fromScaled(totalInput),

    // Excess input VAT is carried forward, never refunded on the return.
    vatPayable: payable > ZERO ? fromScaled(payable) : "0",
    carryoverToNextQuarter: payable < ZERO ? fromScaled(-payable as ScaledMoney) : "0",

    blockingIssues,
  };
}

// ── SLSP ───────────────────────────────────────────────────────────────────

export interface SlspEntry {
  tin: string;
  registeredName: string;
  /** Net of VAT. */
  netAmount: string;
  vatAmount: string;
  treatment: VatTreatment;
}

export interface SlspSection {
  lines: Array<SlspEntry & { transactionCount: number }>;
  totalNet: string;
  totalVat: string;
  totalExempt: string;
  totalZeroRated: string;
}

/**
 * Summarise sales or purchases for the SLSP.
 *
 * Grouped by TIN, with vatable, zero-rated and exempt amounts kept apart —
 * they are separate columns on the submission and merging them misstates all
 * three.
 */
export function buildSlspSection(entries: SlspEntry[]): SlspSection {
  const grouped = new Map<
    string,
    { entry: SlspEntry & { transactionCount: number }; net: ScaledMoney; vat: ScaledMoney }
  >();
  let totalNet = ZERO;
  let totalVat = ZERO;
  let totalExempt = ZERO;
  let totalZeroRated = ZERO;

  for (const entry of entries) {
    const net = toScaled(entry.netAmount);
    const vat = toScaled(entry.vatAmount);

    totalNet = addAll(totalNet, net);
    totalVat = addAll(totalVat, vat);
    if (entry.treatment === "exempt") totalExempt = addAll(totalExempt, net);
    if (entry.treatment === "zero_rated") totalZeroRated = addAll(totalZeroRated, net);

    const key = `${entry.tin}|${entry.treatment}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.net = addAll(existing.net, net);
      existing.vat = addAll(existing.vat, vat);
      existing.entry.transactionCount += 1;
    } else {
      grouped.set(key, {
        net,
        vat,
        entry: { ...entry, netAmount: "0", vatAmount: "0", transactionCount: 1 },
      });
    }
  }

  const lines = [...grouped.values()]
    .map(({ entry, net, vat }) => ({
      ...entry,
      netAmount: fromScaled(net),
      vatAmount: fromScaled(vat),
    }))
    .sort((a, b) =>
      a.tin === b.tin ? a.treatment.localeCompare(b.treatment) : a.tin.localeCompare(b.tin),
    );

  return {
    lines,
    totalNet: fromScaled(totalNet),
    totalVat: fromScaled(totalVat),
    totalExempt: fromScaled(totalExempt),
    totalZeroRated: fromScaled(totalZeroRated),
  };
}
