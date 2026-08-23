import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import postgres from "postgres";
import { createTestDb } from "../utils/db-utils";
import { organization } from "../../src/db/schema/auth";
import { parties } from "../../src/db/schema/parties";
import { payrollEmployeeYearState, payrollLines, payrollRuns } from "../../src/db/schema/payroll";
import { computePayrollRun } from "../../src/lib/tax/payroll-run-service";
import { summarizePayrollPosting } from "../../src/lib/tax/payroll-posting-summary";

const describeDb = process.env.TEST_DATABASE_URL ? describe : describe.skip;

/**
 * Two audit highs on the payroll engine, pinned end to end.
 *
 * IDEMPOTENCY: computePayrollRun documented itself as idempotent but advanced
 * the PERSISTED year-state, so recomputing a run (the normal fix for a
 * corrected register import) doubled YTD figures and periodsElapsed — and,
 * for cumulative-average employees, corrupted the divisor for the rest of
 * the year. The state is now rebuilt by replaying prior computed periods.
 *
 * SEMI-MONTHLY CONTRIBUTIONS (checkpoint C4): SSS/PhilHealth/Pag-IBIG are
 * monthly obligations; the check used to return skipped_non_monthly for the
 * most common PH cadence, writing NULL employer shares — the employer's
 * entire statutory cost was absent from the P&L. The expected figures are
 * now computed over the month's two halves and recognized on the completing
 * run.
 */
