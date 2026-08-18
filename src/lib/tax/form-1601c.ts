/**
 * BIR Form 1601-C — Monthly Remittance Return of Income Taxes Withheld on
 * Compensation.
 *
 * The monthly return that carries what the payroll journal credited to
 * withholding-tax-payable. Its central property is a reconciliation, not a
 * computation: the amount remitted must equal the movement in the control
 * account for the month, and must equal the sum of the per-employee detail.
 * A form that merely restates a number the engine produced proves nothing.
 *
 *     Δ withholding tax payable (credits − debits) == Σ per-employee withheld
 *                                                  == the amount on the return
 *
 * DEADLINES ARE NOT UNIFORM, AND GETTING THEM WRONG IS EXPENSIVE. Three rules
 * interact:
 *
 *   1. The base rule is the 10th day of the month following the month withheld.
 *   2. DECEMBER is the exception — it is due 15 January, not 10 January.
 *   3. eFPS filers are staggered by industry group (A–E), one day apart from
 *      the 15th down to the 11th, and a group's own date replaces the base.
 *
 * A return filed late incurs a 25% surcharge, 12% annual interest and a
 * compromise penalty, so a deadline that is silently wrong by a few days is a
 * real cost rather than a cosmetic one. When the filing channel or eFPS group
 * is unknown this returns the EARLIEST applicable date rather than guessing
 * late — the failure mode of being early is nothing at all.
 */
import { addAll, fromScaled, toScaled, ZERO, type ScaledMoney } from "@/lib/tax/money";

/** eFPS staggered filing groups. Group A files last, Group E first. */
export type EfpsGroup = "A" | "B" | "C" | "D" | "E";

export type FilingChannel = "manual" | "ebirforms" | "efps";

/**
 * eFPS deadline day by group, for a non-December month.
 *
 * RR 26-2002 staggers the groups across 11–15. Group A gets the 15th; each
 * later letter files one day earlier.
 */
const EFPS_DAY_BY_GROUP: Record<EfpsGroup, number> = { A: 15, B: 14, C: 13, D: 12, E: 11 };

export interface Form1601CEmployeeLine {
  employeePartyId: string;
  /** Reported (withheld) tax for this employee in the month. */
  taxWithheld: string;
  grossCompensation: string;
  nonTaxableCompensation: string;
}

/** Collapse a payroll line into the three figures 1601-C actually remits. */
export function compensationFromPayrollLine(line: {
  basicSalary?: string | null;
  representationAllowance?: string | null;
  transportationAllowance?: string | null;
  costOfLivingAllowance?: string | null;
  fixedHousingAllowance?: string | null;
  otherTaxableRegular?: string | null;
  commission?: string | null;
  profitSharing?: string | null;
  directorsFees?: string | null;
  overtimePay?: string | null;
  hazardPay?: string | null;
  otherTaxableSupplementary?: string | null;
  basicSalaryMwe?: string | null;
  holidayPayMwe?: string | null;
  overtimePayMwe?: string | null;
  nightShiftDifferentialMwe?: string | null;
  hazardPayMwe?: string | null;
  thirteenthMonthAndOtherBenefits?: string | null;
  deMinimisBenefits?: string | null;
  nonTaxableRetirementSeparation?: string | null;
  otherExempt?: string | null;
  employeePartyId: string;
  reportedTaxWithheld?: string | null;
  computedTaxWithheld?: string | null;
}): Form1601CEmployeeLine {
  const nonTaxable = addAll(
    toScaled(line.basicSalaryMwe ?? "0"),
    toScaled(line.holidayPayMwe ?? "0"),
    toScaled(line.overtimePayMwe ?? "0"),
    toScaled(line.nightShiftDifferentialMwe ?? "0"),
    toScaled(line.hazardPayMwe ?? "0"),
    toScaled(line.thirteenthMonthAndOtherBenefits ?? "0"),
    toScaled(line.deMinimisBenefits ?? "0"),
    toScaled(line.nonTaxableRetirementSeparation ?? "0"),
    toScaled(line.otherExempt ?? "0"),
  );
  const regularAndSupplementary = addAll(
    toScaled(line.basicSalary ?? "0"),
    toScaled(line.representationAllowance ?? "0"),
    toScaled(line.transportationAllowance ?? "0"),
    toScaled(line.costOfLivingAllowance ?? "0"),
    toScaled(line.fixedHousingAllowance ?? "0"),
    toScaled(line.otherTaxableRegular ?? "0"),
    toScaled(line.commission ?? "0"),
    toScaled(line.profitSharing ?? "0"),
    toScaled(line.directorsFees ?? "0"),
    toScaled(line.overtimePay ?? "0"),
    toScaled(line.hazardPay ?? "0"),
    toScaled(line.otherTaxableSupplementary ?? "0"),
  );
  return {
    employeePartyId: line.employeePartyId,
    taxWithheld: line.reportedTaxWithheld ?? line.computedTaxWithheld ?? "0",
    grossCompensation: fromScaled(addAll(regularAndSupplementary, nonTaxable)),
    nonTaxableCompensation: fromScaled(nonTaxable),
  };
}

