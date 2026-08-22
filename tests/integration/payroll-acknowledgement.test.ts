/**
 * The D-N7 acknowledgement record.
 *
 * `payroll_runs` recorded WHO acknowledged and WHEN, but not WHY. The why is
 * the part that answers an assessment: "the engine said 1,500 and we withheld
 * 1,200" is a finding; "the employee started mid-month and the register
 * prorated" is the answer to it.
 *
 * The constraint exists so an acknowledgement cannot be a click with no
 * content — all three fields together, or none.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type postgres from "postgres";
import { createTestDb } from "../utils/db-utils";

const describeDb =
  process.env.TEST_DATABASE_URL || process.env.DATABASE_URL ? describe : describe.skip;

describeDb("payroll acknowledgement", () => {
  let sql: postgres.Sql;
  let ORG: string;

  beforeAll(async () => {
    const conn = await createTestDb();
    sql = conn.sql;
    ORG = crypto.randomUUID();
    await sql`INSERT INTO auth_organizations (id, name, slug)
              VALUES (${ORG}, 'Ack Org', ${`ack-${ORG.slice(0, 8)}`})`;
  });

  afterAll(async () => {
    await sql`DELETE FROM payroll_runs WHERE organization_id = ${ORG}`;
    await sql`DELETE FROM auth_organizations WHERE id = ${ORG}`;
    await sql.end();
  });

  // A unique index enforces one run per organization per period — correct, and
  // the reason each test needs its own month rather than reusing one.
  let nextMonth = 1;
  async function makeRun(): Promise<string> {
    const month = nextMonth++;
    const mm = String(month).padStart(2, "0");
    const [run] = await sql`
      INSERT INTO payroll_runs
        (organization_id, taxable_year, payroll_period, period_index, period_start, period_end, status)
      VALUES (${ORG}, 2026, 'monthly', ${month}, ${`2026-${mm}-01`}, ${`2026-${mm}-28`}, 'computed')
      RETURNING id`;
    return run.id as string;
  }

  it("accepts an unacknowledged run with all three fields null", async () => {
    const id = await makeRun();
    const [row] =
      await sql`SELECT acknowledged_at, acknowledgement_note FROM payroll_runs WHERE id = ${id}`;
    expect(row.acknowledged_at).toBeNull();
    expect(row.acknowledgement_note).toBeNull();
  });

  it("accepts a complete acknowledgement", async () => {
    const id = await makeRun();
    await expect(
      sql`UPDATE payroll_runs
             SET acknowledged_at = now(), acknowledged_by = 'user-1',
                 acknowledgement_note = 'Employee started mid-month; register prorated.'
           WHERE id = ${id}`,
    ).resolves.toBeDefined();
  });

  it("refuses a timestamp with no reason — the empty click", async () => {
    const id = await makeRun();
    await expect(
      sql`UPDATE payroll_runs
             SET acknowledged_at = now(), acknowledged_by = 'user-1'
           WHERE id = ${id}`,
    ).rejects.toThrow(/acknowledgement_complete/);
  });

  it("refuses a whitespace-only reason", async () => {
    // A space is not an explanation.
    const id = await makeRun();
    await expect(
      sql`UPDATE payroll_runs
             SET acknowledged_at = now(), acknowledged_by = 'user-1', acknowledgement_note = '   '
           WHERE id = ${id}`,
    ).rejects.toThrow(/acknowledgement_complete/);
  });

  it("refuses a reason with no acknowledger — unattributable", async () => {
    const id = await makeRun();
    await expect(
      sql`UPDATE payroll_runs
             SET acknowledged_at = now(), acknowledgement_note = 'because'
           WHERE id = ${id}`,
    ).rejects.toThrow(/acknowledgement_complete/);
  });

  it("refuses a reason with no timestamp", async () => {
    const id = await makeRun();
    await expect(
      sql`UPDATE payroll_runs
             SET acknowledged_by = 'user-1', acknowledgement_note = 'because'
           WHERE id = ${id}`,
    ).rejects.toThrow(/acknowledgement_complete/);
  });
});
