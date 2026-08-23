/**
 * Live payroll filing glue.
 *
 * The engines already have their own tests. This file pins the defects the
 * assemble helper exists to close: TIN comes from party_tax_profiles, opening
 * balances are D7 rather than "the run has a dataset version", snapshot
 * control-account totals are scoped to this run, and snapshot/file refuse
 * when the workspace still blocks.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import type postgres from "postgres";
import { createTestDb } from "../utils/db-utils";
import { cleanupOrganization } from "../utils/tx-fixture";
import { accounts } from "../../src/db/schema/accounts";
import { journalHeaders, journalLines } from "../../src/db/schema/journals";
import { parties } from "../../src/db/schema/parties";
import { partyTaxProfiles } from "../../src/db/schema/party-tax";
import {
  payrollEmployeeYearState,
  payrollLines,
  payrollRuns,
  previousEmployer2316,
} from "../../src/db/schema/payroll";
import {
  assemblePayrollFilingWorkspace,
  assertWorkspaceAllowsFile,
  controlAccountMovementForRun,
  FilingWorkspaceBlockedError,
} from "../../src/lib/tax/assemble-payroll-filing-workspace";
import { takeSnapshot } from "../../src/lib/tax/filing-snapshot";

const describeDb =
  process.env.TEST_DATABASE_URL || process.env.DATABASE_URL ? describe : describe.skip;

describeDb("payroll filing glue", () => {
  let db: any;
  let sql: postgres.Sql;
  const orgs: string[] = [];

  beforeAll(async () => {
    const conn = await createTestDb();
    db = conn.db;
    sql = conn.sql;
  });

  afterAll(async () => {
    for (const org of orgs) {
      await cleanupOrganization(sql, org);
    }
    await sql.end();
  });

  async function org(): Promise<string> {
    const id = crypto.randomUUID();
    await sql`INSERT INTO auth_organizations (id, name, slug)
              VALUES (${id}, 'Glue Org', ${`glue-${id}`})`;
    orgs.push(id);
    return id;
  }

  async function employee(organizationId: string, name = "Dela Cruz"): Promise<string> {
    const [row] = await db
      .insert(parties)
      .values({ organizationId, name, partyType: "employee" })
      .returning();
    return row.id as string;
  }

  async function profile(
    organizationId: string,
    partyId: string,
    over: Record<string, unknown> = {},
  ) {
    await db.insert(partyTaxProfiles).values({
      organizationId,
      partyId,
      tin: "123456780",
      branchCode: "00000",
      lastName: "DELA CRUZ",
      firstName: "JUAN",
      isEmployee: true,
      dateHired: "2026-01-01",
      ...over,
    });
  }

  async function wtcAccount(organizationId: string): Promise<string> {
    const [row] = await db
      .insert(accounts)
      .values({
        organizationId,
        accountNumber: "25110",
        name: "Withholding Tax on Compensation Payable",
        accountType: "liability",
        subtype: "payroll_liabilities",
        isActive: true,
      })
      .returning();
    return row.id as string;
  }

  async function makeRun(
    organizationId: string,
    over: Record<string, unknown> = {},
  ): Promise<string> {
    const [row] = await db
      .insert(payrollRuns)
      .values({
        organizationId,
        taxableYear: 2026,
        payrollPeriod: "monthly",
        periodStart: "2026-03-01",
        periodEnd: "2026-03-31",
        periodIndex: 3,
        status: "computed",
        computedAt: new Date("2026-03-31T00:00:00Z"),
        referenceDatasetVersion: "2026-08-16",
        ...over,
      })
      .returning();
    return row.id as string;
  }

  async function addLine(
    organizationId: string,
    runId: string,
    employeeId: string,
    over: Record<string, unknown> = {},
  ) {
    await db.insert(payrollLines).values({
      organizationId,
      payrollRunId: runId,
      employeePartyId: employeeId,
      basicSalary: "30000",
      reportedTaxWithheld: "1375.05",
      computedTaxWithheld: "1375.05",
      varianceAmount: "0",
      ...over,
    });
  }

  async function load(organizationId: string, runId: string) {
    const [row] = await db.select().from(payrollRuns).where(eq(payrollRuns.id, runId));
    return assemblePayrollFilingWorkspace(db, organizationId, row);
  }

  it("blocks file when the employee has no party_tax_profiles TIN", async () => {
    const organizationId = await org();
    const partyId = await employee(organizationId);
    const runId = await makeRun(organizationId, {
      periodIndex: 1,
      periodStart: "2026-01-01",
      periodEnd: "2026-01-31",
    });
    await addLine(organizationId, runId, partyId);

    const assembled = await load(organizationId, runId);
    expect(assembled.workspace.blockers.some((b) => b.stage === "preflight")).toBe(true);
    expect(assembled.preflightFindings.some((f) => f.code === "ALPHA-001")).toBe(true);
    expect(() => assertWorkspaceAllowsFile(assembled.workspace)).toThrow(
      FilingWorkspaceBlockedError,
    );
  });

  it("blocks a dummy TIN even when employeePartyId is present", async () => {
    const organizationId = await org();
    const partyId = await employee(organizationId);
    await profile(organizationId, partyId, { tin: "123456789" });
    const runId = await makeRun(organizationId, {
      periodIndex: 1,
      periodStart: "2026-01-01",
      periodEnd: "2026-01-31",
    });
    await addLine(organizationId, runId, partyId);

    const assembled = await load(organizationId, runId);
    expect(assembled.preflightFindings.some((f) => f.code === "ALPHA-003")).toBe(true);
    expect(
      assembled.workspace.blockers.some(
        (b) => b.stage === "preflight" && /placeholder|TIN/.test(b.message),
      ),
    ).toBe(true);
    expect(() => assertWorkspaceAllowsFile(assembled.workspace)).toThrow(
      FilingWorkspaceBlockedError,
    );
  });

  it("does not invent a missing TIN when employeePartyId and a real TIN exist", async () => {
    const organizationId = await org();
    const partyId = await employee(organizationId);
    await profile(organizationId, partyId);
    const runId = await makeRun(organizationId, {
      periodIndex: 1,
      periodStart: "2026-01-01",
      periodEnd: "2026-01-31",
      journalHeaderId: null,
    });
    await addLine(organizationId, runId, partyId);

    const assembled = await load(organizationId, runId);
    expect(assembled.preflightFindings.filter((f) => f.severity === "fatal")).toEqual([]);
    expect(assembled.workspace.blockers.filter((b) => b.stage === "preflight")).toEqual([]);
  });

  it("does not treat a dataset version as opening-balance completeness", async () => {
    const organizationId = await org();
    const partyId = await employee(organizationId);
    await profile(organizationId, partyId);
    const runId = await makeRun(organizationId, { referenceDatasetVersion: "2026-08-16" });
    await addLine(organizationId, runId, partyId);
    await db.insert(payrollEmployeeYearState).values({
      organizationId,
      employeePartyId: partyId,
      taxableYear: 2026,
      periodsElapsed: 0,
      ytdTaxableRegular: "0",
    });

    const assembled = await load(organizationId, runId);
    expect(assembled.workspace.blockers.some((b) => b.stage === "opening_balances")).toBe(true);
  });

  it("clears opening balances once a prior-employer 2316 exists", async () => {
    const organizationId = await org();
    const partyId = await employee(organizationId);
    await profile(organizationId, partyId);
    const runId = await makeRun(organizationId);
    await addLine(organizationId, runId, partyId);
    await db.insert(previousEmployer2316).values({
      organizationId,
      employeePartyId: partyId,
      taxableYear: 2026,
      previousEmployerName: "Prior Co",
      taxableCompensation: "100000",
      taxWithheld: "8000",
      periodsCovered: 2,
      employmentFrom: "2026-01-01",
      employmentTo: "2026-02-28",
    });

    const assembled = await load(organizationId, runId);
    expect(assembled.workspace.blockers.filter((b) => b.stage === "opening_balances")).toEqual([]);
  });

  it("scopes snapshot control-account totals to this run, not the org lifetime", async () => {
    const organizationId = await org();
    const wtc = await wtcAccount(organizationId);
    const cash = (
      await db
        .insert(accounts)
        .values({
          organizationId,
          accountNumber: "11100",
          name: "Cash",
          accountType: "asset",
          isActive: true,
        })
        .returning()
    )[0].id as string;

    async function post(date: string, amount: string): Promise<string> {
      return db.transaction(async (tx: any) => {
        const [header] = await tx
          .insert(journalHeaders)
          .values({
            organizationId,
            transactionDate: date,
            transactionType: "journal",
            source: "manual",
            status: "posted",
            totalAmount: amount,
            functionalCurrency: "PHP",
          })
          .returning();
        await tx.insert(journalLines).values([
          { journalHeaderId: header.id, accountId: cash, debit: amount, sortOrder: 0 },
          { journalHeaderId: header.id, accountId: wtc, credit: amount, sortOrder: 1 },
        ]);
        return header.id as string;
      });
    }

    const thisRunJournal = await post("2026-03-15", "1375.05");
    await post("2026-02-15", "9999.00");

    const movement = await controlAccountMovementForRun(db, organizationId, {
      journalHeaderId: thisRunJournal,
      periodStart: "2026-03-01",
      periodEnd: "2026-03-31",
    });
    expect(Number(movement.credits)).toBeCloseTo(1375.05, 2);
    expect(Number(movement.debits)).toBe(0);

    const unscopedWouldIncludeFebruary = await controlAccountMovementForRun(db, organizationId, {
      journalHeaderId: null,
      periodStart: "2026-01-01",
      periodEnd: "2026-12-31",
    });
    expect(Number(unscopedWouldIncludeFebruary.credits)).toBeGreaterThan(1375.05);
  });

  it("refuses file without a snapshot and uses the run dataset version, not a page constant", async () => {
    const organizationId = await org();
    const partyId = await employee(organizationId);
    await profile(organizationId, partyId);
    const wtc = await wtcAccount(organizationId);
    const cash = (
      await db
        .insert(accounts)
        .values({
          organizationId,
          accountNumber: "11100",
          name: "Cash",
          accountType: "asset",
          isActive: true,
        })
        .returning()
    )[0].id as string;
    const header = await db.transaction(async (tx: any) => {
      const [created] = await tx
        .insert(journalHeaders)
        .values({
          organizationId,
          transactionDate: "2026-01-15",
          transactionType: "journal",
          source: "manual",
          status: "posted",
          totalAmount: "1375.05",
          functionalCurrency: "PHP",
        })
        .returning();
      await tx.insert(journalLines).values([
        { journalHeaderId: created.id, accountId: cash, debit: "1375.05", sortOrder: 0 },
        { journalHeaderId: created.id, accountId: wtc, credit: "1375.05", sortOrder: 1 },
      ]);
      return created;
    });

    const runId = await makeRun(organizationId, {
      periodIndex: 1,
      periodStart: "2026-01-01",
      periodEnd: "2026-01-31",
      journalHeaderId: header.id,
      acknowledgedAt: new Date(),
      acknowledgedBy: "tester",
      acknowledgementNote: "register stands",
      status: "acknowledged",
    });
    await addLine(organizationId, runId, partyId);

    const before = await load(organizationId, runId);
    expect(() => assertWorkspaceAllowsFile(before.workspace)).toThrow(/as-filed snapshot/);
    expect(before.run.referenceDatasetVersion).toBe("2026-08-16");

    const movement = await controlAccountMovementForRun(db, organizationId, before.run);
    const snapshot = takeSnapshot({
      formCode: "1604C",
      periodStart: before.run.periodStart,
      periodEnd: before.run.periodEnd,
      amendmentSequence: 0,
      referenceDatasetVersion: before.run.referenceDatasetVersion!,
      totals: {
        employeeCount: before.lines.length,
        controlAccountCredits: movement.credits,
        controlAccountDebits: movement.debits,
      },
      lines: before.lines.map((line) => ({
        key: line.employeePartyId,
        values: { withheld: line.reportedTaxWithheld },
      })),
    });
    expect(snapshot.referenceDatasetVersion).toBe(before.run.referenceDatasetVersion);
    expect(snapshot.referenceDatasetVersion).not.toBe("");
  });

  it("persists a template register by TIN and refuses an unknown TIN", async () => {
    const organizationId = await org();
    const partyId = await employee(organizationId);
    await profile(organizationId, partyId, { tin: "123456780" });
    const runId = await makeRun(organizationId, {
      periodIndex: 1,
      periodStart: "2026-01-01",
      periodEnd: "2026-01-31",
      status: "draft",
      computedAt: null,
      referenceDatasetVersion: null,
    });

    const { persistImportedRegister, UnmatchedRegisterTinsError } =
      await import("../../src/lib/tax/persist-register-import");

    await expect(
      persistImportedRegister(db, {
        organizationId,
        runId,
        headers: ["employeeTin", "basicSalary", "reportedTaxWithheld"],
        rows: [["000000000", "30000", "1375.05"]],
      }),
    ).rejects.toBeInstanceOf(UnmatchedRegisterTinsError);

    const result = await persistImportedRegister(db, {
      organizationId,
      runId,
      headers: ["employeeTin", "basicSalary", "reportedTaxWithheld"],
      rows: [["123456780", "30000", "1375.05"]],
    });
    expect(result.persisted).toBe(1);
    expect(result.parsed.canProceed).toBe(true);

    const assembled = await load(organizationId, runId);
    expect(assembled.lines).toHaveLength(1);
    expect(assembled.lines[0].employeePartyId).toBe(partyId);
    expect(assembled.workspace.blockers.some((b) => b.stage === "computation")).toBe(true);
  });
});
