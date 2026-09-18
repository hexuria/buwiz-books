import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import postgres from "postgres";
import { createTestDb } from "../utils/db-utils";
import { organization } from "../../src/db/schema/auth";
import { parties } from "../../src/db/schema/parties";
import { orgTaxBranches, orgTaxProfiles } from "../../src/db/schema/tax-reference";
import { partyTaxProfiles } from "../../src/db/schema/party-tax";
import {
  payrollEmployeeYearState,
  payrollLines,
  payrollRuns,
  previousEmployer2316,
} from "../../src/db/schema/payroll";
import { taxCertificates } from "../../src/db/schema/tax-certificates";
import {
  orgTaxRegistrations,
  orgTaxYearElections,
  taxComputedReturns,
  taxWithholdingPayments,
} from "../../src/db/schema/tax-stage-remainder";
import {
  PH_ALWAYS_STRIP,
  PH_ENTITY_KEYS,
  PH_EXPORT_SPECS,
  exportPhEntity,
  importPhEntity,
  phSpecFor,
} from "../../src/lib/export-ph";

const describeDb = process.env.TEST_DATABASE_URL ? describe : describe.skip;

/**
 * Program 2 P5 / P4a — PH backup/restore round-trip. Source org's compliance
 * data exports (uuids replaced by resolvable references), then restores into a
 * FRESH org whose parties were re-created with new ids — the exact scenario
 * raw-uuid exports can never survive. Every tenant Forms key is covered.
 */
