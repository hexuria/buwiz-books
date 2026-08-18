/** Build a 1601-C working return from a computed payroll run. */
import { and, eq } from "drizzle-orm";
import type { DbExecutor } from "@/db";
import { payrollLines, payrollRuns } from "@/db/schema/payroll";
import { orgTaxProfiles } from "@/db/schema/tax-reference";
import { taxComputedReturns } from "@/db/schema/tax-stage-remainder";
import { fromScaled, toScaled } from "./money";
import { buildForm1601C, compensationFromPayrollLine, type FilingChannel } from "./form-1601c";
import { controlAccountMovementForRun } from "./assemble-payroll-filing-workspace";
import { asJsonPayload } from "./json-payload";

export async function issueForm1601C(
  db: DbExecutor,
  organizationId: string,
  runId: string,
  createdBy?: string,
) {
  const [run] = await db
    .select()
    .from(payrollRuns)
    .where(and(eq(payrollRuns.id, runId), eq(payrollRuns.organizationId, organizationId)))
    .limit(1);
  if (!run) throw new Error("Payroll run not found");

  const lines = await db.select().from(payrollLines).where(eq(payrollLines.payrollRunId, runId));
  const [profile] = await db
    .select({
      efpsEnrolled: orgTaxProfiles.efpsEnrolled,
      efpsIndustryGroup: orgTaxProfiles.efpsIndustryGroup,
    })
    .from(orgTaxProfiles)
    .where(eq(orgTaxProfiles.organizationId, organizationId))
    .limit(1);

  const month = Number(run.periodEnd.slice(5, 7));
  const year = Number(run.periodEnd.slice(0, 4));
  const filingChannel: FilingChannel = profile?.efpsEnrolled ? "efps" : "ebirforms";

  let controlAccountMovement: string | null = null;
  if (run.journalHeaderId) {
    const movement = await controlAccountMovementForRun(db, organizationId, run);
    controlAccountMovement = fromScaled(
      (toScaled(movement.credits) - toScaled(movement.debits)) as ReturnType<typeof toScaled>,
    );
  }

  const form = buildForm1601C({
    month,
    year,
    filingChannel,
    efpsGroup: profile?.efpsIndustryGroup ?? undefined,
    lines: lines.map(compensationFromPayrollLine),
    controlAccountMovement,
  });

  const [row] = await db
    .insert(taxComputedReturns)
    .values({
      organizationId,
      formCode: "1601C",
      periodStart: form.periodStart,
      periodEnd: form.periodEnd,
      payload: asJsonPayload({ ...form, payrollRunId: runId }),
      blockingIssueCount: form.blockingIssues.length,
      createdBy: createdBy ?? null,
    })
    .onConflictDoUpdate({
      target: [
        taxComputedReturns.organizationId,
        taxComputedReturns.formCode,
        taxComputedReturns.periodStart,
        taxComputedReturns.periodEnd,
      ],
      set: {
        payload: asJsonPayload({ ...form, payrollRunId: runId }),
        blockingIssueCount: form.blockingIssues.length,
        updatedAt: new Date(),
      },
    })
    .returning({ id: taxComputedReturns.id });
  if (!row) throw new Error("Could not save the 1601-C working return");

  return { ...form, id: row.id, payrollRunId: runId };
}
