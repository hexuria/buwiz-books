/**
 * Percentage tax, the 8% option, and the ₱3,000,000 threshold — Stage 7.
 *
 * The regime a small taxpayer sits in is a CHOICE with consequences that last
 * the whole year, and the choice is easy to get wrong in ways that are
 * expensive and irreversible.
 *
 * ── THE THREE REGIMES ─────────────────────────────────────────────────────
 *
 * VAT — mandatory above ₱3,000,000 gross sales or receipts. 12% output VAT,
 * creditable input VAT, quarterly 2550Q.
 *
 * PERCENTAGE TAX — for non-VAT taxpayers below the threshold. 1% of gross
 * receipts under CREATE until 30 June 2023, then back to 3%. Quarterly 2551Q.
 * There is no input-tax credit: it is a tax on gross, not on value added.
 *
 * THE 8% OPTION — a self-employed individual or professional below the
 * threshold may elect a flat 8% on gross sales/receipts IN LIEU OF both the
 * graduated income tax AND percentage tax. The election is annual and, once
 * made, IRREVOCABLE for that taxable year.
 *
 * ── WHAT MAKES THE 8% ELECTION DANGEROUS ──────────────────────────────────
 *
 * Three things, all of which this module models rather than assumes:
 *
 *   1. IRREVOCABILITY. Elected in the first quarter, it binds for the year.
 *      A taxpayer who elects it and then has a bad year cannot go back to
 *      graduated rates to use their deductions.
 *   2. THE ₱250,000 DEDUCTION IS NOT UNIVERSAL. A purely self-employed
 *      individual deducts ₱250,000 before applying 8%. A MIXED-income earner —
 *      someone with compensation income as well — does NOT: their ₱250,000 is
 *      already absorbed by the graduated table applied to their salary.
 *      Granting it twice is a common and material error.
 *   3. BREACHING THE THRESHOLD MID-YEAR ends the option automatically. The
 *      taxpayer becomes VAT-registrable prospectively, and the 8% already paid
 *      is credited against the income tax then due — it is not forfeited, and
 *      not a penalty.
 */
import {
  addAll,
  applyRateBps,
  fromScaled,
  toScaled,
  ZERO,
  type ScaledMoney,
  toPesoString,
} from "@/lib/tax/money";

/** The VAT-registration threshold on gross sales or receipts. */
export const VAT_THRESHOLD = "3000000";

/** The ₱250,000 deduction available to a purely self-employed 8% electee. */
export const EIGHT_PERCENT_DEDUCTION = "250000";

export const EIGHT_PERCENT_BPS = 800;

/**
 * Percentage-tax rate by date.
 *
 * CREATE (RA 11534) cut it from 3% to 1% for 1 July 2020 through 30 June 2023.
 * It reverted to 3% on 1 July 2023. A rate applied to the wrong period is a
 * straightforward under- or over-payment, so the rate is a function of the
 * date rather than a constant.
 */
export function percentageTaxRateBps(asOf: string): number {
  if (asOf >= "2020-07-01" && asOf <= "2023-06-30") return 100;
  return 300;
}

export type TaxRegime = "vat" | "percentage_tax" | "eight_percent";

export interface RegimeAssessment {
  regime: TaxRegime | null;
  eligible: TaxRegime[];
  reasons: string[];
  /** Set when the taxpayer must register for VAT. */
  mustRegisterForVat: boolean;
}

export interface RegimeInput {
  /** Gross sales or receipts for the year to date. */
  grossReceipts: string;
  /** Whether the taxpayer is an individual — corporations cannot elect 8%. */
  isIndividual: boolean;
  /** Whether they also earn compensation income. */
  hasCompensationIncome: boolean;
  /** Whether they are already VAT-registered by choice. */
  isVatRegistered: boolean;
  /** Whether the 8% election was made for this taxable year. */
  electedEightPercent?: boolean;
}

/**
 * Which regimes a taxpayer may use, and which they are in.
 *
 * Returns reasons in every case. "Not eligible" and "eligible but not elected"
 * are different situations, and a taxpayer choosing a regime needs to see
 * which one they are in.
 */
