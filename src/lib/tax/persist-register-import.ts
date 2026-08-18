/**
 * Persist a parsed payroll register onto a run.
 *
 * importRegister is pure: it maps cells to fields and refuses to guess.
 * This module is the write path. Employees are matched by the TIN on
 * party_tax_profiles — never by name, and never by creating a party. A TIN
 * with no profile is a data problem the bookkeeper has to fix, not a prompt
 * to invent an employee.
 */
import { and, eq, inArray } from "drizzle-orm";
import type { DbExecutor } from "@/db";
import { partyTaxProfiles } from "@/db/schema/party-tax";
import { payrollLines, payrollRuns } from "@/db/schema/payroll";
import {
  BUWIZ_TEMPLATE,
  IMPORTABLE_FIELDS,
  importRegister,
  type ImportableField,
  type ImportIssue,
  type ImportResult,
} from "@/lib/tax/register-import";

export interface PersistRegisterInput {
  organizationId: string;
  runId: string;
  headers: readonly string[];
  rows: ReadonlyArray<readonly string[]>;
  columnMap?: Readonly<Record<string, ImportableField>>;
}

export interface PersistRegisterResult {
  parsed: ImportResult;
  persisted: number;
  unmatchedTins: string[];
}

const LINE_FIELDS = new Set<ImportableField>(
  IMPORTABLE_FIELDS.filter((field) => field !== "employeeTin" && !field.startsWith("employee")),
);

export class RegisterAlreadyPostedError extends Error {
  constructor(runId: string) {
    super(
      `Payroll run ${runId} is already posted. Re-importing would change the register under a journal that already exists.`,
    );
    this.name = "RegisterAlreadyPostedError";
  }
}

export class RegisterAlreadyFiledError extends Error {
  constructor(runId: string) {
    super(`Payroll run ${runId} is already filed. An amendment is a separate, deliberate act.`);
    this.name = "RegisterAlreadyFiledError";
  }
}

export class UnmatchedRegisterTinsError extends Error {
  constructor(readonly unmatchedTins: string[]) {
    super(
      `${unmatchedTins.length} TIN(s) have no party_tax_profiles row. The import will not invent employees.`,
    );
    this.name = "UnmatchedRegisterTinsError";
  }
}

export async function persistImportedRegister(
  db: DbExecutor,
  input: PersistRegisterInput,
): Promise<PersistRegisterResult> {
  const [run] = await db
    .select()
    .from(payrollRuns)
    .where(
      and(eq(payrollRuns.id, input.runId), eq(payrollRuns.organizationId, input.organizationId)),
    )
    .limit(1)
    .for("update");
  if (!run) throw new Error("Payroll run not found");
  if (run.journalHeaderId) throw new RegisterAlreadyPostedError(input.runId);
  if (run.filingReference || run.filedAt) throw new RegisterAlreadyFiledError(input.runId);
  if (run.status === "locked") throw new RegisterAlreadyFiledError(input.runId);

  const parsed = importRegister({
    headers: input.headers,
    rows: input.rows,
    columnMap: input.columnMap ?? BUWIZ_TEMPLATE,
  });
  if (!parsed.canProceed) {
    return { parsed, persisted: 0, unmatchedTins: [] };
  }

  const tins = parsed.rows
    .map((row) => row.values.employeeTin)
    .filter((tin): tin is string => Boolean(tin));

  const profiles =
    tins.length === 0
      ? []
      : await db
          .select({
            partyId: partyTaxProfiles.partyId,
            tin: partyTaxProfiles.tin,
          })
          .from(partyTaxProfiles)
          .where(
            and(
              eq(partyTaxProfiles.organizationId, input.organizationId),
              inArray(partyTaxProfiles.tin, tins),
            ),
          );

  const partyByTin = new Map(profiles.map((profile) => [profile.tin, profile.partyId]));
  const unmatchedTins = [...new Set(tins.filter((tin) => !partyByTin.has(tin)))];
  if (unmatchedTins.length > 0) {
    throw new UnmatchedRegisterTinsError(unmatchedTins);
  }

  await db.delete(payrollLines).where(eq(payrollLines.payrollRunId, input.runId));

  const values = parsed.rows.map((row) => {
    const tin = row.values.employeeTin!;
    const line: Record<string, unknown> = {
      organizationId: input.organizationId,
      payrollRunId: input.runId,
      employeePartyId: partyByTin.get(tin),
      basicSalary: row.values.basicSalary ?? "0",
    };
    for (const field of LINE_FIELDS) {
      if (field === "basicSalary") continue;
      if (row.values[field] !== undefined) line[field] = row.values[field];
    }
    return line;
  });

  if (values.length > 0) {
    await db.insert(payrollLines).values(values as (typeof payrollLines.$inferInsert)[]);
  }

  await db
    .update(payrollRuns)
    .set({
      status: "imported",
      importSource: input.columnMap ? "mapped_register" : "buwiz_template",
      computedAt: null,
      acknowledgedAt: null,
      acknowledgedBy: null,
      acknowledgementNote: null,
      snapshotChecksum: null,
      snapshotTakenAt: null,
      updatedAt: new Date(),
    })
    .where(eq(payrollRuns.id, input.runId));

  return { parsed, persisted: values.length, unmatchedTins: [] };
}

export function fatalImportIssues(issues: readonly ImportIssue[]): ImportIssue[] {
  return issues.filter((issue) => issue.severity === "fatal");
}