describeDb("payroll compute integrity", () => {
  let db: any;
  let sql: postgres.Sql;

  beforeAll(async () => {
    ({ db, sql } = await createTestDb());
  });
  afterAll(async () => {
    await sql.end();
  });

  async function setupOrg(label: string) {
    const orgId = `${label}-${randomUUID()}`;
    await db.insert(organization).values({
      id: orgId,
      name: "Payroll Compute Org",
      slug: `${label}-${randomUUID().slice(0, 8)}`,
    });
    const [employee] = await db
      .insert(parties)
      .values({ organizationId: orgId, name: "Compute Employee", partyType: "employee" })
      .returning();
    return { orgId, employeeId: employee.id as string };
  }

  async function addRun(
    orgId: string,
    period: "monthly" | "semi_monthly",
    index: number,
    start: string,
    end: string,
  ): Promise<string> {
    const [run] = await db
      .insert(payrollRuns)
      .values({
        organizationId: orgId,
        taxableYear: 2026,
        payrollPeriod: period,
        periodStart: start,
        periodEnd: end,
        periodIndex: index,
        status: "draft",
      })
      .returning();
    return run.id as string;
  }

  async function addLine(orgId: string, runId: string, employeeId: string, extra: object = {}) {
    await db.insert(payrollLines).values({
      organizationId: orgId,
      payrollRunId: runId,
      employeePartyId: employeeId,
      basicSalary: "50000.00",
      ...extra,
    });
  }

  async function yearState(orgId: string, employeeId: string) {
    const [row] = await db
      .select()
      .from(payrollEmployeeYearState)
      .where(
        and(
          eq(payrollEmployeeYearState.organizationId, orgId),
          eq(payrollEmployeeYearState.employeePartyId, employeeId),
          eq(payrollEmployeeYearState.taxableYear, 2026),
        ),
      );
    return row;
  }

  it("recomputing a run changes nothing: same tax, same YTD, same divisor", async () => {
    const { orgId, employeeId } = await setupOrg("recompute");
    const jan = await addRun(orgId, "monthly", 1, "2026-01-01", "2026-01-31");
    const feb = await addRun(orgId, "monthly", 2, "2026-02-01", "2026-02-28");
    await addLine(orgId, jan, employeeId);
    await addLine(orgId, feb, employeeId);

    await computePayrollRun(db, orgId, jan);
    await computePayrollRun(db, orgId, feb);

    const stateAfterFirst = await yearState(orgId, employeeId);
    expect(stateAfterFirst.periodsElapsed).toBe(2);
    const [lineAfterFirst] = await db
      .select()
      .from(payrollLines)
      .where(eq(payrollLines.payrollRunId, feb));

    // The corrected-import flow: recompute BOTH runs again, February twice.
    await computePayrollRun(db, orgId, jan);
    await computePayrollRun(db, orgId, feb);
    await computePayrollRun(db, orgId, feb);

    const stateAfterRecompute = await yearState(orgId, employeeId);
    // The old advance-what-is-persisted design would read 5 here.
    expect(stateAfterRecompute.periodsElapsed).toBe(2);
    expect(stateAfterRecompute.ytdTaxableRegular).toBe(stateAfterFirst.ytdTaxableRegular);
    expect(stateAfterRecompute.ytdTaxWithheld).toBe(stateAfterFirst.ytdTaxWithheld);

    const [lineAfterRecompute] = await db
      .select()
      .from(payrollLines)
      .where(eq(payrollLines.payrollRunId, feb));
    expect(lineAfterRecompute.computedTaxWithheld).toBe(lineAfterFirst.computedTaxWithheld);
  });

  it("a mid-year first appearance with no prior 2316 blocks — even with no year-state row", async () => {
    const { orgId, employeeId } = await setupOrg("gap");
    const jul = await addRun(orgId, "monthly", 7, "2026-07-01", "2026-07-31");
    await addLine(orgId, jul, employeeId);

    // The old precondition required an EXISTING year-state row with zero
    // periods, which a first-time employee never has — so the one case
    // DECISIONS D7 exists for could never fire.
    await expect(computePayrollRun(db, orgId, jul)).rejects.toThrow(/previous employer|2316/i);
  });

  it("semi-monthly contributions are recognized on the month-completing run", async () => {
    const { orgId, employeeId } = await setupOrg("semi");
    const firstHalf = await addRun(orgId, "semi_monthly", 1, "2026-01-01", "2026-01-15");
    const secondHalf = await addRun(orgId, "semi_monthly", 2, "2026-01-16", "2026-01-31");
    // ₱25,000 per half with reported employee shares, so the check has
    // something to compare and the month totals ₱50,000.
    await addLine(orgId, firstHalf, employeeId, {
      basicSalary: "25000.00",
      sssEmployeeShare: "562.50",
      philHealthEmployeeShare: "625.00",
      pagIbigEmployeeShare: "100.00",
    });
    await addLine(orgId, secondHalf, employeeId, {
      basicSalary: "25000.00",
      sssEmployeeShare: "562.50",
      philHealthEmployeeShare: "625.00",
      pagIbigEmployeeShare: "100.00",
    });

    await computePayrollRun(db, orgId, firstHalf);
    await computePayrollRun(db, orgId, secondHalf);

    const [first] = await db
      .select()
      .from(payrollLines)
      .where(eq(payrollLines.payrollRunId, firstHalf));
    const [second] = await db
      .select()
      .from(payrollLines)
      .where(eq(payrollLines.payrollRunId, secondHalf));

    // First half: deferred, no employer figures yet.
    expect(first.contributionCheckStatus).toBe("deferred_month_end");
    expect(first.expectedSssEmployerShare).toBeNull();

    // Completing half: checked over the MONTH, employer shares present.
    expect(second.contributionCheckStatus).toBe("checked");
    expect(Number(second.expectedSssEmployerShare)).toBeGreaterThan(0);
    expect(Number(second.expectedPhilHealthEmployerShare)).toBeGreaterThan(0);
    expect(Number(second.expectedPagIbigEmployerShare)).toBeGreaterThan(0);

    // And the posting summary now carries a non-zero employer contribution
    // expense for the cadence that used to post zero.
    const { totals } = summarizePayrollPosting([first, second]);
    expect(Number(totals.employerContributionExpense)).toBeGreaterThan(0);
  });
});
