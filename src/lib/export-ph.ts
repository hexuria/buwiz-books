/**
 * Philippine tax tables in the versioned export/import system (Program 2 P5).
 *
 * The audit's finding: every PH table added by migrations 0037–0047 was
 * absent from EXPORTABLE_ENTITIES, so "a full export is not a full backup" —
 * an org's compliance history (as-filed snapshots included) simply wasn't in
 * the file. This module is schema-driven: projections and row validators
 * derive from the Drizzle tables, so a new column is exported the moment it
 * exists (and the wiring test fails if a new PH table is not registered).
 *
 * Reference semantics (the same resolvable-pair rule the banks/parties
 * export follows — ids never cross databases):
 *  • party links travel as the party's NAME and resolve org-scoped on import;
 *  • payroll lines travel with their run's (taxableYear, payrollPeriod,
 *    periodIndex) triple and resolve against the runs imported before them;
 *  • journal/document/user ids are STRIPPED — journals are not part of the
 *    export system, so those links cannot survive a restore. Documented
 *    limitation, not silent loss: the columns are listed per entity below.
 *
 * Import contract:
 *  • kind "config" upserts by natural key (safe to re-run);
 *  • kind "record" is RESTORE-ONLY: it refuses when the target org already
 *    has rows for that entity. Merging two orgs' compliance histories is a
 *    correctness hazard (year-states, snapshots), not a UX nicety.
 */
import { and, eq, getTableColumns, inArray } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import type { DbExecutor } from "@/db";
import { parties } from "@/db/schema/parties";
import { orgTaxBranches, orgTaxProfiles } from "@/db/schema/tax-reference";
import {
  orgTaxRegistrations,
  orgTaxYearElections,
  taxComputedReturns,
  taxWithholdingPayments,
} from "@/db/schema/tax-stage-remainder";
import { partyTaxProfiles } from "@/db/schema/party-tax";
import { taxCertificates } from "@/db/schema/tax-certificates";
import {
  payrollEmployeeYearState,
  payrollLines,
  payrollRuns,
  previousEmployer2316,
} from "@/db/schema/payroll";

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyTable = any;

export interface PhEntitySpec {
  key: string;
  label: string;
  table: AnyTable;
  kind: "config" | "record";
  /** Natural-key columns for config upserts (empty = one row per org). */
  natural: string[];
  /** uuid party column exported/imported as `<exportAs>` (the party's name). */
  partyRef?: { column: string; exportAs: string };
  /** payroll_lines: run uuid resolved via the run's natural triple. */
  runRef?: { column: string };
  /** uuid/user columns stripped on export — they cannot survive a restore. */
  strip: string[];
  /** Column used as the row's display name in results. */
  display: string;
}

export const PH_EXPORT_SPECS: PhEntitySpec[] = [
  {
    key: "phOrgTaxProfile",
    label: "PH Tax Profile",
    table: orgTaxProfiles,
    kind: "config",
    natural: [],
    strip: [],
    display: "registeredName",
  },
  {
    key: "phOrgTaxBranches",
    label: "PH Tax Branches",
    table: orgTaxBranches,
    kind: "config",
    natural: ["branchCode"],
    strip: [],
    display: "branchCode",
  },
  {
    key: "phTaxYearElections",
    label: "PH Tax Year Elections",
    table: orgTaxYearElections,
    kind: "config",
    natural: ["taxableYear"],
    strip: [],
    display: "taxableYear",
  },
  {
    key: "phTaxRegistrations",
    label: "PH Tax Registrations",
    table: orgTaxRegistrations,
    kind: "config",
    natural: ["regimeKind", "effectiveFrom"],
    strip: [],
    display: "regimeKind",
  },
  {
    key: "phPartyTaxProfiles",
    label: "PH Party Tax Profiles",
    table: partyTaxProfiles,
    kind: "config",
    natural: ["partyName"],
    partyRef: { column: "partyId", exportAs: "partyName" },
    strip: [],
    display: "partyName",
  },
  {
    key: "phPreviousEmployer2316",
    label: "PH Previous-Employer 2316",
    table: previousEmployer2316,
    kind: "record",
    natural: [],
    partyRef: { column: "employeePartyId", exportAs: "employeeName" },
    strip: ["documentId"],
    display: "employeeName",
  },
  {
    key: "phWithholdingPayments",
    label: "PH Withholding Payments",
    table: taxWithholdingPayments,
    kind: "record",
    natural: [],
    partyRef: { column: "payeePartyId", exportAs: "payeeName" },
    strip: ["journalHeaderId", "createdBy"],
    display: "payeeRegisteredName",
  },
  {
    key: "phTaxCertificates",
    label: "PH Tax Certificates",
    table: taxCertificates,
    kind: "record",
    natural: [],
    partyRef: { column: "payorPartyId", exportAs: "payorName" },
    strip: ["journalHeaderId", "documentId", "createdBy"],
    display: "certificateNumber",
  },
  {
    key: "phPayrollRuns",
    label: "PH Payroll Runs",
    table: payrollRuns,
    kind: "record",
    natural: [],
    strip: ["journalHeaderId", "importedDocumentId", "acknowledgedBy"],
    display: "periodEnd",
  },
  {
    key: "phPayrollLines",
    label: "PH Payroll Lines",
    table: payrollLines,
    kind: "record",
    natural: [],
    partyRef: { column: "employeePartyId", exportAs: "employeeName" },
    runRef: { column: "payrollRunId" },
    strip: ["varianceAcknowledgedBy"],
    display: "employeeName",
  },
  {
    key: "phPayrollYearState",
    label: "PH Payroll Year State",
    table: payrollEmployeeYearState,
    kind: "record",
    natural: [],
    partyRef: { column: "employeePartyId", exportAs: "employeeName" },
    strip: [],
    display: "employeeName",
  },
  {
    key: "phComputedReturns",
    label: "PH Computed Returns (as-filed)",
    table: taxComputedReturns,
    kind: "record",
    natural: [],
    strip: ["createdBy"],
    display: "formCode",
  },
];

