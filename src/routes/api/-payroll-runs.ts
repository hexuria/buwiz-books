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
import { DATASET_V1 } from "../../lib/tax/reference-catalog";
import { isAnnualizationPeriod, periodIndexFromDates } from "../../lib/tax/payroll-period";
import { withMutationPermissionOrgContext, withSessionOrgContext } from "../../lib/server-context";
import {
  assemblePayrollFilingWorkspace,
  assertWorkspaceAllowsPost,
} from "../../lib/tax/assemble-payroll-filing-workspace";
import { persistImportedRegister } from "../../lib/tax/persist-register-import";
import { computePayrollRun } from "../../lib/tax/payroll-run-service";
import { postPayrollRun } from "../../lib/tax/payroll-journal";
import { BUWIZ_TEMPLATE, IMPORTABLE_FIELDS } from "../../lib/tax/register-import";

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
        return computePayrollRun(db as never, orgId, runId);
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
        let partyId = input.partyId;
        if (!partyId) {
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