export function assessRegime(input: RegimeInput): RegimeAssessment {
  const receipts = toScaled(input.grossReceipts);
  const threshold = toScaled(VAT_THRESHOLD);
  const reasons: string[] = [];
  const eligible: TaxRegime[] = [];

  const overThreshold = receipts > threshold;

  if (overThreshold) {
    reasons.push(
      `Gross receipts of ${input.grossReceipts} exceed the ₱${VAT_THRESHOLD} threshold, so VAT ` +
        `registration is mandatory. The 8% option and percentage tax are no longer available.`,
    );
    return {
      regime: "vat",
      eligible: ["vat"],
      reasons,
      mustRegisterForVat: true,
    };
  }

  eligible.push("percentage_tax");

  if (input.isVatRegistered) {
    reasons.push(
      "Already VAT-registered by choice. A VAT-registered taxpayer cannot use percentage tax " +
        "or the 8% option while the registration stands.",
    );
    return { regime: "vat", eligible: ["vat"], reasons, mustRegisterForVat: false };
  }

  if (input.isIndividual) {
    eligible.push("eight_percent");
    reasons.push(
      "Below the threshold and an individual, so the 8% option is available in lieu of both " +
        "graduated income tax and percentage tax. The election is IRREVOCABLE for the year.",
    );
  } else {
    reasons.push(
      "The 8% option is available only to self-employed individuals and professionals, not to " +
        "corporations.",
    );
  }

  const regime: TaxRegime =
    input.electedEightPercent && input.isIndividual ? "eight_percent" : "percentage_tax";

  return { regime, eligible, reasons, mustRegisterForVat: false };
}

export interface EightPercentComputation {
  grossReceipts: string;
  deductionApplied: string;
  taxableBase: string;
  taxDue: string;
  deductionReason: string;
}

/**
 * Compute the 8% tax.
 *
 * The ₱250,000 deduction is the part that goes wrong. A purely self-employed
 * individual gets it; a MIXED-income earner does not, because the graduated
 * table applied to their compensation has already absorbed it. Granting it to
 * a mixed earner understates tax by ₱20,000 every year and is not obvious from
 * the return.
 */
export function computeEightPercent(input: {
  grossReceipts: string;
  hasCompensationIncome: boolean;
}): EightPercentComputation {
  const receipts = toScaled(input.grossReceipts);

  const deduction = input.hasCompensationIncome ? ZERO : toScaled(EIGHT_PERCENT_DEDUCTION);
  const deductionReason = input.hasCompensationIncome
    ? "No ₱250,000 deduction: the taxpayer earns compensation income, and the graduated table " +
      "applied to that salary has already absorbed it. Granting it here would apply it twice."
    : "₱250,000 deducted — available to a purely self-employed individual.";

  // Clamped: receipts below the deduction produce no tax, not a negative one.
  const rawBase = (receipts - deduction) as ScaledMoney;
  const base = rawBase > ZERO ? rawBase : ZERO;
  const tax = applyRateBps(base, EIGHT_PERCENT_BPS);

  return {
    grossReceipts: fromScaled(receipts),
    deductionApplied: fromScaled(deduction),
    taxableBase: fromScaled(base),
    taxDue: fromScaled(tax),
    deductionReason,
  };
}

export interface PercentageTaxComputation {
  grossReceipts: string;
  rateBps: number;
  taxDue: string;
  note: string;
}

/** Compute percentage tax on gross receipts. */
export function computePercentageTax(input: {
  grossReceipts: string;
  asOf: string;
}): PercentageTaxComputation {
  const rateBps = percentageTaxRateBps(input.asOf);
  const receipts = toScaled(input.grossReceipts);
  return {
    grossReceipts: fromScaled(receipts),
    rateBps,
    taxDue: fromScaled(applyRateBps(receipts, rateBps)),
    note:
      rateBps === 100
        ? "1% under CREATE (RA 11534), which applied from 1 July 2020 to 30 June 2023."
        : "3%, the rate outside the CREATE reduction window.",
  };
}

// ── Threshold monitoring ───────────────────────────────────────────────────

export interface ThresholdStatus {
  grossReceipts: string;
  threshold: string;
  remaining: string;
  /** Fraction of the threshold used, 0–1+, for a progress indicator. */
  utilization: number;
  breached: boolean;
  /** Escalating advice as the threshold approaches. */
  advisory: string | null;
}

/**
 * Monitor progress toward the VAT threshold.
 *
 * Worth watching continuously rather than checking at year end: breaching it
 * makes VAT registration mandatory, and a taxpayer who breaches without
 * noticing has been issuing non-VAT invoices for sales that should have
 * carried VAT — which they then owe out of their own margin, having never
 * collected it.
 */
export function monitorThreshold(grossReceipts: string): ThresholdStatus {
  const receipts = toScaled(grossReceipts);
  const threshold = toScaled(VAT_THRESHOLD);
  const remaining = (threshold - receipts) as ScaledMoney;
  // Ratio via bigint basis points — Number() on scale-8 money loses integer
  // precision past 2^53 and float division is banned on money paths.
  const utilization = Number((receipts * 10000n) / threshold) / 10000;

  let advisory: string | null = null;
  if (receipts > threshold) {
    advisory =
      "Threshold breached. VAT registration is mandatory. Any sales invoiced without VAT after " +
      "the breach still carry the VAT — it comes out of margin, because it was never collected.";
  } else if (utilization >= 0.9) {
    advisory =
      "Within 10% of the threshold. Prepare to register for VAT: registration takes effect " +
      "prospectively and invoices must carry VAT from that point.";
  } else if (utilization >= 0.75) {
    advisory = "Three quarters of the threshold used. Worth planning the VAT transition now.";
  }

  return {
    grossReceipts: fromScaled(receipts),
    threshold: fromScaled(threshold),
    remaining: remaining > ZERO ? fromScaled(remaining) : "0",
    utilization,
    breached: receipts > threshold,
    advisory,
  };
}

