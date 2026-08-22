import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import type postgres from "postgres";
import { createTestDb } from "../utils/db-utils";
import { parties } from "../../src/db/schema/parties";
import {
  payrollEmployeeYearState,
  payrollLines,
  payrollRuns,
  previousEmployer2316,
} from "../../src/db/schema/payroll";
import {
  computePayrollRun,
  MissingPreviousEmployerError,
  PayrollRunLockedError,
  PayrollRunNotFoundError,
} from "../../src/lib/tax/payroll-run-service";

const describeDb =
  process.env.TEST_DATABASE_URL || process.env.DATABASE_URL ? describe : describe.skip;

/**
 * Exercises the wiring between the engine and the tables against a real
 * database. The engine's own correctness is already pinned by the RR
 * illustration vectors in tests/unit/lib/tax — what is under test here is that
 * the right columns reach it, the year-state advances, and the variance is
 * recorded rather than swallowed.
 *
 * There is no fixture/factory library in this repo and no transaction-rollback
 * isolation, so each test builds its own org with a random id and cleans up
 * after itself (TESTING.md).
 */
describeDb("payroll run service", () => {
  let db: any;
  let sql: postgres.Sql;
  let ORG: string;

  beforeAll(async () => {
    const conn = await createTestDb();
    db = conn.db;
    sql = conn.sql;
  });

  afterAll(async () => {
    await sql.end();
  });

  beforeEach(async () => {
    ORG = `org_payroll_${crypto.randomUUID().slice(0, 8)}`;
  });

  async function makeEmployee(name: string): Promise<string> {
    const [row] = await db
      .insert(parties)
      .values({ organizationId: ORG, name, partyType: "employee" })
      .returning();
    return row.id;
  }

  async function makeRun(overrides: Record<string, unknown> = {}): Promise<string> {
    const [row] = await db
      .insert(payrollRuns)
      .values({
        organizationId: ORG,
        taxableYear: 2026,
        payrollPeriod: "monthly",
        periodStart: "2026-01-01",
        periodEnd: "2026-01-31",
        periodIndex: 1,
        status: "imported",
        ...overrides,
      })
      .returning();
    return row.id;
  }

  async function addLine(
    runId: string,
    employeeId: string,
    values: Record<string, unknown>,
  ): Promise<string> {
    const [row] = await db
      .insert(payrollLines)
      .values({ organizationId: ORG, payrollRunId: runId, employeePartyId: employeeId, ...values })
      .returning();
    return row.id;
  }

  it("computes the engine figure and records no variance when the register agrees", async () => {
    const employee = await makeEmployee("Agrees");
    const run = await makeRun();
    // ₱30,000 taxable regular under Annex E monthly → ₱1,375.05.
    await addLine(run, employee, { basicSalary: "30000", reportedTaxWithheld: "1375.05" });

    const result = await computePayrollRun(db, ORG, run);

    expect(result.linesComputed).toBe(1);
    expect(result.variances).toBe(0);
    expect(result.totalComputedPesos).toBe("1375.05");
    expect(result.totalReportedPesos).toBe("1375.05");

    const [line] = await db.select().from(payrollLines).where(eq(payrollLines.payrollRunId, run));
    expect(Number(line.computedTaxWithheld)).toBeCloseTo(1375.05, 2);
    expect(Number(line.varianceAmount)).toBe(0);
    expect(line.withholdingPath).toBe("regular");
  });

  it("records the delta without overwriting the client's figure", async () => {
    // The register keeps its number — the product is the control, not the
    // computer of record (D-N7). Filing our figure over theirs would invert
    // that, and it is their return.
    const employee = await makeEmployee("Disagrees");
    const run = await makeRun();
    await addLine(run, employee, { basicSalary: "30000", reportedTaxWithheld: "1000.00" });

    const result = await computePayrollRun(db, ORG, run);

    expect(result.variances).toBe(1);
    expect(result.totalVariancePesos).toBe("375.05");

    const [line] = await db.select().from(payrollLines).where(eq(payrollLines.payrollRunId, run));
    expect(line.reportedTaxWithheld).toBe("1000.00000000");
    expect(Number(line.varianceAmount)).toBeCloseTo(375.05, 2);
  });

  it("nets the employee's contributions off gross before bracketing", async () => {
    // Gross ₱30,000 less ₱2,300 of contributions → taxable ₱27,700 →
    // 15% × (27,700 − 20,833) = ₱1,030.05. Feeding gross straight into the
    // bracket would over-withhold, which is the BIR calculator's trap.
    const employee = await makeEmployee("Contributions");
    const run = await makeRun();
    await addLine(run, employee, {
      basicSalary: "30000",
      sssEmployeeShare: "1350",
      philHealthEmployeeShare: "750",
      pagIbigEmployeeShare: "200",
    });

    const result = await computePayrollRun(db, ORG, run);
    expect(result.totalComputedPesos).toBe("1030.05");
  });

  it("distinguishes an absent reported figure from a zero variance", async () => {
    // A register with no withholding column is not a clean run — it is an
    // absent comparison, and conflating the two would report zero variances.
    const employee = await makeEmployee("No report");
    const run = await makeRun();
    await addLine(run, employee, { basicSalary: "30000" });

    const result = await computePayrollRun(db, ORG, run);
    expect(result.variances).toBe(0);
    expect(result.totalReportedPesos).toBeNull();

    const [line] = await db.select().from(payrollLines).where(eq(payrollLines.payrollRunId, run));
    expect(line.varianceAmount).toBeNull();
  });

  it("advances the year state, and latches the cumulative method with its reason", async () => {
    const employee = await makeEmployee("Latches");
    const run = await makeRun();
    // Supplementary ≥ regular fires trigger (ii).
    await addLine(run, employee, { basicSalary: "20000", commission: "25000" });

    await computePayrollRun(db, ORG, run);

    const [state] = await db
      .select()
      .from(payrollEmployeeYearState)
      .where(
        and(
          eq(payrollEmployeeYearState.organizationId, ORG),
          eq(payrollEmployeeYearState.employeePartyId, employee),
        ),
      );

    expect(state.withholdingMethod).toBe("cumulative_average");
    expect(state.latchedReason).toBe("supplementary_at_or_above_regular");
    expect(state.latchedAtPeriodEnd).toBe("2026-01-31");
    expect(state.periodsElapsed).toBe(1);
    expect(Number(state.ytdTaxableRegular)).toBe(20000);
    expect(Number(state.ytdTaxableSupplementary)).toBe(25000);

    const [line] = await db.select().from(payrollLines).where(eq(payrollLines.payrollRunId, run));
    expect(line.withholdingPath).toBe("cumulative_average");
    // The divisor must be recorded — a filed figure that cannot be re-explained
    // is not defensible, and this is the value most likely to be questioned.
    expect(line.cumulativeDivisor).toBe(1);
  });

  it("carries year-to-date figures across consecutive runs", async () => {
    const employee = await makeEmployee("Accumulates");

    for (let month = 1; month <= 3; month++) {
      const run = await makeRun({
        periodIndex: month,
        periodStart: `2026-0${month}-01`,
        periodEnd: `2026-0${month}-28`,
      });
      await addLine(run, employee, { basicSalary: "30000" });
      await computePayrollRun(db, ORG, run);
    }

    const [state] = await db
      .select()
      .from(payrollEmployeeYearState)
      .where(eq(payrollEmployeeYearState.employeePartyId, employee));

    expect(state.periodsElapsed).toBe(3);
    expect(Number(state.ytdTaxableRegular)).toBe(90000);
    expect(Number(state.ytdTaxWithheld)).toBeCloseTo(4125.15, 2); // 1,375.05 × 3
  });

  it("credits the previous employer when a 2316 is on file", async () => {
    const employee = await makeEmployee("Mid-year hire");
    await db.insert(previousEmployer2316).values({
      organizationId: ORG,
      employeePartyId: employee,
      taxableYear: 2026,
      previousEmployerName: "ENA Company",
      taxableCompensation: "180000",
      taxWithheld: "11000.40",
      periodsCovered: 6,
      employmentFrom: "2026-01-01",
      employmentTo: "2026-06-30",
    });

    const run = await makeRun({
      periodIndex: 7,
      periodStart: "2026-07-01",
      periodEnd: "2026-07-31",
    });
    await addLine(run, employee, { basicSalary: "35000" });

    await computePayrollRun(db, ORG, run);

    const [line] = await db.select().from(payrollLines).where(eq(payrollLines.payrollRunId, run));
    // Trigger (iii) fires on the prior employer alone.
    expect(line.withholdingPath).toBe("cumulative_average");
    // Divisor = 6 prior periods + 1 here. NOT July's calendar index, which only
    // coincides here because the prior employment ran unbroken from January.
    expect(line.cumulativeDivisor).toBe(7);
  });

  it("stops rather than computing a mid-year hire with no 2316 on file", async () => {
    // The cumulative method's numerator and divisor are both short without it,
    // and the year-end annualization would credit too little tax. Blocking is
    // the point (D7 Tier 1) — a silently wrong figure is worse than a stop.
    const employee = await makeEmployee("Missing 2316");
    await db.insert(payrollEmployeeYearState).values({
      organizationId: ORG,
      employeePartyId: employee,
      taxableYear: 2026,
      periodsElapsed: 0,
      ytdTaxableRegular: "0",
    });

    const run = await makeRun({
      periodIndex: 7,
      periodStart: "2026-07-01",
      periodEnd: "2026-07-31",
    });
    await addLine(run, employee, { basicSalary: "35000" });

    await expect(computePayrollRun(db, ORG, run)).rejects.toThrow(MissingPreviousEmployerError);
  });

  it("refuses to recompute a locked run", async () => {
    // A locked run backs a filed return; changing it would change a figure
    // already reported. An amendment is a separate, deliberate act.
    const employee = await makeEmployee("Locked");
    const run = await makeRun({ status: "locked" });
    await addLine(run, employee, { basicSalary: "30000" });

    await expect(computePayrollRun(db, ORG, run)).rejects.toThrow(PayrollRunLockedError);
  });

  it("does not reach across organizations", async () => {
    // RLS is not actually enforced today, so the explicit org predicate IS the
    // tenant boundary here (blocker B5).
    const employee = await makeEmployee("Other org");
    const run = await makeRun();
    await addLine(run, employee, { basicSalary: "30000" });

    await expect(computePayrollRun(db, "org_someone_else", run)).rejects.toThrow(
      PayrollRunNotFoundError,
    );
  });

  it("is idempotent — recomputing yields the same figures", async () => {
    const employee = await makeEmployee("Idempotent");
    const run = await makeRun();
    await addLine(run, employee, { basicSalary: "30000", reportedTaxWithheld: "1375.05" });

    const first = await computePayrollRun(db, ORG, run);
    const second = await computePayrollRun(db, ORG, run);
    expect(second.totalComputedPesos).toBe(first.totalComputedPesos);
    expect(second.variances).toBe(first.variances);
  });

  it("uses the annual schedule on the annualization run", async () => {
    // Illustration 15 case 1 (Ms. Grace): ₱600,000 basic plus ₱10,000 November
    // overtime, ₱73,334.25 withheld to November → ₱9,165.75 due in December.
    const employee = await makeEmployee("Year end");
    await db.insert(payrollEmployeeYearState).values({
      organizationId: ORG,
      employeePartyId: employee,
      taxableYear: 2018,
      periodsElapsed: 11,
      ytdTaxableRegular: "550000",
      ytdTaxWithheld: "73334.25",
    });

    const run = await makeRun({
      taxableYear: 2018,
      periodIndex: 12,
      periodStart: "2018-12-01",
      periodEnd: "2018-12-31",
      isAnnualizationRun: true,
    });
    await addLine(run, employee, { basicSalary: "50000", overtimePay: "10000" });

    const result = await computePayrollRun(db, ORG, run);

    const [line] = await db.select().from(payrollLines).where(eq(payrollLines.payrollRunId, run));
    expect(line.withholdingPath).toBe("annualized");
    expect(result.totalComputedPesos).toBe("9165.75");
  });

  describe("statutory contribution check", () => {
    it("flags a register whose deductions disagree with the schedule", async () => {
      // THE HOLE THIS CLOSES. The engine nets the REPORTED contributions before
      // bracketing, so a register with a wrong SSS figure produces a wrong
      // taxable base, a wrong tax — and a tax variance of ZERO, because our
      // computation used the same wrong input. Both errors cancel.
      //
      // ₱30,000 compensation maps to MSC 30,000 → employee SSS ₱1,500. This
      // register deducted ₱1,350, understating by ₱150 and overstating the
      // taxable base by the same.
      const employee = await makeEmployee("Wrong SSS");
      const run = await makeRun();
      await addLine(run, employee, {
        basicSalary: "30000",
        sssEmployeeShare: "1350",
        philHealthEmployeeShare: "750",
        pagIbigEmployeeShare: "200",
        // What the register's own (wrong) base would produce, so the TAX
        // arithmetic is internally consistent and its variance is zero.
        reportedTaxWithheld: "1030.05",
      });

      const result = await computePayrollRun(db, ORG, run);

      // The tax check alone sees nothing wrong.
      expect(result.variances).toBe(0);
      // The contribution check does.
      expect(result.contributionVariances).toBe(1);

      const [line] = await db.select().from(payrollLines).where(eq(payrollLines.payrollRunId, run));
      expect(line.contributionCheckStatus).toBe("checked");
      expect(Number(line.expectedSssEmployeeShare)).toBeCloseTo(1500, 2);
      expect(Number(line.contributionVarianceAmount)).toBeCloseTo(150, 2);
    });

    it("records no contribution variance when the register matches the schedule", async () => {
      const employee = await makeEmployee("Correct");
      const run = await makeRun();
      await addLine(run, employee, {
        basicSalary: "30000",
        sssEmployeeShare: "1500",
        philHealthEmployeeShare: "750",
        pagIbigEmployeeShare: "200",
      });

      const result = await computePayrollRun(db, ORG, run);
      expect(result.contributionVariances).toBe(0);

      const [line] = await db.select().from(payrollLines).where(eq(payrollLines.payrollRunId, run));
      expect(Number(line.contributionVarianceAmount)).toBe(0);
      expect(Number(line.expectedPhilHealthEmployeeShare)).toBeCloseTo(750, 2);
      expect(Number(line.expectedPagIbigEmployeeShare)).toBeCloseTo(200, 2);
    });

    it("uses the basic salary for PhilHealth, not gross compensation", async () => {
      // PhilHealth's base excludes commission, overtime, allowances, 13th month
      // and bonuses. Passing gross would overstate the premium — here by 2.5%
      // of the ₱10,000 commission.
      const employee = await makeEmployee("Narrow base");
      const run = await makeRun();
      await addLine(run, employee, {
        basicSalary: "25000",
        commission: "10000",
        sssEmployeeShare: "1750",
        philHealthEmployeeShare: "625",
        pagIbigEmployeeShare: "200",
      });

      await computePayrollRun(db, ORG, run);

      const [line] = await db.select().from(payrollLines).where(eq(payrollLines.payrollRunId, run));
      expect(Number(line.philHealthBaseUsed)).toBe(25000);
      expect(Number(line.expectedPhilHealthEmployeeShare)).toBeCloseTo(625, 2); // 2.5% of 25,000
      // SSS still brackets on the higher total compensation.
      expect(Number(line.expectedSssEmployeeShare)).toBeCloseTo(1750, 2);
    });

    it("skips the check on a non-monthly period rather than inventing a variance", async () => {
      // The contributions are MONTHLY obligations. A semi-monthly period holds
      // a fraction of the monthly amount and employers split it by differing
      // conventions, so comparing per-period would manufacture variances that
      // are not errors.
      const employee = await makeEmployee("Semi-monthly");
      const run = await makeRun({ payrollPeriod: "semi_monthly", periodEnd: "2026-01-15" });
      await addLine(run, employee, { basicSalary: "15000", sssEmployeeShare: "750" });

      const result = await computePayrollRun(db, ORG, run);
      expect(result.contributionVariances).toBe(0);
      expect(result.contributionChecksSkipped).toBe(1);

      const [line] = await db.select().from(payrollLines).where(eq(payrollLines.payrollRunId, run));
      expect(line.contributionCheckStatus).toBe("skipped_non_monthly");
      expect(line.contributionVarianceAmount).toBeNull();
    });

    it("distinguishes an unreported contribution from an agreeing one", async () => {
      // A register with no contribution columns is not a clean check.
      const employee = await makeEmployee("No contributions");
      const run = await makeRun();
      await addLine(run, employee, { basicSalary: "30000" });

      const result = await computePayrollRun(db, ORG, run);
      expect(result.contributionChecksSkipped).toBe(1);

      const [line] = await db.select().from(payrollLines).where(eq(payrollLines.payrollRunId, run));
      expect(line.contributionCheckStatus).toBe("skipped_not_reported");
    });
  });
});
