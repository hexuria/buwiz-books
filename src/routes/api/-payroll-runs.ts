/**
 * Payroll run mutations the filing screen can actually reach.
 *
 * importRegister / computePayrollRun / postPayrollRun existed as engines.
 * This is the route glue: persist a pasted register, compute the verifier,
 * and post the journal. Each mutation re-derives the workspace and refuses
 * what is still blocked.
 */
import { createServerFn } from "@tanstack/react-start";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { payrollRuns } from "../../db/schema/payroll";
import { withMutationPermissionOrgContext } from "../../lib/server-context";
import {
  assemblePayrollFilingWorkspace,
  assertWorkspaceAllowsPost,
} from "../../lib/tax/assemble-payroll-filing-workspace";
import { persistImportedRegister } from "../../lib/tax/persist-register-import";
import { computePayrollRun } from "../../lib/tax/payroll-run-service";
import { postPayrollRun } from "../../lib/tax/payroll-journal";
import {
  BUWIZ_TEMPLATE,
  IMPORTABLE_FIELDS,
  type ImportableField,
} from "../../lib/tax/register-import";

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
