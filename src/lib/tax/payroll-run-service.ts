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
import { and, asc, eq, inArray, isNotNull, ne } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { asOf, pickInForce } from "./as-of";
import { computeStatutoryContributions } from "./contributions";
import type { AnnualizationEntry } from "@/lib/tax/annualization-posting-summary";
import { runWithholding } from "./engine";
import { toPesoString, toScaled, type ScaledMoney, fromScaled } from "./money";
import { BENEFITS_CEILING_PESOS } from "./benefits";
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
  /**
   * Present only on an annualization run: the per-employee true-up figures
   * (positive = refund owed to the employee, negative = deficiency), ready
   * for postAnnualization. Deriving them here — where the annualized engine
   * result is in hand — is what finally makes the year-end posting reachable.
   */
  annualizationEntries?: AnnualizationEntry[];
}

/**
 * Statutory-contribution check.
 *
 * SSS, PhilHealth and Pag-IBIG are MONTHLY obligations. For a monthly run the
 * check runs directly. For semi-monthly, the expected figures are computed on
 * the MONTH's combined lines and recognized on the run that completes the
 * month (checkpoint C4) — the opening half records "deferred_month_end"
 * rather than silently skipping, which previously wrote NULL employer shares
 * and posted zero employer contribution expense for the most common PH
 * cadence. Other cadences remain recorded skips.
 *
 * The MSC base EXCLUDES 13th month pay, de minimis and retirement/separation
 * pay: bracketing December's 13th month into the salary credit overstated
 * both shares. PhilHealth's base is basic salary — including the MWE basic
 * wage, which the old `line.basicSalary` read missed entirely for
 * minimum-wage earners.
 */
type ContributionLineSlice = Pick<
  typeof payrollLines.$inferSelect,
  | "basicSalary"
  | "basicSalaryMwe"
  | "holidayPayMwe"
  | "overtimePayMwe"
  | "nightShiftDifferentialMwe"
  | "hazardPayMwe"
  | "representationAllowance"
  | "transportationAllowance"
  | "costOfLivingAllowance"
  | "fixedHousingAllowance"
  | "otherTaxableRegular"
  | "commission"
  | "profitSharing"
  | "directorsFees"
  | "overtimePay"
  | "hazardPay"
  | "otherTaxableSupplementary"
  | "sssEmployeeShare"
  | "philHealthEmployeeShare"
  | "pagIbigEmployeeShare"
>;

function contributionBase(lines: ContributionLineSlice[]): {
  msc: ScaledMoney;
  basic: ScaledMoney;
} {
  let msc = toScaled("0");
  let basic = toScaled("0");
  const compColumns: Array<keyof ContributionLineSlice> = [
    "basicSalary",
    "basicSalaryMwe",
    "holidayPayMwe",
    "overtimePayMwe",
    "nightShiftDifferentialMwe",
    "hazardPayMwe",
    "representationAllowance",
    "transportationAllowance",
    "costOfLivingAllowance",
    "fixedHousingAllowance",
    "otherTaxableRegular",
    "commission",
    "profitSharing",
    "directorsFees",
    "overtimePay",
    "hazardPay",
    "otherTaxableSupplementary",
  ];
  for (const line of lines) {
    for (const column of compColumns) {
      msc = (msc + toScaled((line[column] as string | null) ?? "0")) as ScaledMoney;
    }
    basic = (basic +
      toScaled(line.basicSalary ?? "0") +
      toScaled(line.basicSalaryMwe ?? "0")) as ScaledMoney;
  }
  return { msc, basic };
}

