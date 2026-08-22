/**
 * Computing a payroll run — where the engine meets the tables.
 *
 * This is the v1 deliverable in one function: read an imported register, run
 * every employee through the statutory engine, and record `expected vs reported
 * vs delta`. The product is a VERIFIER, not a replacement payroll calculation
 * (DECISIONS D2) — the client keeps computing their own payroll, and buwiz-books
 * says where it disagrees with the law.
 *
 * ── WHAT HAPPENS WHEN THE ENGINE AND THE REGISTER DISAGREE ───────────────────
 * The client's figure is what gets filed. The variance is recorded, the client
 * acknowledges it with a reason, and the period cannot be marked filed while an
 * unacknowledged variance stands (D-N7). The product is the control, not the
 * computer of record — filing our own number over the client's would invert
 * that, and it is their return.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ORDER IS LOAD-BEARING. Employees are processed independently, but each
 * employee's periods must run in order: the cumulative-average method averages
 * over year-to-date accumulators and its latch is one-way, so computing March
 * before February produces a different — wrong — answer. This function
 * therefore computes ONE run and requires that earlier runs already have.
 */
import { and, asc, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { asOf } from "./as-of";
import { computeStatutoryContributions } from "./contributions";
import { runWithholding } from "./engine";
import { toPesoString, toScaled, type ScaledMoney } from "./money";
import type { Bracket, EmployeeYearState, TriggerReason } from "./withholding";
import type { ContributionCheckStatus } from "../../db/schema/payroll";
import {
  payrollEmployeeYearState,
  payrollLines,
  payrollRuns,
  previousEmployer2316,
} from "../../db/schema/payroll";
import { taxWithholdingTables, type PayrollPeriod } from "../../db/schema/tax-reference";

type Db = PostgresJsDatabase<Record<string, unknown>>;

export class PayrollRunNotFoundError extends Error {
  constructor(runId: string) {
    super(`payroll run ${runId} not found in this organization`);
    this.name = "PayrollRunNotFoundError";
  }
}

export class PayrollRunLockedError extends Error {
  constructor(runId: string, status: string) {
    super(`payroll run ${runId} is ${status} and cannot be recomputed`);
    this.name = "PayrollRunLockedError";
  }
}

export class MissingPreviousEmployerError extends Error {
  constructor(count: number) {
    super(
      `${count} employee(s) were hired mid-year with a previous employer but have no 2316 on file — ` +
        `the cumulative average method cannot run without it, and the year-end annualization would ` +
        `credit too little tax`,
    );
    this.name = "MissingPreviousEmployerError";
  }
}

export interface ComputePayrollRunResult {
  runId: string;
  linesComputed: number;
  /** Lines where the engine and the register disagree. */
  variances: number;
  /** Sum of |delta| across the run, for a headline figure. */
  totalVariancePesos: string;
  /** Sum of what the engine says should be withheld. */
  totalComputedPesos: string;
  /** Sum of what the register reported. Null when the register carried no figures. */
  totalReportedPesos: string | null;
  /**
   * Lines whose reported statutory contributions disagree with the schedule.
   *
   * Counted separately from tax variances because it is a DIFFERENT finding
   * with a different remedy: the tax may be arithmetically correct on a base
   * that was itself wrong.
   */
  contributionVariances: number;
  /** Lines the contribution check did not run on, and why. */
  contributionChecksSkipped: number;
}

/**
 * Check the register's statutory contributions against the schedule.
 *
 * Runs only on MONTHLY periods. SSS, PhilHealth and Pag-IBIG are monthly
 * obligations, so a semi-monthly or weekly period carries a fraction of the
 * monthly amount and employers split it by differing conventions — comparing
 * per-period would manufacture variances that are not errors. Skipping is
 * recorded rather than silent, so an unchecked line never reads as a clean one.
 */
function checkContributions(
  line: typeof payrollLines.$inferSelect,
  period: PayrollPeriod,
  grossCompensation: ScaledMoney,
): {
  status: ContributionCheckStatus;
  expected?: ReturnType<typeof computeStatutoryContributions>;
  variance?: ScaledMoney;
  philHealthBase?: string;
} {
  if (period !== "monthly") return { status: "skipped_non_monthly" };

  const reportedParts = [
    line.sssEmployeeShare,
    line.philHealthEmployeeShare,
    line.pagIbigEmployeeShare,
  ];
  // Nothing reported is not agreement — there is simply nothing to compare.
  if (reportedParts.every((p) => p == null)) return { status: "skipped_not_reported" };

  // PhilHealth's base is the fixed basic rate, NOT gross compensation: it
  // excludes commission, overtime, allowances, 13th month and bonuses.
  const philHealthBase = line.basicSalary;
  const expected = computeStatutoryContributions({
    monthlyCompensation: toPesoString(grossCompensation),
    monthlyBasicSalary: philHealthBase,
  });

  const reported = reportedParts.reduce(
    (total, part) => (total + toScaled(part ?? "0")) as ScaledMoney,
    toScaled("0"),
  );
  const variance = (toScaled(expected.totalEmployeePesos) - reported) as ScaledMoney;

  return { status: "checked", expected, variance, philHealthBase };
}

/**
 * Load the bracket table for a period, resolved at the run's END date.
 *
 * The end date, not the start: the annex generation keys on the date
 * compensation is PAID, and a run straddling 31 December would otherwise
 * resolve to the wrong generation for its own payments.
 */
async function loadBrackets(db: Db, period: PayrollPeriod, periodEnd: string): Promise<Bracket[]> {
  const at = asOf(periodEnd);
  const rows = await db
    .select()
    .from(taxWithholdingTables)
    .where(eq(taxWithholdingTables.payrollPeriod, period))
    .orderBy(asc(taxWithholdingTables.bracketIndex));

  return rows
    .filter((r) => r.effectiveFrom <= at && (r.effectiveTo == null || r.effectiveTo >= at))
    .map((r) => ({
      bracketIndex: r.bracketIndex,
      floorAmount: r.floorAmount,
      prescribedTax: r.prescribedTax,
      rateBps: r.rateBps,
    }));
}

/** Every column that feeds the three-bucket segregation, as the engine expects it. */
function toCompensationInput(line: typeof payrollLines.$inferSelect) {
  return {
    regular: {
      basicSalary: line.basicSalary,
      representationAllowance: line.representationAllowance ?? undefined,
      transportationAllowance: line.transportationAllowance ?? undefined,
      costOfLivingAllowance: line.costOfLivingAllowance ?? undefined,
      fixedHousingAllowance: line.fixedHousingAllowance ?? undefined,
      otherTaxableRegular: line.otherTaxableRegular ?? undefined,
    },
    supplementary: {
      commission: line.commission ?? undefined,
      profitSharing: line.profitSharing ?? undefined,
      directorsFees: line.directorsFees ?? undefined,
      overtimePay: line.overtimePay ?? undefined,
      hazardPay: line.hazardPay ?? undefined,
      otherTaxableSupplementary: line.otherTaxableSupplementary ?? undefined,
    },
    nonTaxable: {
      basicSalaryMwe: line.basicSalaryMwe ?? undefined,
      holidayPayMwe: line.holidayPayMwe ?? undefined,
      overtimePayMwe: line.overtimePayMwe ?? undefined,
      nightShiftDifferentialMwe: line.nightShiftDifferentialMwe ?? undefined,
      hazardPayMwe: line.hazardPayMwe ?? undefined,
      thirteenthMonthAndOtherBenefits: line.thirteenthMonthAndOtherBenefits ?? undefined,
      deMinimisBenefits: line.deMinimisBenefits ?? undefined,
      nonTaxableRetirementSeparation: line.nonTaxableRetirementSeparation ?? undefined,
      otherExempt: line.otherExempt ?? undefined,
    },
    // Employee share only. The engine nets these off gross regular to reach the
    // taxable base — there is no input meaning "already netted", which is what
    // makes the BIR calculator's trap unreachable here.
    mandatoryContributions: {
      sss: line.sssEmployeeShare ?? undefined,
      philHealth: line.philHealthEmployeeShare ?? undefined,
      pagIbig: line.pagIbigEmployeeShare ?? undefined,
      unionDues: line.unionDues ?? undefined,
    },
  };
}

/**
 * Compute one payroll run: engine figures, variances, and the advanced state.
 *
 * Idempotent. Recomputing a run rewrites its computed figures and rebuilds the
 * year-state from the prior period's, so a corrected import can simply be
 * recomputed rather than unwound.
 */
export async function computePayrollRun(
  db: Db,
  organizationId: string,
  runId: string,
): Promise<ComputePayrollRunResult> {
  const [run] = await db
    .select()
    .from(payrollRuns)
    .where(and(eq(payrollRuns.id, runId), eq(payrollRuns.organizationId, organizationId)));

  if (!run) throw new PayrollRunNotFoundError(runId);
  // A locked run backs a filed return. Recomputing it would change a figure
  // already reported to the BIR; an amendment is a separate, deliberate act.
  if (run.status === "locked") throw new PayrollRunLockedError(runId, run.status);

  const brackets = await loadBrackets(db, run.payrollPeriod, run.periodEnd);
  const annualBrackets = run.isAnnualizationRun
    ? await loadBrackets(db, "annual", run.periodEnd)
    : [];

  const lines = await db
    .select()
    .from(payrollLines)
    .where(
      and(eq(payrollLines.payrollRunId, runId), eq(payrollLines.organizationId, organizationId)),
    )
    .orderBy(asc(payrollLines.employeePartyId));

  let variances = 0;
  let totalVariance = toScaled("0");
  let totalComputed = toScaled("0");
  let totalReported = toScaled("0");
  let anyReported = false;
  let contributionVariances = 0;
  let contributionChecksSkipped = 0;
  const missingPrevious: string[] = [];

  for (const line of lines) {
    const state = await loadOrCreateYearState(
      db,
      organizationId,
      line.employeePartyId,
      run.taxableYear,
    );

    // A mid-year hire whose prior 2316 is missing cannot be computed correctly:
    // the cumulative method's numerator and divisor are both short. Collect
    // them all rather than failing on the first, so one pass tells the
    // bookkeeper every employee to chase.
    if (
      state.previousEmployer === null &&
      (await hasPriorEmployerGap(db, organizationId, line, run))
    ) {
      missingPrevious.push(line.employeePartyId);
      continue;
    }

    const result = runWithholding({
      compensation: toCompensationInput(line),
      period: run.payrollPeriod,
      periodEnd: run.periodEnd,
      brackets,
      state,
      annualize: run.isAnnualizationRun ? { trigger: "year_end", annualBrackets } : undefined,
    });

    const computed = toScaled(result.taxPesos);
    totalComputed = (totalComputed + computed) as ScaledMoney;

    // A register with no reported figure is not a zero variance — it is an
    // absent comparison, and conflating the two would report a clean run.
    const reported = line.reportedTaxWithheld == null ? null : toScaled(line.reportedTaxWithheld);
    let variance: ScaledMoney | null = null;
    if (reported !== null) {
      anyReported = true;
      totalReported = (totalReported + reported) as ScaledMoney;
      variance = (computed - reported) as ScaledMoney;
      if (variance !== 0n) {
        variances += 1;
        totalVariance = (totalVariance + (variance < 0n ? -variance : variance)) as ScaledMoney;
      }
    }

    // Independently of whether the tax arithmetic is right, are the deductions
    // it was computed on right? A wrong contribution makes the taxable base
    // wrong, and because the engine nets the REPORTED figure the tax variance
    // would read zero — both wrong, consistently.
    const contribution = checkContributions(
      line,
      run.payrollPeriod,
      result.segregated.grossCompensation,
    );
    if (contribution.status === "checked") {
      if (contribution.variance !== 0n) contributionVariances += 1;
    } else {
      contributionChecksSkipped += 1;
    }

    await db
      .update(payrollLines)
      .set({
        computedTaxWithheld: result.taxPesos,
        contributionCheckStatus: contribution.status,
        expectedSssEmployeeShare: contribution.expected?.sss.employeePesos ?? null,
        expectedPhilHealthEmployeeShare: contribution.expected?.philHealth.employeePesos ?? null,
        expectedPagIbigEmployeeShare: contribution.expected?.pagIbig.employeePesos ?? null,
        expectedSssEmployerShare: contribution.expected?.sss.employerPesos ?? null,
        expectedPhilHealthEmployerShare: contribution.expected?.philHealth.employerPesos ?? null,
        expectedPagIbigEmployerShare: contribution.expected?.pagIbig.employerPesos ?? null,
        contributionVarianceAmount:
          contribution.variance === undefined ? null : toPesoString(contribution.variance),
        philHealthBaseUsed: contribution.philHealthBase ?? null,
        varianceAmount: variance === null ? null : toPesoString(variance),
        withholdingPath: result.path,
        cumulativeDivisor:
          result.path === "cumulative_average" && result.computation
            ? (result.computation as { periods?: number }).periods
            : null,
        updatedAt: new Date(),
      })
      .where(eq(payrollLines.id, line.id));

    await persistYearState(
      db,
      organizationId,
      line.employeePartyId,
      run.taxableYear,
      result.nextState,
    );
  }

  if (missingPrevious.length > 0) throw new MissingPreviousEmployerError(missingPrevious.length);

  await db
    .update(payrollRuns)
    .set({ status: "computed", computedAt: new Date(), updatedAt: new Date() })
    .where(eq(payrollRuns.id, runId));

  return {
    runId,
    linesComputed: lines.length,
    variances,
    totalVariancePesos: toPesoString(totalVariance),
    totalComputedPesos: toPesoString(totalComputed),
    totalReportedPesos: anyReported ? toPesoString(totalReported) : null,
    contributionVariances,
    contributionChecksSkipped,
  };
}

/**
 * Whether this employee looks like a mid-year hire with prior employment but no
 * 2316 on file.
 *
 * Deliberately conservative: it only fires when a year-state row exists showing
 * no periods yet elapsed AND the run is not the year's first period. An
 * employee genuinely starting their first job mid-year has no prior employer
 * and must not be blocked.
 */
async function hasPriorEmployerGap(
  db: Db,
  organizationId: string,
  line: typeof payrollLines.$inferSelect,
  run: typeof payrollRuns.$inferSelect,
): Promise<boolean> {
  if (run.periodIndex <= 1) return false;
  const [state] = await db
    .select()
    .from(payrollEmployeeYearState)
    .where(
      and(
        eq(payrollEmployeeYearState.organizationId, organizationId),
        eq(payrollEmployeeYearState.employeePartyId, line.employeePartyId),
        eq(payrollEmployeeYearState.taxableYear, run.taxableYear),
      ),
    );
  // Nothing accumulated yet in a year already underway means the employee
  // joined mid-year. Whether they had a prior employer is a question only the
  // 2316 answers — so the run stops and asks.
  return state != null && state.periodsElapsed === 0 && Number(state.ytdTaxableRegular) === 0;
}

async function loadOrCreateYearState(
  db: Db,
  organizationId: string,
  employeePartyId: string,
  taxableYear: number,
): Promise<EmployeeYearState> {
  const [row] = await db
    .select()
    .from(payrollEmployeeYearState)
    .where(
      and(
        eq(payrollEmployeeYearState.organizationId, organizationId),
        eq(payrollEmployeeYearState.employeePartyId, employeePartyId),
        eq(payrollEmployeeYearState.taxableYear, taxableYear),
      ),
    );

  const [prior] = await db
    .select()
    .from(previousEmployer2316)
    .where(
      and(
        eq(previousEmployer2316.organizationId, organizationId),
        eq(previousEmployer2316.employeePartyId, employeePartyId),
        eq(previousEmployer2316.taxableYear, taxableYear),
      ),
    );

  const previousEmployer = prior
    ? {
        taxableCompensation: prior.taxableCompensation,
        taxWithheld: prior.taxWithheld,
        // The Step 2 divisor contribution, read from the 2316 rather than the
        // calendar — an employment gap makes the calendar reading wrong.
        periodsCovered: prior.periodsCovered,
        employmentFrom: prior.employmentFrom,
        employmentTo: prior.employmentTo,
      }
    : null;

  if (!row) {
    return {
      taxableYear,
      method: "regular",
      latchedReason: null,
      latchedAtPeriodEnd: null,
      ytdTaxableRegular: "0",
      ytdTaxableSupplementary: "0",
      ytdTaxWithheld: "0",
      periodsElapsed: 0,
      previousEmployer,
    };
  }

  return {
    taxableYear,
    method: row.withholdingMethod,
    latchedReason: (row.latchedReason as TriggerReason | null) ?? null,
    latchedAtPeriodEnd: row.latchedAtPeriodEnd,
    ytdTaxableRegular: row.ytdTaxableRegular,
    ytdTaxableSupplementary: row.ytdTaxableSupplementary,
    ytdTaxWithheld: row.ytdTaxWithheld,
    periodsElapsed: row.periodsElapsed,
    previousEmployer,
  };
}

async function persistYearState(
  db: Db,
  organizationId: string,
  employeePartyId: string,
  taxableYear: number,
  next: EmployeeYearState,
): Promise<void> {
  await db
    .insert(payrollEmployeeYearState)
    .values({
      organizationId,
      employeePartyId,
      taxableYear,
      withholdingMethod: next.method,
      latchedReason: next.latchedReason,
      latchedAtPeriodEnd: next.latchedAtPeriodEnd,
      ytdTaxableRegular: next.ytdTaxableRegular,
      ytdTaxableSupplementary: next.ytdTaxableSupplementary,
      ytdTaxWithheld: next.ytdTaxWithheld,
      periodsElapsed: next.periodsElapsed,
    })
    .onConflictDoUpdate({
      target: [
        payrollEmployeeYearState.organizationId,
        payrollEmployeeYearState.employeePartyId,
        payrollEmployeeYearState.taxableYear,
      ],
      set: {
        withholdingMethod: next.method,
        latchedReason: next.latchedReason,
        latchedAtPeriodEnd: next.latchedAtPeriodEnd,
        ytdTaxableRegular: next.ytdTaxableRegular,
        ytdTaxableSupplementary: next.ytdTaxableSupplementary,
        ytdTaxWithheld: next.ytdTaxWithheld,
        periodsElapsed: next.periodsElapsed,
        updatedAt: new Date(),
      },
    });
}
