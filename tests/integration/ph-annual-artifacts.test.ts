import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { createTestDb } from "../utils/db-utils";
import { organization } from "../../src/db/schema/auth";
import { parties } from "../../src/db/schema/parties";
import { partyTaxProfiles } from "../../src/db/schema/party-tax";
import { payrollLines, payrollRuns } from "../../src/db/schema/payroll";
import { orgTaxProfiles } from "../../src/db/schema/tax-reference";
import { issuePayrollArtifacts } from "../../src/lib/tax/issue-payroll-artifacts";

const describeDb = process.env.TEST_DATABASE_URL ? describe : describe.skip;

/**
 * The audit's second and third criticals, pinned end to end.
 *
 * #2: the 2316 and 1604-C were built from ONE payroll run's lines while
 * documenting themselves as year-to-date — every employee under-reported by a
 * factor equal to the number of periods, on a filed information return, under
 * substituted filing where the employee cannot detect it.
 *
 * #3: taxDue was set to ytdTaxWithheld, making refundOrDeficiency
 * structurally zero — an over-withheld employee showed a 0.00 refund.
 *
 * The seeded RR 11-2018 annual table makes the expectations exact: annual
 * taxable ₱100,000 sits in the zero bracket (floor 0, tax 0, 0%), so tax due
 * is 0 and everything withheld is refundable.
 */
describeDb("PH annual artifacts (2316 / 1604-C)", () => {
  let db: any;
  let sql: postgres.Sql;

  const ORG = `ph-annual-${randomUUID()}`;
  const YEAR = 2026;
  let fullYearEmployee: string;
  let midYearLeaver: string;
  let decemberRunId: string;

  async function insertRun(index: number, start: string, end: string): Promise<string> {
    const [run] = await db
      .insert(payrollRuns)
      .values({
        organizationId: ORG,
        taxableYear: YEAR,
        payrollPeriod: "monthly",
        periodStart: start,
        periodEnd: end,
        periodIndex: index,
        status: "computed",
        computedAt: new Date(),
      })
      .returning();
    return run.id as string;
  }

  async function insertLine(runId: string, employeePartyId: string, withheld: string) {
    await db.insert(payrollLines).values({
      organizationId: ORG,
      payrollRunId: runId,
      employeePartyId,
      basicSalary: "50000.00",
      computedTaxWithheld: withheld,
    });
  }

  beforeAll(async () => {
    ({ db, sql } = await createTestDb());

    await db.insert(organization).values({
      id: ORG,
      name: "PH Annual Test Org",
      slug: `ph-annual-${randomUUID().slice(0, 8)}`,
    });
    await db.insert(orgTaxProfiles).values({
      organizationId: ORG,
      tin: "123456780",
      registeredName: "PH ANNUAL TEST CORP",
    });

    const employees: string[] = [];
    for (const name of ["Full Year", "Mid Leaver"]) {
      const [party] = await db
        .insert(parties)
        .values({ organizationId: ORG, name, partyType: "employee" })
        .returning();
      await db.insert(partyTaxProfiles).values({
        organizationId: ORG,
        partyId: party.id,
        tin: `98765432${employees.length}`,
        lastName: name.toUpperCase(),
        firstName: "TEST",
      });
      employees.push(party.id);
    }
    [fullYearEmployee, midYearLeaver] = employees;

    // Two computed runs. The full-year employee is on both; the mid-year
    // leaver ONLY on the first — issuing from the December run must still
    // report them (the employee set is the YEAR's, not the issuing run's).
    const juneRun = await insertRun(6, "2026-06-01", "2026-06-30");
    decemberRunId = await insertRun(12, "2026-12-01", "2026-12-31");
    await insertLine(juneRun, fullYearEmployee, "2500.00");
    await insertLine(decemberRunId, fullYearEmployee, "2500.00");
    await insertLine(juneRun, midYearLeaver, "1000.00");
  });

  afterAll(async () => {
    await sql.end();
  });

  it("reports the YEAR, shows the annualized refund, and stamps 12/31", async () => {
    const issued = await issuePayrollArtifacts(db, ORG, decemberRunId);

    const fullYear = issued.certificates.find((c) => c.employeePartyId === fullYearEmployee);
    expect(fullYear).toBeDefined();
    // Year totals, not December's: two runs of ₱50,000.
    expect(fullYear!.form.totalTaxableFromPresentEmployer).toBe("100000.00");
    expect(fullYear!.form.totalTaxWithheld).toBe("5000.00");
    // ₱100,000 annual taxable is inside the 0% bracket → tax due 0, and the
    // whole ₱5,000 withheld is a REFUND — the figure the old
    // taxDue=ytdTaxWithheld shortcut forced to zero.
    expect(fullYear!.form.taxDue).toBe("0.00");
    expect(fullYear!.form.refundOrDeficiency).toBe("5000.00");

    // The mid-year leaver appears even though the issuing run has no line
    // for them.
    const leaver = issued.certificates.find((c) => c.employeePartyId === midYearLeaver);
    expect(leaver).toBeDefined();
    expect(leaver!.form.totalTaxableFromPresentEmployer).toBe("50000.00");

    // The 1604-C is an annual return: period is 12/31 of the taxable year,
    // never the issuing run's period end.
    expect(issued.alphalist.content).toContain("12/31/2026");
    expect(issued.alphalist.content).not.toContain("12/01/2026");
    // The C1 control record layout is untranscribed, so the file is a
    // marked preview, never a submittable .dat, and the gap is named.
    expect(issued.alphalist.fileName).toBe(`1604C-123456780-${YEAR}.dat.incomplete`);
    expect(issued.alphalist.blockingIssues.join(" ")).toContain("1604C_C1_CONTROL_UNTRANSCRIBED");
  });
});
