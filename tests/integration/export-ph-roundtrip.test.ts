import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import postgres from "postgres";
import { createTestDb } from "../utils/db-utils";
import { organization } from "../../src/db/schema/auth";
import { parties } from "../../src/db/schema/parties";
import { orgTaxProfiles } from "../../src/db/schema/tax-reference";
import { partyTaxProfiles } from "../../src/db/schema/party-tax";
import { payrollLines, payrollRuns } from "../../src/db/schema/payroll";
import { taxWithholdingPayments } from "../../src/db/schema/tax-stage-remainder";
import { exportPhEntity, importPhEntity, phSpecFor } from "../../src/lib/export-ph";

const describeDb = process.env.TEST_DATABASE_URL ? describe : describe.skip;

/**
 * Program 2 P5 — PH backup/restore round-trip. Source org's compliance data
 * exports (uuids replaced by resolvable references), then restores into a
 * FRESH org whose parties were re-created with new ids — the exact scenario
 * raw-uuid exports can never survive.
 */
describeDb("PH export round-trip", () => {
  let db: any;
  let sql: postgres.Sql;
  const SRC = `ph-exp-src-${randomUUID()}`;
  const DST = `ph-exp-dst-${randomUUID()}`;
  const EMPLOYEE = "Roundtrip Employee";

  beforeAll(async () => {
    ({ db, sql } = await createTestDb());
    for (const [id, name] of [
      [SRC, "PH Export Source"],
      [DST, "PH Export Target"],
    ] as const) {
      await db.insert(organization).values({ id, name, slug: `px-${randomUUID().slice(0, 10)}` });
    }
    // Source: employee + tax profile + one payroll run with a line + a
    // withholding payment + the org tax profile.
    const [srcEmployee] = await db
      .insert(parties)
      .values({ organizationId: SRC, name: EMPLOYEE, partyType: "employee" })
      .returning({ id: parties.id });
    await db.insert(orgTaxProfiles).values({
      organizationId: SRC,
      tin: "123456789",
      registeredName: "ROUNDTRIP CORP",
    });
    await db.insert(partyTaxProfiles).values({
      organizationId: SRC,
      partyId: srcEmployee.id,
      tin: "987654321",
      lastName: "EMPLOYEE",
      firstName: "ROUNDTRIP",
    });
    const [run] = await db
      .insert(payrollRuns)
      .values({
        organizationId: SRC,
        taxableYear: 2026,
        payrollPeriod: "monthly",
        periodStart: "2026-01-01",
        periodEnd: "2026-01-31",
        periodIndex: 1,
        status: "computed",
        computedAt: new Date(),
      })
      .returning({ id: payrollRuns.id });
    await db.insert(payrollLines).values({
      organizationId: SRC,
      payrollRunId: run.id,
      employeePartyId: srcEmployee.id,
      basicSalary: "50000.00",
      computedTaxWithheld: "2500.00",
    });
    await db.insert(taxWithholdingPayments).values({
      organizationId: SRC,
      payeeTin: "111222333",
      payeeRegisteredName: "SUPPLIER CORP",
      periodStart: "2026-01-01",
      periodEnd: "2026-01-31",
      atc: "WC160",
      incomePayment: "200000.00",
      taxWithheld: "10000.00",
    });
    // Target org: SAME employee name, DIFFERENT uuid — the import must
    // resolve by name.
    await db.insert(parties).values({ organizationId: DST, name: EMPLOYEE, partyType: "employee" });
  });

  afterAll(async () => {
    await sql.end();
  });

  it("exports without uuids and restores into a fresh org by reference", async () => {
    // Export the slice from the source org.
    const profileRows = await exportPhEntity(db, SRC, phSpecFor("phOrgTaxProfile")!);
    const partyProfileRows = await exportPhEntity(db, SRC, phSpecFor("phPartyTaxProfiles")!);
    const runRows = await exportPhEntity(db, SRC, phSpecFor("phPayrollRuns")!);
    const lineRows = await exportPhEntity(db, SRC, phSpecFor("phPayrollLines")!);
    const paymentRows = await exportPhEntity(db, SRC, phSpecFor("phWithholdingPayments")!);

    expect(profileRows).toHaveLength(1);
    expect(lineRows).toHaveLength(1);
    // No uuid identifiers on the wire.
    expect(Object.keys(lineRows[0])).not.toContain("payrollRunId");
    expect(Object.keys(lineRows[0])).not.toContain("employeePartyId");
    expect(lineRows[0]).toMatchObject({
      employeeName: EMPLOYEE,
      runTaxableYear: 2026,
      runPayrollPeriod: "monthly",
      runPeriodIndex: 1,
    });

    // Restore, dependency order.
    for (const [key, rows] of [
      ["phOrgTaxProfile", profileRows],
      ["phPartyTaxProfiles", partyProfileRows],
      ["phPayrollRuns", runRows],
      ["phPayrollLines", lineRows],
      ["phWithholdingPayments", paymentRows],
    ] as const) {
      const results = await importPhEntity(db, DST, phSpecFor(key)!, rows as never);
      for (const result of results) {
        expect(result.success, `${key}: ${result.error ?? ""}`).toBe(true);
      }
    }

    // The restored line points at the TARGET org's run and employee.
    const [dstEmployee] = await db
      .select({ id: parties.id })
      .from(parties)
      .where(and(eq(parties.organizationId, DST), eq(parties.name, EMPLOYEE)));
    const [dstRun] = await db
      .select({ id: payrollRuns.id })
      .from(payrollRuns)
      .where(and(eq(payrollRuns.organizationId, DST), eq(payrollRuns.periodIndex, 1)));
    const [dstLine] = await db
      .select()
      .from(payrollLines)
      .where(eq(payrollLines.organizationId, DST));
    expect(dstLine.payrollRunId).toBe(dstRun.id);
    expect(dstLine.employeePartyId).toBe(dstEmployee.id);
    // decimal(20,8) storage scale
    expect(Number(dstLine.basicSalary)).toBe(50000);
  });

  it("record entities refuse to merge into an org that already has rows", async () => {
    const spec = phSpecFor("phWithholdingPayments")!;
    const rows = await exportPhEntity(db, SRC, spec);
    // DST already restored payments above — a second restore must refuse.
    const results = await importPhEntity(db, DST, spec, rows as never);
    expect(results.length).toBeGreaterThan(0);
    for (const result of results) {
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/already has rows/i);
    }
  });

  it("config entities upsert idempotently instead", async () => {
    const spec = phSpecFor("phOrgTaxProfile")!;
    const rows = await exportPhEntity(db, SRC, spec);
    const results = await importPhEntity(db, DST, spec, rows as never);
    expect(results[0].success).toBe(true);
    expect(results[0].error).toBe("Updated existing");
    const profiles = await db
      .select()
      .from(orgTaxProfiles)
      .where(eq(orgTaxProfiles.organizationId, DST));
    expect(profiles).toHaveLength(1);
    expect(profiles[0].registeredName).toBe("ROUNDTRIP CORP");
  });
});