function checkContributions(
  line: typeof payrollLines.$inferSelect,
  period: PayrollPeriod,
  monthSibling: typeof payrollLines.$inferSelect | null,
): {
  status: ContributionCheckStatus;
  expected?: ReturnType<typeof computeStatutoryContributions>;
  variance?: ScaledMoney;
  philHealthBase?: string;
} {
  const isSemiMonthly = period === "semi_monthly";
  if (period !== "monthly" && !isSemiMonthly) return { status: "skipped_non_monthly" };
  if (isSemiMonthly && monthSibling === undefined) return { status: "skipped_non_monthly" };
  if (isSemiMonthly && monthSibling === null) return { status: "deferred_month_end" };

  const monthLines = isSemiMonthly ? [monthSibling!, line] : [line];
  const reportedParts = monthLines.flatMap((l) => [
    l.sssEmployeeShare,
    l.philHealthEmployeeShare,
    l.pagIbigEmployeeShare,
  ]);
  // Nothing reported is not agreement — there is simply nothing to compare.
  if (reportedParts.every((p) => p == null)) return { status: "skipped_not_reported" };

  const base = contributionBase(monthLines);
  const philHealthBase = toPesoString(base.basic);
  const expected = computeStatutoryContributions({
    monthlyCompensation: toPesoString(base.msc),
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
export async function loadBrackets(
  db: Db,
  period: PayrollPeriod,
  periodEnd: string,
): Promise<Bracket[]> {
  const at = asOf(periodEnd);
  const rows = await db
    .select()
    .from(taxWithholdingTables)
    .where(eq(taxWithholdingTables.payrollPeriod, period))
    .orderBy(asc(taxWithholdingTables.bracketIndex));

  // Two dataset generations can BOTH be in force for the as-of date (a
  // corrected table is issued without end-dating the old one). A plain
  // in-force filter then returns the union of both generations' rows and the
  // engine walks a table with duplicate/contradictory brackets. Resolve each
  // bracket index through pickInForce — "the most recent issuance wins" —
  // exactly like every other dated reference read.
  const byIndex = new Map<number, (typeof rows)[number][]>();
  for (const row of rows) {
    const bucket = byIndex.get(row.bracketIndex);
    if (bucket) bucket.push(row);
    else byIndex.set(row.bracketIndex, [row]);
  }
  const picked = [...byIndex.values()]
    .map((candidates) => pickInForce(candidates, at))
    .filter((row): row is NonNullable<typeof row> => row !== null);

  return picked
    .sort((a, b) => a.bracketIndex - b.bracketIndex)
    .map((r) => ({
      bracketIndex: r.bracketIndex,
      floorAmount: r.floorAmount,
      prescribedTax: r.prescribedTax,
      rateBps: r.rateBps,
    }));
}

/**
 * The ₱90,000 ceiling on 13th month + other benefits is ANNUAL, and the
 * register import supplies one uncapped figure. Split it against the
 * employee's remaining YEAR-TO-DATE headroom: the portion inside the ceiling
 * stays non-taxable, the excess becomes supplementary taxable income
 * (`taxableThirteenthMonthAndOtherBenefits`, the engine input that existed
 * for exactly this and was never wired). Testing a single period's figure
 * against ₱90,000 — the old behavior, headroom fixed at the full ceiling —
 * under-withheld anyone who crossed the ceiling across several runs.
 */
export function splitBenefitsAgainstCeiling(
  amount: string | null,
  ytdBenefitsBefore: ScaledMoney,
): { nonTaxable: string; taxableExcess: string } {
  const benefits = toScaled(amount ?? "0");
  const ceiling = toScaled(BENEFITS_CEILING_PESOS);
  const headroomRaw = (ceiling - ytdBenefitsBefore) as ScaledMoney;
  const headroom = headroomRaw > 0n ? headroomRaw : (0n as ScaledMoney);
  const nonTaxable = benefits < headroom ? benefits : headroom;
  const taxableExcess = (benefits - nonTaxable) as ScaledMoney;
  return { nonTaxable: fromScaled(nonTaxable), taxableExcess: fromScaled(taxableExcess) };
}

/** Every column that feeds the three-bucket segregation, as the engine expects it. */
function toCompensationInput(
  line: typeof payrollLines.$inferSelect,
  ytdBenefitsBefore: ScaledMoney = 0n as ScaledMoney,
) {
  const benefitsSplit = splitBenefitsAgainstCeiling(
    line.thirteenthMonthAndOtherBenefits,
    ytdBenefitsBefore,
  );
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
      taxableThirteenthMonthAndOtherBenefits: benefitsSplit.taxableExcess,
    },
    nonTaxable: {
      basicSalaryMwe: line.basicSalaryMwe ?? undefined,
      holidayPayMwe: line.holidayPayMwe ?? undefined,
      overtimePayMwe: line.overtimePayMwe ?? undefined,
      nightShiftDifferentialMwe: line.nightShiftDifferentialMwe ?? undefined,
      hazardPayMwe: line.hazardPayMwe ?? undefined,
      thirteenthMonthAndOtherBenefits: benefitsSplit.nonTaxable,
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
 * Compute one payroll run: engine figures, variances, and the year state.
 *
 * IDEMPOTENT BY REPLAY. The starting state for every employee is rebuilt by
 * folding the engine over the year's computed runs with a LOWER period index
 * — never read from the persisted row, which already contains this run's own
 * contribution after a first compute. The old advance-what-is-persisted
 * design double-counted on every recompute: periodsElapsed grew, YTD doubled,
 * and the cumulative-average divisor drifted for the rest of the year.
 * Replay is O(periods²) in the worst case — at most 24 periods, immaterial —
 * and makes recomputing ANY period safe in any order.
 *
 * After computing, the persisted year-state row is rebuilt THROUGH EVERY
 * computed period of the year (including this one), so readers like the
 * filing workspace always see "YTD through the latest computed period", even
 * after a mid-year recompute.
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

  // Every computed run of the year EXCEPT this one, with its lines, ordered
  // by period index — the replay source.
  const priorRuns = await db
    .select()
    .from(payrollRuns)
    .where(
      and(
        eq(payrollRuns.organizationId, organizationId),
        eq(payrollRuns.taxableYear, run.taxableYear),
        isNotNull(payrollRuns.computedAt),
        ne(payrollRuns.id, run.id),
      ),
    )
    .orderBy(asc(payrollRuns.periodIndex));
  const priorLinesByRun = new Map<string, Array<typeof payrollLines.$inferSelect>>();
  if (priorRuns.length > 0) {
    const priorLines = await db
      .select()
      .from(payrollLines)
      .where(
        and(
          eq(payrollLines.organizationId, organizationId),
          inArray(
            payrollLines.payrollRunId,
            priorRuns.map((r) => r.id),
          ),
        ),
      );
    for (const line of priorLines) {
      const bucket = priorLinesByRun.get(line.payrollRunId) ?? [];
      bucket.push(line);
      priorLinesByRun.set(line.payrollRunId, bucket);
    }
  }
  const bracketCache = new Map<string, Bracket[]>();
  const bracketsFor = async (period: PayrollPeriod, periodEnd: string): Promise<Bracket[]> => {
    const key = `${period}|${periodEnd}`;
    let cached = bracketCache.get(key);
    if (!cached) {
      cached = await loadBrackets(db, period, periodEnd);
      bracketCache.set(key, cached);
    }
    return cached;
  };

  /** Fold the engine over the employee's lines in runs with periodIndex below the bound. */
  // Opening balances: an org migrating mid-year has history that exists in
  // no payroll_lines row. The opening_* columns are immutable inputs written
  // by the import path; the replay starts from them, and the engine's own
  // persistence never touches them.
  const openingRows = await db
    .select()
    .from(payrollEmployeeYearState)
    .where(
      and(
        eq(payrollEmployeeYearState.organizationId, organizationId),
        eq(payrollEmployeeYearState.taxableYear, run.taxableYear),
        isNotNull(payrollEmployeeYearState.openingPeriodsElapsed),
      ),
    );
  const openingByEmployee = new Map(openingRows.map((row) => [row.employeePartyId, row]));

  const ytdBenefitsByEmployee = new Map<string, ScaledMoney>();

  const replayState = async (
    employeePartyId: string,
    previousEmployer: EmployeeYearState["previousEmployer"],
    beforePeriodIndex: number,
  ): Promise<EmployeeYearState> => {
    const opening = openingByEmployee.get(employeePartyId);
    let state: EmployeeYearState = {
      taxableYear: run.taxableYear,
      method: opening?.withholdingMethod ?? "regular",
      latchedReason: (opening?.latchedReason as TriggerReason | null) ?? null,
      latchedAtPeriodEnd: opening?.latchedAtPeriodEnd ?? null,
      ytdTaxableRegular: opening?.openingYtdTaxableRegular ?? "0",
      ytdTaxableSupplementary: opening?.openingYtdTaxableSupplementary ?? "0",
      ytdTaxWithheld: opening?.openingYtdTaxWithheld ?? "0",
      periodsElapsed: opening?.openingPeriodsElapsed ?? 0,
      previousEmployer,
    };
    let ytdBenefits = 0n as ScaledMoney;
    for (const prior of priorRuns) {
      if (prior.periodIndex >= beforePeriodIndex) continue;
      const priorLine = (priorLinesByRun.get(prior.id) ?? []).find(
        (l) => l.employeePartyId === employeePartyId,
      );
      if (!priorLine) continue;
      const priorResult = runWithholding({
        compensation: toCompensationInput(priorLine, ytdBenefits),
        period: prior.payrollPeriod,
        periodEnd: prior.periodEnd,
        brackets: await bracketsFor(prior.payrollPeriod, prior.periodEnd),
        state,
        annualize: prior.isAnnualizationRun
          ? { trigger: "year_end", annualBrackets: await bracketsFor("annual", prior.periodEnd) }
          : undefined,
      });
      state = priorResult.nextState;
      ytdBenefits = (ytdBenefits +
        toScaled(priorLine.thirteenthMonthAndOtherBenefits ?? "0")) as ScaledMoney;
    }
    ytdBenefitsByEmployee.set(employeePartyId, ytdBenefits);
    return state;
  };

  // Month-completing pairing for semi-monthly contribution checks: the
  // sibling is the immediately preceding period index. `undefined` marks a
  // first half (defer); a Map entry marks a completing half.
  const isMonthCompleting = run.payrollPeriod === "semi_monthly" && run.periodIndex % 2 === 0;
  const siblingLines = new Map<string, typeof payrollLines.$inferSelect>();
  if (isMonthCompleting) {
    const sibling = priorRuns.find((r) => r.periodIndex === run.periodIndex - 1);
    for (const line of sibling ? (priorLinesByRun.get(sibling.id) ?? []) : []) {
      siblingLines.set(line.employeePartyId, line);
    }
  }

  // ── Pass 1: rebuild every starting state; collect gaps BEFORE any write. ──
  const startingStates = new Map<string, EmployeeYearState>();
  const missingPrevious: string[] = [];
  for (const line of lines) {
    const previousEmployer = await loadPreviousEmployer(
      db,
      organizationId,
      line.employeePartyId,
      run.taxableYear,
    );
    const state = await replayState(line.employeePartyId, previousEmployer, run.periodIndex);
    // A mid-year first appearance with no prior employer on file cannot be
    // computed correctly: the cumulative method's numerator and divisor are
    // both short. The old check required a persisted year-state row and so
    // could NEVER fire for a first-time employee — the one case it existed
    // for (DECISIONS D7).
    if (run.periodIndex > 1 && state.periodsElapsed === 0 && previousEmployer === null) {
      missingPrevious.push(line.employeePartyId);
      continue;
    }
    startingStates.set(line.employeePartyId, state);
  }
  if (missingPrevious.length > 0) throw new MissingPreviousEmployerError(missingPrevious.length);

  let variances = 0;
  let totalVariance = toScaled("0");
  let totalComputed = toScaled("0");
  let totalReported = toScaled("0");
  let anyReported = false;
  let contributionVariances = 0;
  let contributionChecksSkipped = 0;
  const annualizationEntries: AnnualizationEntry[] = [];

  // ── Pass 2: compute and persist the lines. ──
  for (const line of lines) {
    const state = startingStates.get(line.employeePartyId)!;
    const ytdBenefitsBefore =
      ytdBenefitsByEmployee.get(line.employeePartyId) ?? (0n as ScaledMoney);
    const result = runWithholding({
      compensation: toCompensationInput(line, ytdBenefitsBefore),
      period: run.payrollPeriod,
      periodEnd: run.periodEnd,
      brackets,
      state,
      annualize: run.isAnnualizationRun ? { trigger: "year_end", annualBrackets } : undefined,
    });

    if (run.isAnnualizationRun && result.annualization) {
      const a = result.annualization;
      annualizationEntries.push({
        employeePartyId: line.employeePartyId,
        refundOrDeficiency:
          a.excess > 0n
            ? fromScaled(a.excess)
            : a.deficiency > 0n
              ? `-${fromScaled(a.deficiency)}`
              : "0",
        uncollectibleDeficiency: a.uncollectibleDeficiency > 0n,
      });
    }

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
    // it was computed on right? Monthly checks directly; semi-monthly on the
    // month-completing run over both halves (checkpoint C4).
    const contribution = checkContributions(
      line,
      run.payrollPeriod,
      run.payrollPeriod === "semi_monthly"
        ? isMonthCompleting
          ? (siblingLines.get(line.employeePartyId) ?? null)
          : null
        : null,
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
  }

  await db
    .update(payrollRuns)
    .set({ status: "computed", computedAt: new Date(), updatedAt: new Date() })
    .where(eq(payrollRuns.id, runId));

  // ── Pass 3: persist year state as "through the latest computed period". ──
  // Replayed over EVERY computed run including this one (this run's lines now
  // carry their fresh figures), so a recompute of June with December already
  // computed leaves the row describing the whole computed year, not June.
  priorRuns.push({ ...run, computedAt: new Date() });
  priorRuns.sort((a, b) => a.periodIndex - b.periodIndex);
  priorLinesByRun.set(run.id, lines);
  for (const line of lines) {
    const previousEmployer = await loadPreviousEmployer(
      db,
      organizationId,
      line.employeePartyId,
      run.taxableYear,
    );
    const finalState = await replayState(
      line.employeePartyId,
      previousEmployer,
      Number.MAX_SAFE_INTEGER,
    );
    await persistYearState(
      db,
      organizationId,
      line.employeePartyId,
      run.taxableYear,
      finalState,
      ytdBenefitsByEmployee.get(line.employeePartyId) ?? (0n as ScaledMoney),
    );
  }

  return {
    runId,
    linesComputed: lines.length,
    variances,
    totalVariancePesos: toPesoString(totalVariance),
    totalComputedPesos: toPesoString(totalComputed),
    totalReportedPesos: anyReported ? toPesoString(totalReported) : null,
    contributionVariances,
    contributionChecksSkipped,
    ...(run.isAnnualizationRun ? { annualizationEntries } : {}),
  };
}

async function loadPreviousEmployer(
  db: Db,
  organizationId: string,
  employeePartyId: string,
  taxableYear: number,
): Promise<EmployeeYearState["previousEmployer"]> {
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
  if (!prior) return null;
  return {
    taxableCompensation: prior.taxableCompensation,
    taxWithheld: prior.taxWithheld,
    // The Step 2 divisor contribution, read from the 2316 rather than the
    // calendar — an employment gap makes the calendar reading wrong.
    periodsCovered: prior.periodsCovered,
    employmentFrom: prior.employmentFrom,
    employmentTo: prior.employmentTo,
  };
}

async function persistYearState(
  db: Db,
  organizationId: string,
  employeePartyId: string,
  taxableYear: number,
  next: EmployeeYearState,
  ytdThirteenthMonthAndOtherBenefits: ScaledMoney,
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
      ytdThirteenthMonthAndOtherBenefits: fromScaled(ytdThirteenthMonthAndOtherBenefits),
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
        ytdThirteenthMonthAndOtherBenefits: fromScaled(ytdThirteenthMonthAndOtherBenefits),
        periodsElapsed: next.periodsElapsed,
        updatedAt: new Date(),
      },
    });
}