/**
 * What happens when an 8% electee breaches the threshold mid-year.
 *
 * The 8% already paid is CREDITED against the income tax then due. It is not
 * forfeited and it is not a penalty — treating it as either overstates what
 * the taxpayer owes at exactly the moment they are least able to absorb it.
 */
export function eightPercentBreachOutcome(input: {
  eightPercentPaid: string;
  incomeTaxDueUnderGraduated: string;
}): { creditable: string; stillDue: string; refundable: string; note: string } {
  const paid = toScaled(input.eightPercentPaid);
  const due = toScaled(input.incomeTaxDueUnderGraduated);
  const difference = (due - paid) as ScaledMoney;

  return {
    creditable: fromScaled(paid),
    stillDue: difference > ZERO ? fromScaled(difference) : "0",
    refundable: difference < ZERO ? fromScaled(-difference as ScaledMoney) : "0",
    note:
      "The 8% already paid is credited against the income tax now due under the graduated " +
      "table. It is not forfeited and the switch is not a penalty.",
  };
}

// ── 2551Q ──────────────────────────────────────────────────────────────────

export interface PercentageTaxReturn {
  quarter: number;
  year: number;
  periodStart: string;
  periodEnd: string;
  dueDate: string;
  grossReceipts: string;
  rateBps: number;
  taxDue: string;
  taxCreditsPayments: string;
  stillDue: string;
  /** Credits/payments beyond the quarter's liability. */
  excessCredits: string;
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
 * Build the quarterly percentage-tax return.
 *
 * 2551Q is due within 25 days after the close of the quarter — the same
 * deadline as 2550Q.
 */
export function buildPercentageTaxReturn(input: {
  quarter: 1 | 2 | 3 | 4;
  year: number;
  grossReceipts: string;
  taxCreditsPayments?: string;
  /** Set when the taxpayer elected 8%, which replaces percentage tax entirely. */
  electedEightPercent?: boolean;
}): PercentageTaxReturn {
  const endMonth = QUARTER_END_MONTH[input.quarter];
  if (!endMonth) throw new Error(`Invalid quarter: ${input.quarter}`);

  const periodStart = iso(input.year, endMonth - 2, 1);
  const periodEnd = iso(input.year, endMonth, lastDayOfMonth(input.year, endMonth));

  const due = new Date(`${periodEnd}T00:00:00Z`);
  due.setUTCDate(due.getUTCDate() + 25);

  const rateBps = percentageTaxRateBps(periodEnd);
  const receipts = toScaled(input.grossReceipts);
  const taxDue = applyRateBps(receipts, rateBps);
  const credits = toScaled(input.taxCreditsPayments ?? "0");
  const stillDue = (taxDue - credits) as ScaledMoney;

  const blockingIssues: string[] = [];
  if (input.electedEightPercent) {
    // Filing both would tax the same receipts twice.
    blockingIssues.push(
      "The 8% option was elected for this year, which is IN LIEU OF percentage tax. Filing a " +
        "2551Q as well would tax the same receipts twice.",
    );
  }
  if (receipts > toScaled(VAT_THRESHOLD)) {
    blockingIssues.push(
      `Gross receipts of ${input.grossReceipts} exceed the ₱${VAT_THRESHOLD} threshold. VAT ` +
        `registration is mandatory and percentage tax no longer applies.`,
    );
  }

  return {
    quarter: input.quarter,
    year: input.year,
    periodStart,
    periodEnd,
    dueDate: due.toISOString().slice(0, 10),
    // Form emission: 2551Q fields are centavo strings.
    grossReceipts: toPesoString(receipts),
    rateBps,
    taxDue: toPesoString(taxDue),
    taxCreditsPayments: toPesoString(credits),
    stillDue: stillDue > ZERO ? toPesoString(stillDue) : "0.00",
    // Credits beyond the liability used to vanish into the "0" above —
    // surfaced so an over-credited quarter is visible and claimable.
    excessCredits: stillDue < ZERO ? toPesoString(-stillDue as ScaledMoney) : "0.00",
    blockingIssues,
  };
}

/** Total gross receipts across a set of periods, exactly. */
export function totalReceipts(amounts: string[]): string {
  return fromScaled(amounts.reduce<ScaledMoney>((sum, a) => addAll(sum, toScaled(a)), ZERO));
}
