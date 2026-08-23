/**
 * Payroll run mutations the filing screen can actually reach.
 *
 * importRegister / computePayrollRun / postPayrollRun existed as engines.
 * This is the route glue: persist a pasted register, compute the verifier,
 * and post the journal. Each mutation re-derives the workspace and refuses
 * what is still blocked.
 */
import { createServerFn } from "@tanstack/react-start";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { parties } from "../../db/schema/parties";
import { partyTaxProfiles } from "../../db/schema/party-tax";
import { payrollRuns } from "../../db/schema/payroll";

import { previousEmployer2316 } from "../../db/schema/payroll";
import { orgTaxProfiles } from "../../db/schema/tax-reference";
import { DATASET_V1 } from "../../lib/tax/reference-catalog";
import { isAnnualizationPeriod, periodIndexFromDates } from "../../lib/tax/payroll-period";
import { withMutationPermissionOrgContext, withSessionOrgContext } from "../../lib/server-context";
import {
  assemblePayrollFilingWorkspace,
  assertWorkspaceAllowsPost,
} from "../../lib/tax/assemble-payroll-filing-workspace";
import { persistImportedRegister } from "../../lib/tax/persist-register-import";
import { issuePayrollArtifacts } from "../../lib/tax/issue-payroll-artifacts";
import { postAnnualization } from "../../lib/tax/annualization-posting";

import { issueForm1601C } from "../../lib/tax/issue-1601c";
import { computePayrollRun } from "../../lib/tax/payroll-run-service";
import { postPayrollRun } from "../../lib/tax/payroll-journal";
import { BUWIZ_TEMPLATE, IMPORTABLE_FIELDS } from "../../lib/tax/register-import";
import { isPlaceholderTin } from "../../lib/tax/alphalist-preflight";

const periodSchema = z.object({ runId: z.string().uuid() });

const importSchema = z.object({
  runId: z.string().uuid(),
  /** First row is headers. Remaining rows are the register. */
  table: z.array(z.array(z.string())).min(2),
  columnMap: z.record(z.string(), z.enum(IMPORTABLE_FIELDS)).optional(),
});

export const importPayrollRegister = createServerFn({ method: "POST" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "journal",
      "update",
      { routeKey: "payroll:import", limit: 20, windowMs: 60_000 },
      async ({ orgId, db }) => {
        const parsed = importSchema.parse(rawData);
        const [headers, ...rows] = parsed.table;
        const result = await persistImportedRegister(db, {
          organizationId: orgId,
          runId: parsed.runId,
          headers,
          rows,
          columnMap: parsed.columnMap ?? BUWIZ_TEMPLATE,
        });
        if (!result.parsed.canProceed) {
          return {
            persisted: 0,
            canProceed: false,
            issues: result.parsed.issues,
            unmappedColumns: result.parsed.unmappedColumns,
          };
        }
        return {
          persisted: result.persisted,
          canProceed: true,
          issues: result.parsed.issues,
          unmappedColumns: result.parsed.unmappedColumns,
        };
      },
    );
  },
);

export const computePayrollFilingRun = createServerFn({ method: "POST" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "journal",
      "update",
      { routeKey: "payroll:compute", limit: 20, windowMs: 60_000 },
      async ({ orgId, db }) => {
        const { runId } = periodSchema.parse(rawData);
        const [run] = await db
          .select()
          .from(payrollRuns)
          .where(and(eq(payrollRuns.id, runId), eq(payrollRuns.organizationId, orgId)))
          .limit(1)
          .for("update");
        if (!run) throw new Error("Payroll run not found");
        if (run.journalHeaderId) {
          throw new Error(
            "This run is already posted; recompute would change the register under a journal.",
          );
        }
        if (run.filingReference || run.status === "locked") {
          throw new Error("A filed run is not recomputed. Amend it.");
        }
        // One transaction for the whole compute: MissingPreviousEmployerError
        // must leave nothing behind, and the per-line updates plus the
        // year-state upserts are one logical write.
        return db.transaction((tx) => computePayrollRun(tx as never, orgId, runId));
      },
    );
  },
);

