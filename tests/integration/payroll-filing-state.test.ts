/**
 * Filing state on a payroll run.
 *
 * `filing-period.ts` enforces "no filed period without a snapshot" in
 * application code. These constraints put the same rule in the database, so a
 * path that bypasses that module — a script, a future endpoint, a manual fix —
 * still cannot produce a filed period with nothing behind it.
 *
 * A filed period whose snapshot is missing cannot prove what it reported, which
 * is the entire reason the snapshot exists.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type postgres from "postgres";
import { createTestDb } from "../utils/db-utils";

const describeDb =
  process.env.TEST_DATABASE_URL || process.env.DATABASE_URL ? describe : describe.skip;

describeDb("payroll filing state", () => {
  let sql: postgres.Sql;
  let ORG: string;
  let nextMonth = 1;

  beforeAll(async () => {
    const conn = await createTestDb();
    sql = conn.sql;
    ORG = crypto.randomUUID();
    await sql`INSERT INTO auth_organizations (id, name, slug)
              VALUES (${ORG}, 'Filing Org', ${`filing-${ORG.slice(0, 8)}`})`;
  });

  afterAll(async () => {
    await sql`DELETE FROM payroll_runs WHERE organization_id = ${ORG}`;
    await sql`DELETE FROM auth_organizations WHERE id = ${ORG}`;
    await sql.end();
  });

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

  it("refuses a filed period with no snapshot behind it", async () => {
    // The rule that matters. A filed period whose snapshot is missing cannot
    // prove what it reported.
    const id = await makeRun();
    await expect(
      sql`UPDATE payroll_runs SET filing_reference = 'BIR-1', filed_at = now() WHERE id = ${id}`,
    ).rejects.toThrow(/filed_needs_snapshot/);
  });

  it("accepts a filing once a snapshot exists", async () => {
    const id = await makeRun();
    await sql`UPDATE payroll_runs
                 SET snapshot_checksum = 'abc123', snapshot_taken_at = now()
               WHERE id = ${id}`;
    await expect(
      sql`UPDATE payroll_runs SET filing_reference = 'BIR-2', filed_at = now() WHERE id = ${id}`,
    ).resolves.toBeDefined();
  });

  it("refuses half a snapshot record", async () => {
    // The surviving half reads as if it could prove something.
    const id = await makeRun();
    await expect(
      sql`UPDATE payroll_runs SET snapshot_checksum = 'abc' WHERE id = ${id}`,
    ).rejects.toThrow(/snapshot_complete/);
    await expect(
      sql`UPDATE payroll_runs SET snapshot_taken_at = now() WHERE id = ${id}`,
    ).rejects.toThrow(/snapshot_complete/);
  });

  it("refuses half a filing record", async () => {
    const id = await makeRun();
    await sql`UPDATE payroll_runs
                 SET snapshot_checksum = 'x', snapshot_taken_at = now() WHERE id = ${id}`;
    await expect(
      sql`UPDATE payroll_runs SET filing_reference = 'BIR-X' WHERE id = ${id}`,
    ).rejects.toThrow(/filing_complete/);
  });

  it("refuses two runs claiming the same BIR reference", async () => {
    // The BIR issues one reference per submission; two runs claiming it means
    // one of them is not what it says.
    const a = await makeRun();
    const b = await makeRun();
    for (const id of [a, b]) {
      await sql`UPDATE payroll_runs
                   SET snapshot_checksum = ${`cs-${id.slice(0, 6)}`}, snapshot_taken_at = now()
                 WHERE id = ${id}`;
    }
    await sql`UPDATE payroll_runs SET filing_reference = 'BIR-DUP', filed_at = now() WHERE id = ${a}`;
    await expect(
      sql`UPDATE payroll_runs SET filing_reference = 'BIR-DUP', filed_at = now() WHERE id = ${b}`,
    ).rejects.toThrow(/filing_reference_unique/);
  });

  it("leaves an unfiled run with all four fields null", async () => {
    const id = await makeRun();
    const [row] = await sql`
      SELECT snapshot_checksum, snapshot_taken_at, filing_reference, filed_at
        FROM payroll_runs WHERE id = ${id}`;
    expect(row.snapshot_checksum).toBeNull();
    expect(row.filing_reference).toBeNull();
    expect(row.filed_at).toBeNull();
  });
});