export const PH_ENTITY_KEYS = PH_EXPORT_SPECS.map((spec) => spec.key);

export function phSpecFor(entityType: string): PhEntitySpec | undefined {
  return PH_EXPORT_SPECS.find((spec) => spec.key === entityType);
}

const ALWAYS_STRIP = ["id", "organizationId", "createdAt", "updatedAt"];
const RUN_TRIPLE = ["runTaxableYear", "runPayrollPeriod", "runPeriodIndex"] as const;

/** Row validator: the table's insert schema minus stripped/ref columns, plus refs. */
export function phRowSchema(spec: PhEntitySpec): z.ZodTypeAny {
  const omit: Record<string, true> = {};
  for (const col of [...ALWAYS_STRIP, ...spec.strip]) omit[col] = true;
  if (spec.partyRef) omit[spec.partyRef.column] = true;
  if (spec.runRef) omit[spec.runRef.column] = true;
  let schema: z.ZodObject<z.ZodRawShape> = (
    createInsertSchema(spec.table) as unknown as z.ZodObject<z.ZodRawShape>
  ).omit(omit as never);
  const extension: Record<string, z.ZodTypeAny> = {};
  if (spec.partyRef) extension[spec.partyRef.exportAs] = z.string().optional().nullable();
  if (spec.runRef) {
    extension.runTaxableYear = z.number();
    extension.runPayrollPeriod = z.string();
    extension.runPeriodIndex = z.number();
  }
  if (Object.keys(extension).length > 0) schema = schema.extend(extension);
  return schema;
}

export async function exportPhEntity(
  db: DbExecutor,
  orgId: string,
  spec: PhEntitySpec,
): Promise<Record<string, unknown>[]> {
  const cols = getTableColumns(spec.table);
  const rows: Record<string, unknown>[] = await (db as any)
    .select()
    .from(spec.table)
    .where(eq(cols.organizationId, orgId));

  const partyNameById = new Map<string, string>();
  if (spec.partyRef) {
    const ids = [
      ...new Set(rows.map((row) => row[spec.partyRef!.column] as string | null).filter(Boolean)),
    ] as string[];
    if (ids.length > 0) {
      const partyRows = await db
        .select({ id: parties.id, name: parties.name })
        .from(parties)
        .where(and(eq(parties.organizationId, orgId), inArray(parties.id, ids)));
      for (const row of partyRows) partyNameById.set(row.id, row.name);
    }
  }

  const runTripleById = new Map<string, Record<string, unknown>>();
  if (spec.runRef) {
    const runRows = await db
      .select({
        id: payrollRuns.id,
        taxableYear: payrollRuns.taxableYear,
        payrollPeriod: payrollRuns.payrollPeriod,
        periodIndex: payrollRuns.periodIndex,
      })
      .from(payrollRuns)
      .where(eq(payrollRuns.organizationId, orgId));
    for (const run of runRows) {
      runTripleById.set(run.id, {
        runTaxableYear: run.taxableYear,
        runPayrollPeriod: run.payrollPeriod,
        runPeriodIndex: run.periodIndex,
      });
    }
  }

  return rows.map((row) => {
    const out: Record<string, unknown> = { ...row };
    for (const col of [...ALWAYS_STRIP, ...spec.strip]) delete out[col];
    if (spec.partyRef) {
      const partyId = row[spec.partyRef.column] as string | null;
      out[spec.partyRef.exportAs] = partyId ? (partyNameById.get(partyId) ?? null) : null;
      delete out[spec.partyRef.column];
    }
    if (spec.runRef) {
      const runId = row[spec.runRef.column] as string;
      Object.assign(out, runTripleById.get(runId) ?? {});
      delete out[spec.runRef.column];
    }
    return out;
  });
}