export const postPayrollFilingRun = createServerFn({ method: "POST" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "journal",
      "update",
      { routeKey: "payroll:post", limit: 10, windowMs: 60_000 },
      async ({ orgId, userId, db }) => {
        const { runId } = periodSchema.parse(rawData);
        const [run] = await db
          .select()
          .from(payrollRuns)
          .where(and(eq(payrollRuns.id, runId), eq(payrollRuns.organizationId, orgId)))
          .limit(1)
          .for("update");
        if (!run) throw new Error("Payroll run not found");
        const assembled = await assemblePayrollFilingWorkspace(db, orgId, run);
        assertWorkspaceAllowsPost(assembled.workspace);
        return db.transaction((tx) => postPayrollRun(tx, { organizationId: orgId, userId, runId }));
      },
    );
  },
);

/**
 * Post the year-end annualization true-up: refunds to over-withheld
 * employees, collectible deficiencies, and the employer-absorbed shortfall.
 *
 * postAnnualization existed fully built and tested with NO caller — the
 * 25-January refund obligation could never reach the ledger. The run is
 * recomputed inside the same transaction (compute is idempotent by replay),
 * so the entries posted are exactly the figures of the run as it stands.
 */
export const postAnnualizationTrueUp = createServerFn({ method: "POST" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "journal",
      "post",
      { routeKey: "payroll:post-annualization", limit: 10, windowMs: 60_000 },
      async ({ orgId, userId, db }) => {
        const { runId } = z.object({ runId: z.string().uuid() }).parse(rawData);
        return db.transaction(async (tx) => {
          const [run] = await tx
            .select()
            .from(payrollRuns)
            .where(and(eq(payrollRuns.id, runId), eq(payrollRuns.organizationId, orgId)));
          if (!run) throw new Error("Payroll run not found");
          if (!run.isAnnualizationRun) {
            throw new Error("Only an annualization run posts the year-end true-up.");
          }
          const computed = await computePayrollRun(tx as never, orgId, runId);
          const entries = computed.annualizationEntries ?? [];
          const posted = await postAnnualization(tx, {
            organizationId: orgId,
            userId,
            taxableYear: run.taxableYear,
            entries,
          });
          return { runId, ...posted };
        });
      },
    );
  },
);

export const listPayrollRuns = createServerFn({ method: "GET" }).handler(async () => {
  return withSessionOrgContext(async ({ orgId, db }) => {
    return db
      .select({
        id: payrollRuns.id,
        taxableYear: payrollRuns.taxableYear,
        payrollPeriod: payrollRuns.payrollPeriod,
        periodStart: payrollRuns.periodStart,
        periodEnd: payrollRuns.periodEnd,
        periodIndex: payrollRuns.periodIndex,
        status: payrollRuns.status,
        journalHeaderId: payrollRuns.journalHeaderId,
        filingReference: payrollRuns.filingReference,
      })
      .from(payrollRuns)
      .where(eq(payrollRuns.organizationId, orgId))
      .orderBy(desc(payrollRuns.periodEnd));
  });
});