describeDb("PH export round-trip", () => {
  let db: any;
  let sql: postgres.Sql;
  const SRC = `ph-exp-src-${randomUUID()}`;
  const DST = `ph-exp-dst-${randomUUID()}`;
  const EMPLOYEE = "Roundtrip Employee";
  const PAYOR = "Roundtrip Payor";
  const STRIP_MARKER = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

  beforeAll(async () => {
    ({ db, sql } = await createTestDb());
    for (const [id, name] of [
      [SRC, "PH Export Source"],
      [DST, "PH Export Target"],
    ] as const) {
      await db.insert(organization).values({ id, name, slug: `px-${randomUUID().slice(0, 10)}` });
    }
    const [srcEmployee] = await db
      .insert(parties)
      .values({ organizationId: SRC, name: EMPLOYEE, partyType: "employee" })
      .returning({ id: parties.id });
    const [srcPayor] = await db
      .insert(parties)
      .values({ organizationId: SRC, name: PAYOR, partyType: "vendor" })
      .returning({ id: parties.id });
    await db.insert(orgTaxProfiles).values({
      organizationId: SRC,
      tin: "123456789",
      registeredName: "ROUNDTRIP CORP",
    });
    await db.insert(orgTaxBranches).values({
      organizationId: SRC,
      branchCode: "00001",
      name: "Cebu",
    });
    await db.insert(orgTaxYearElections).values({
      organizationId: SRC,
      taxableYear: 2026,
      regime: "vat",
    });
    await db.insert(orgTaxRegistrations).values({
      organizationId: SRC,
      regimeKind: "vat",
      value: "registered",
      effectiveFrom: "2026-01-01",
    });
    await db.insert(partyTaxProfiles).values({
      organizationId: SRC,
      partyId: srcEmployee.id,
      tin: "987654321",
      lastName: "EMPLOYEE",
      firstName: "ROUNDTRIP",
    });
    await db.insert(previousEmployer2316).values({
      organizationId: SRC,
      employeePartyId: srcEmployee.id,
      taxableYear: 2026,
      previousEmployerName: "PRIOR CORP",
      taxableCompensation: "100000.00",
      taxWithheld: "5000.00",
      periodsCovered: 6,
      employmentFrom: "2026-01-01",
      employmentTo: "2026-06-30",
      documentId: STRIP_MARKER,
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
        importedDocumentId: STRIP_MARKER,
      })
      .returning({ id: payrollRuns.id });
    await db.insert(payrollLines).values({
      organizationId: SRC,
      payrollRunId: run.id,
      employeePartyId: srcEmployee.id,
      basicSalary: "50000.00",
      computedTaxWithheld: "2500.00",
      varianceAcknowledgedBy: "user-should-strip",
    });
    await db.insert(payrollEmployeeYearState).values({
      organizationId: SRC,
      employeePartyId: srcEmployee.id,
      taxableYear: 2026,
      ytdTaxWithheld: "2500.00",
    });
    await db.insert(taxWithholdingPayments).values({
      organizationId: SRC,
      payeePartyId: srcPayor.id,
      payeeTin: "111222333",
      payeeRegisteredName: "SUPPLIER CORP",
      periodStart: "2026-01-01",
      periodEnd: "2026-01-31",
      atc: "WC160",
      incomePayment: "200000.00",
      taxWithheld: "10000.00",
      createdBy: "user-should-strip",
    });
    await db.insert(taxCertificates).values({
      organizationId: SRC,
      payorPartyId: srcPayor.id,
      payorTin: "111222333",
      payorRegisteredName: "SUPPLIER CORP",
      certificateNumber: "2307-001",
      periodStart: "2026-01-01",
      periodEnd: "2026-03-31",
      atc: "WC160",
      incomePayment: "200000.00",
      taxWithheld: "10000.00",
      documentId: STRIP_MARKER,
      createdBy: "user-should-strip",
    });
    await db.insert(taxComputedReturns).values({
      organizationId: SRC,
      formCode: "2550Q",
      periodStart: "2026-01-01",
      periodEnd: "2026-03-31",
      payload: { line15: "1000.00" },
      createdBy: "user-should-strip",
    });
    await db.insert(parties).values({ organizationId: DST, name: EMPLOYEE, partyType: "employee" });
    await db.insert(parties).values({ organizationId: DST, name: PAYOR, partyType: "vendor" });
  });

  afterAll(async () => {
    await sql.end();
  });

  it("exports every tenant Forms key without uuids and restores into a fresh org by reference", async () => {
    const exported = new Map<string, Record<string, unknown>[]>();
    for (const spec of PH_EXPORT_SPECS) {
      const rows = await exportPhEntity(db, SRC, spec);
      exported.set(spec.key, rows);
      expect(rows.length, `${spec.key} exported empty`).toBeGreaterThan(0);
      for (const row of rows) {
        for (const col of [...PH_ALWAYS_STRIP, ...spec.strip]) {
          expect(row, `${spec.key} leaked ${col}`).not.toHaveProperty(col);
        }
        if (spec.partyRef) {
          expect(row).not.toHaveProperty(spec.partyRef.column);
          expect(row[spec.partyRef.exportAs]).toBeTruthy();
        }
        if (spec.runRef) {
          expect(row).not.toHaveProperty(spec.runRef.column);
          expect(row).toMatchObject({
            runTaxableYear: 2026,
            runPayrollPeriod: "monthly",
            runPeriodIndex: 1,
          });
        }
        expect(JSON.stringify(row)).not.toContain(STRIP_MARKER);
        expect(JSON.stringify(row)).not.toContain("user-should-strip");
      }
    }
    expect([...exported.keys()]).toEqual([...PH_ENTITY_KEYS]);

    const line = exported.get("phPayrollLines")![0];
    expect(line).toMatchObject({
      employeeName: EMPLOYEE,
      runTaxableYear: 2026,
      runPayrollPeriod: "monthly",
      runPeriodIndex: 1,
    });

    for (const spec of PH_EXPORT_SPECS) {
      const results = await importPhEntity(db, DST, spec, exported.get(spec.key)!);
      for (const result of results) {
        expect(result.success, `${spec.key}: ${result.error ?? ""}`).toBe(true);
      }
    }

    const [dstEmployee] = await db
      .select({ id: parties.id })
      .from(parties)
      .where(and(eq(parties.organizationId, DST), eq(parties.name, EMPLOYEE)));
    const [dstPayor] = await db
      .select({ id: parties.id })
      .from(parties)
      .where(and(eq(parties.organizationId, DST), eq(parties.name, PAYOR)));
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
    expect(Number(dstLine.basicSalary)).toBe(50000);
    expect(dstLine.varianceAcknowledgedBy).toBeNull();

    const [dstProfile] = await db
      .select()
      .from(orgTaxProfiles)
      .where(eq(orgTaxProfiles.organizationId, DST));
    expect(dstProfile.registeredName).toBe("ROUNDTRIP CORP");

    const [dstBranch] = await db
      .select()
      .from(orgTaxBranches)
      .where(eq(orgTaxBranches.organizationId, DST));
    expect(dstBranch.branchCode).toBe("00001");

    const [dstElection] = await db
      .select()
      .from(orgTaxYearElections)
      .where(eq(orgTaxYearElections.organizationId, DST));
    expect(dstElection.regime).toBe("vat");

    const [dstReg] = await db
      .select()
      .from(orgTaxRegistrations)
      .where(eq(orgTaxRegistrations.organizationId, DST));
    expect(dstReg.value).toBe("registered");

    const [dstPrev] = await db
      .select()
      .from(previousEmployer2316)
      .where(eq(previousEmployer2316.organizationId, DST));
    expect(dstPrev.previousEmployerName).toBe("PRIOR CORP");
    expect(dstPrev.employeePartyId).toBe(dstEmployee.id);
    expect(dstPrev.documentId).toBeNull();

    const [dstYear] = await db
      .select()
      .from(payrollEmployeeYearState)
      .where(eq(payrollEmployeeYearState.organizationId, DST));
    expect(dstYear.employeePartyId).toBe(dstEmployee.id);
    expect(Number(dstYear.ytdTaxWithheld)).toBe(2500);

    const [dstPayment] = await db
      .select()
      .from(taxWithholdingPayments)
      .where(eq(taxWithholdingPayments.organizationId, DST));
    expect(dstPayment.payeePartyId).toBe(dstPayor.id);
    expect(dstPayment.createdBy).toBeNull();

    const [dstCert] = await db
      .select()
      .from(taxCertificates)
      .where(eq(taxCertificates.organizationId, DST));
    expect(dstCert.payorPartyId).toBe(dstPayor.id);
    expect(dstCert.certificateNumber).toBe("2307-001");
    expect(dstCert.documentId).toBeNull();
    expect(dstCert.createdBy).toBeNull();

    const [dstReturn] = await db
      .select()
      .from(taxComputedReturns)
      .where(eq(taxComputedReturns.organizationId, DST));
    expect(dstReturn.formCode).toBe("2550Q");
    expect(dstReturn.payload).toEqual({ line15: "1000.00" });
    expect(dstReturn.createdBy).toBeNull();
  });

  it("record entities refuse to merge into an org that already has rows", async () => {
    const spec = phSpecFor("phWithholdingPayments")!;
    const rows = await exportPhEntity(db, SRC, spec);
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