export interface PhImportResult {
  name: string;
  success: boolean;
  error?: string;
}

export async function importPhEntity(
  db: DbExecutor,
  orgId: string,
  spec: PhEntitySpec,
  rows: Record<string, unknown>[],
): Promise<PhImportResult[]> {
  const results: PhImportResult[] = [];
  const cols = getTableColumns(spec.table);

  if (spec.kind === "record") {
    // organizationId is the one column every spec table has (org_tax_profiles
    // has no surrogate id — organizationId IS its primary key).
    const [existing] = await (db as any)
      .select({ marker: cols.organizationId })
      .from(spec.table)
      .where(eq(cols.organizationId, orgId))
      .limit(1);
    if (existing) {
      return rows.map((row) => ({
        name: String(row[spec.display] ?? spec.label),
        success: false,
        error: `${spec.label}: this organization already has rows — PH compliance records restore only into an organization without them.`,
      }));
    }
  }

  const partyIdByName = new Map<string, string>();
  if (spec.partyRef) {
    const partyRows = await db
      .select({ id: parties.id, name: parties.name })
      .from(parties)
      .where(eq(parties.organizationId, orgId));
    for (const row of partyRows) {
      if (!partyIdByName.has(row.name)) partyIdByName.set(row.name, row.id);
    }
  }

  const runIdByTriple = new Map<string, string>();
  if (spec.runRef) {
    const runRows = await db
      .select({
        id: payrollRuns.id,
        taxableYear: payrollRuns.taxableYear,
        payrollPeriod: payrollRuns.payrollPeriod,
        periodIndex: payrollRuns.periodIndex,
      })
      .from(payrollRuns)
      .where(eq(payrollRuns.organizationId, orgId));
    for (const run of runRows) {
      runIdByTriple.set(`${run.taxableYear}:${run.payrollPeriod}:${run.periodIndex}`, run.id);
    }
  }

  for (const row of rows) {
    const name = String(row[spec.display] ?? spec.label);
    try {
      const values: Record<string, unknown> = { ...row, organizationId: orgId };
      for (const key of RUN_TRIPLE) delete values[key];

      if (spec.partyRef) {
        const partyName = row[spec.partyRef.exportAs] as string | null;
        delete values[spec.partyRef.exportAs];
        if (partyName) {
          const partyId = partyIdByName.get(partyName);
          if (!partyId) {
            results.push({
              name,
              success: false,
              error: `Party "${partyName}" not found — import parties first.`,
            });
            continue;
          }
          values[spec.partyRef.column] = partyId;
        } else {
          values[spec.partyRef.column] = null;
        }
      }
      if (spec.runRef) {
        const tripleKey = `${row.runTaxableYear}:${row.runPayrollPeriod}:${row.runPeriodIndex}`;
        const runId = runIdByTriple.get(tripleKey);
        if (!runId) {
          results.push({
            name,
            success: false,
            error: `Payroll run ${tripleKey} not found — import phPayrollRuns first.`,
          });
          continue;
        }
        values[spec.runRef.column] = runId;
      }

      if (spec.kind === "config") {
        const conditions = [eq(cols.organizationId, orgId)];
        for (const key of spec.natural) {
          const value =
            spec.partyRef && key === spec.partyRef.exportAs
              ? values[spec.partyRef.column]
              : values[key];
          const column =
            spec.partyRef && key === spec.partyRef.exportAs
              ? cols[spec.partyRef.column]
              : cols[key];
          conditions.push(eq(column, value as never));
        }
        const [existing] = await (db as any)
          .select({ marker: cols.organizationId })
          .from(spec.table)
          .where(and(...conditions))
          .limit(1);
        if (existing) {
          // The same org+natural-key conditions identify exactly the row to
          // update — no reliance on a surrogate id (org_tax_profiles has none).
          await (db as any)
            .update(spec.table)
            .set(values)
            .where(and(...conditions));
          results.push({ name, success: true, error: "Updated existing" });
          continue;
        }
      }

      await (db as any).insert(spec.table).values(values);
      results.push({ name, success: true });
    } catch (err) {
      results.push({
        name,
        success: false,
        error: err instanceof Error ? err.message : "Unknown error",
      });
    }
  }
  return results;
}