export interface Form1601CInput {
  /** 1–12. */
  month: number;
  year: number;
  filingChannel: FilingChannel;
  /** Required only for eFPS; ignored otherwise. */
  efpsGroup?: EfpsGroup;
  lines: Form1601CEmployeeLine[];
  /**
   * The movement in the withholding-tax-payable control account for the month,
   * as credits less debits. Null when the period has not been posted, which is
   * itself a blocking issue rather than a pass.
   */
  controlAccountMovement: string | null;
  /** Tax remitted for the same month under a previously filed return. */
  previouslyRemitted?: string;
}

export interface Form1601C {
  month: number;
  year: number;
  periodStart: string;
  periodEnd: string;

  totalCompensation: string;
  nonTaxableCompensation: string;
  taxableCompensation: string;
  taxWithheld: string;
  previouslyRemitted: string;
  stillDue: string;

  employeeCount: number;

  /** The reconciliation the return exists to assert. */
  reconciliation: {
    controlAccountMovement: string | null;
    detailTotal: string;
    difference: string | null;
    reconciled: boolean;
  };

  dueDate: string;
  /** True when the due date is the December exception rather than the base rule. */
  usesDecemberException: boolean;

  blockingIssues: string[];
}

function lastDayOfMonth(year: number, month: number): number {
  // Day 0 of the NEXT month is the last day of this one, and this is UTC so a
  // local timezone west of Greenwich cannot roll it back a day.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function iso(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * The statutory due date, before any weekend or holiday shift.
 *
 * Deliberately does NOT move the date off a weekend. Whether a due date
 * falling on a Saturday moves to the next working day depends on issuances
 * that change, and a hard-coded guess that moves a deadline LATER is the
 * dangerous direction to be wrong in. Callers that need it can apply it with
 * the current rule; being early costs nothing.
 */
export function dueDateFor(
  month: number,
  year: number,
  channel: FilingChannel,
  efpsGroup?: EfpsGroup,
): { dueDate: string; usesDecemberException: boolean } {
  const filingYear = month === 12 ? year + 1 : year;
  const filingMonth = month === 12 ? 1 : month + 1;

  // December is due the 15th of January regardless of channel or group.
  if (month === 12) {
    return { dueDate: iso(filingYear, filingMonth, 15), usesDecemberException: true };
  }

  if (channel === "efps") {
    // Unknown group: take the EARLIEST group day rather than assume the latest.
    const day = efpsGroup ? EFPS_DAY_BY_GROUP[efpsGroup] : EFPS_DAY_BY_GROUP.E;
    return { dueDate: iso(filingYear, filingMonth, day), usesDecemberException: false };
  }

  return { dueDate: iso(filingYear, filingMonth, 10), usesDecemberException: false };
}

export function buildForm1601C(input: Form1601CInput): Form1601C {
  const blockingIssues: string[] = [];

  if (input.month < 1 || input.month > 12 || !Number.isInteger(input.month)) {
    throw new Error(`Invalid month for 1601-C: ${input.month}`);
  }

  let totalCompensation = ZERO;
  let nonTaxable = ZERO;
  let detailTotal = ZERO;

  for (const line of input.lines) {
    totalCompensation = addAll(totalCompensation, toScaled(line.grossCompensation));
    nonTaxable = addAll(nonTaxable, toScaled(line.nonTaxableCompensation));
    detailTotal = addAll(detailTotal, toScaled(line.taxWithheld));
  }

  const taxable = (totalCompensation - nonTaxable) as ScaledMoney;
  if (taxable < ZERO) {
    // Non-taxable exceeding gross is a data error that would otherwise be
    // reported to the BIR as a negative taxable base.
    blockingIssues.push(
      `Non-taxable compensation (${fromScaled(nonTaxable)}) exceeds total compensation ` +
        `(${fromScaled(totalCompensation)}) — the taxable base would be negative.`,
    );
  }

  const previouslyRemitted = toScaled(input.previouslyRemitted ?? "0");
  const stillDue = (detailTotal - previouslyRemitted) as ScaledMoney;

  // ── The reconciliation ───────────────────────────────────────────────────
  const movement = input.controlAccountMovement;
  let difference: string | null = null;
  let reconciled = false;

  if (movement === null) {
    blockingIssues.push(
      "The payroll period has not been posted to the ledger, so the return cannot be " +
        "reconciled against the withholding tax payable control account.",
    );
  } else {
    const delta = (toScaled(movement) - detailTotal) as ScaledMoney;
    difference = fromScaled(delta);
    reconciled = delta === ZERO;
    if (!reconciled) {
      blockingIssues.push(
        `The control account moved by ${movement} but the per-employee detail totals ` +
          `${fromScaled(detailTotal)} — a difference of ${difference}. The return, the ledger ` +
          `and the detail must agree before filing.`,
      );
    }
  }

  if (input.lines.length === 0) {
    // A nil return is legitimate — an employer with no employees that month
    // still files — but it should be a deliberate act, not an empty accident.
    blockingIssues.push(
      "No employee lines. A nil return is legitimate but must be confirmed deliberately.",
    );
  }

  const withoutTin = input.lines.filter((l) => !l.employeePartyId).length;
  if (withoutTin > 0) {
    blockingIssues.push(`${withoutTin} line(s) have no employee identifier.`);
  }

  if (input.filingChannel === "efps" && !input.efpsGroup) {
    // Not fatal — the earliest group date is used — but the filer should know
    // the deadline shown is conservative rather than theirs.
    blockingIssues.push(
      "eFPS filing group is not set. The earliest staggered deadline (Group E) is shown; " +
        "set the group to get the actual date.",
    );
  }

  const { dueDate, usesDecemberException } = dueDateFor(
    input.month,
    input.year,
    input.filingChannel,
    input.efpsGroup,
  );

  return {
    month: input.month,
    year: input.year,
    periodStart: iso(input.year, input.month, 1),
    periodEnd: iso(input.year, input.month, lastDayOfMonth(input.year, input.month)),

    totalCompensation: fromScaled(totalCompensation),
    nonTaxableCompensation: fromScaled(nonTaxable),
    taxableCompensation: fromScaled(taxable),
    taxWithheld: fromScaled(detailTotal),
    previouslyRemitted: fromScaled(previouslyRemitted),
    stillDue: fromScaled(stillDue),

    employeeCount: input.lines.length,

    reconciliation: {
      controlAccountMovement: movement,
      detailTotal: fromScaled(detailTotal),
      difference,
      reconciled,
    },

    dueDate,
    usesDecemberException,
    blockingIssues,
  };
}