const createRunSchema = z.object({
  taxableYear: z.number().int().min(2000).max(2100),
  payrollPeriod: z.enum(["daily", "weekly", "semi_monthly", "monthly", "annual"]),
  periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export const createPayrollRun = createServerFn({ method: "POST" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "journal",
      "create",
      { routeKey: "payroll:create", limit: 20, windowMs: 60_000 },
      async ({ orgId, db }) => {
        const input = createRunSchema.parse(rawData);
        if (input.periodEnd < input.periodStart) {
          throw new Error("periodEnd must be on or after periodStart");
        }
        const periodIndex = periodIndexFromDates(input.payrollPeriod, input.periodEnd);
        const [run] = await db
          .insert(payrollRuns)
          .values({
            organizationId: orgId,
            taxableYear: input.taxableYear,
            payrollPeriod: input.payrollPeriod,
            periodStart: input.periodStart,
            periodEnd: input.periodEnd,
            periodIndex,
            status: "draft",
            isAnnualizationRun: isAnnualizationPeriod(input.payrollPeriod, input.periodEnd),
            referenceDatasetVersion: DATASET_V1.version,
          })
          .returning({ id: payrollRuns.id });
        if (!run) throw new Error("Could not create payroll run");
        return run;
      },
    );
  },
);

const profileSchema = z.object({
  partyId: z.string().uuid().optional(),
  name: z.string().min(1).optional(),
  tin: z.string().regex(/^\d{9}$/),
  lastName: z.string().min(1),
  firstName: z.string().min(1),
  dateHired: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export const upsertEmployeeTaxProfile = createServerFn({ method: "POST" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "journal",
      "update",
      { routeKey: "payroll:profile", limit: 30, windowMs: 60_000 },
      async ({ orgId, db }) => {
        const input = profileSchema.parse(rawData);
        if (isPlaceholderTin(input.tin)) {
          throw new Error("That employee TIN is a placeholder; dummy TINs are banned.");
        }
        const [existingByTin] = await db
          .select({ partyId: partyTaxProfiles.partyId })
          .from(partyTaxProfiles)
          .where(
            and(eq(partyTaxProfiles.organizationId, orgId), eq(partyTaxProfiles.tin, input.tin)),
          )
          .limit(1);
        let partyId = input.partyId;
        if (existingByTin) {
          partyId = existingByTin.partyId;
        } else if (!partyId) {
          if (!input.name) throw new Error("name is required when creating an employee");
          const [party] = await db
            .insert(parties)
            .values({ organizationId: orgId, name: input.name, partyType: "employee" })
            .returning({ id: parties.id });
          if (!party) throw new Error("Could not create employee");
          partyId = party.id;
        }
        await db
          .insert(partyTaxProfiles)
          .values({
            organizationId: orgId,
            partyId,
            tin: input.tin,
            lastName: input.lastName,
            firstName: input.firstName,
            dateHired: input.dateHired,
            isEmployee: true,
          })
          .onConflictDoUpdate({
            target: [partyTaxProfiles.organizationId, partyTaxProfiles.partyId],
            set: {
              tin: input.tin,
              lastName: input.lastName,
              firstName: input.firstName,
              dateHired: input.dateHired,
              isEmployee: true,
              updatedAt: new Date(),
            },
          });
        return { partyId, tin: input.tin };
      },
    );
  },
);

const previousSchema = z.object({
  employeeTin: z.string().regex(/^\d{9}$/),
  taxableYear: z.number().int().min(2000).max(2100),
  previousEmployerTin: z
    .string()
    .regex(/^\d{9}$/)
    .optional(),
  previousEmployerName: z.string().min(1),
  taxableCompensation: z.string().min(1),
  taxWithheld: z.string().min(1),
  periodsCovered: z.number().int().min(1).max(24),
  employmentFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  employmentTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export const capturePreviousEmployer2316 = createServerFn({ method: "POST" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "journal",
      "update",
      { routeKey: "payroll:prev-2316", limit: 20, windowMs: 60_000 },
      async ({ orgId, db }) => {
        const input = previousSchema.parse(rawData);
        if (isPlaceholderTin(input.employeeTin) || isPlaceholderTin(input.previousEmployerTin)) {
          throw new Error("A placeholder TIN cannot be stored on a previous-employer 2316.");
        }
        const [profile] = await db
          .select({ partyId: partyTaxProfiles.partyId })
          .from(partyTaxProfiles)
          .where(
            and(
              eq(partyTaxProfiles.organizationId, orgId),
              eq(partyTaxProfiles.tin, input.employeeTin),
            ),
          )
          .limit(1);
        if (!profile)
          throw new Error("No employee TIN profile matches that TIN. Save the employee first.");
        const [row] = await db
          .insert(previousEmployer2316)
          .values({
            organizationId: orgId,
            employeePartyId: profile.partyId,
            taxableYear: input.taxableYear,
            previousEmployerTin: input.previousEmployerTin ?? null,
            previousEmployerName: input.previousEmployerName,
            taxableCompensation: input.taxableCompensation,
            taxWithheld: input.taxWithheld,
            periodsCovered: input.periodsCovered,
            employmentFrom: input.employmentFrom,
            employmentTo: input.employmentTo,
          })
          .onConflictDoUpdate({
            target: [
              previousEmployer2316.organizationId,
              previousEmployer2316.employeePartyId,
              previousEmployer2316.taxableYear,
              previousEmployer2316.previousEmployerName,
            ],
            set: {
              previousEmployerTin: input.previousEmployerTin ?? null,
              taxableCompensation: input.taxableCompensation,
              taxWithheld: input.taxWithheld,
              periodsCovered: input.periodsCovered,
              employmentFrom: input.employmentFrom,
              employmentTo: input.employmentTo,
              updatedAt: new Date(),
            },
          })
          .returning({ id: previousEmployer2316.id });
        if (!row) throw new Error("Could not capture previous-employer 2316");
        return { id: row.id, employeePartyId: profile.partyId };
      },
    );
  },
);

export const getOrgTaxProfile = createServerFn({ method: "GET" }).handler(async () => {
  return withSessionOrgContext(async ({ orgId, db }) => {
    const [row] = await db
      .select({
        tin: orgTaxProfiles.tin,
        branchCode: orgTaxProfiles.branchCode,
        rdoCode: orgTaxProfiles.rdoCode,
        registeredName: orgTaxProfiles.registeredName,
      })
      .from(orgTaxProfiles)
      .where(eq(orgTaxProfiles.organizationId, orgId))
      .limit(1);
    return row ?? { tin: null, branchCode: "00000", rdoCode: null, registeredName: null };
  });
});

const orgProfileSchema = z.object({
  tin: z.string().regex(/^\d{9}$/),
  registeredName: z.string().min(1),
  branchCode: z
    .string()
    .regex(/^\d{4,5}$/)
    .default("00000"),
  rdoCode: z.string().min(1).optional(),
});

export const upsertOrgTaxProfile = createServerFn({ method: "POST" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "journal",
      "update",
      { routeKey: "payroll:org-profile", limit: 20, windowMs: 60_000 },
      async ({ orgId, db }) => {
        const input = orgProfileSchema.parse(rawData);
        await db
          .insert(orgTaxProfiles)
          .values({
            organizationId: orgId,
            tin: input.tin,
            registeredName: input.registeredName,
            branchCode: input.branchCode,
            rdoCode: input.rdoCode ?? null,
          })
          .onConflictDoUpdate({
            target: orgTaxProfiles.organizationId,
            set: {
              tin: input.tin,
              registeredName: input.registeredName,
              branchCode: input.branchCode,
              rdoCode: input.rdoCode ?? null,
              updatedAt: new Date(),
            },
          });
        return input;
      },
    );
  },
);

export const issuePayrollFilingArtifacts = createServerFn({ method: "POST" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    return withSessionOrgContext(async ({ orgId, db }) => {
      const { runId } = periodSchema.parse(rawData);
      const issued = await issuePayrollArtifacts(db, orgId, runId);
      return {
        runId: issued.runId,
        alphalist: issued.alphalist,
        certificates: issued.certificates.map((c) => ({
          employeePartyId: c.employeePartyId,
          employeeName: `${c.form.employee.lastName}, ${c.form.employee.firstName}`,
          pdfBase64: c.pdfBase64,
          blockingIssues: c.form.blockingIssues,
        })),
      };
    });
  },
);

export const issuePayroll1601C = createServerFn({ method: "POST" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "journal",
      "update",
      { routeKey: "payroll:1601c", limit: 20, windowMs: 60_000 },
      async ({ orgId, userId, db }) => {
        const { runId } = periodSchema.parse(rawData);
        return issueForm1601C(db, orgId, runId, userId);
      },
    );
  },
);
