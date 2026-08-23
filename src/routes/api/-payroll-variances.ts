/**
 * Payroll variance verifier — server functions.
 *
 * D-N7 is the rule this implements: the product files the CLIENT's figure,
 * records the variance and the client's acknowledgement immutably, and refuses
 * to advance while an unacknowledged blocking variance exists. **The product is
 * the control, not the computer of record.**
 *
 * So this deliberately does NOT offer a "use the engine's figure" action. The
 * register is what the employer actually withheld and what the employees were
 * actually paid; silently replacing it would make the ledger disagree with the
 * payslips already in people's hands. What the reviewer can do is ACKNOWLEDGE —
 * a recorded human decision that the client's figure stands — which is what
 * unlocks posting and filing.
 *
 * Two kinds of variance are reported separately because they have different
 * remedies. A TAX variance means the withheld amount disagrees with the engine.
 * A CONTRIBUTION variance means the SSS/PhilHealth/Pag-IBIG figures disagree
 * with the statutory schedule — which matters even when the tax arithmetic is
 * correct, because the tax may be right on a base that was itself wrong.
 */
import { createServerFn } from "@tanstack/react-start";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { parties } from "../../db/schema/parties";
import { payrollLines, payrollRuns } from "../../db/schema/payroll";
import { withMutationPermissionOrgContext, withSessionOrgContext } from "../../lib/server-context";
// D6 country gate: every PH tax/payroll WRITE refuses unless the module is active.
import { assertPhTaxWritable } from "../../lib/tax/module-state";
import { isNonZeroMoney } from "../../lib/tax/assemble-payroll-filing-workspace";

export interface PayrollVarianceLine {
  lineId: string;
  employeePartyId: string;
  employeeName: string | null;
  computedTaxWithheld: string | null;
  reportedTaxWithheld: string | null;
  /** computed − reported. Positive means the engine says MORE should have been withheld. */
  varianceAmount: string | null;
  contributionVarianceAmount: string | null;
  contributionCheckStatus: string | null;
  expectedSssEmployeeShare: string | null;
  sssEmployeeShare: string | null;
  expectedPhilHealthEmployeeShare: string | null;
  philHealthEmployeeShare: string | null;
  expectedPagIbigEmployeeShare: string | null;
  pagIbigEmployeeShare: string | null;
}

export interface PayrollVarianceReport {
  runId: string;
  status: string;
  periodStart: string;
  periodEnd: string;
  taxableYear: number;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  journalHeaderId: string | null;

  taxVariances: PayrollVarianceLine[];
  contributionVariances: PayrollVarianceLine[];
  /** Lines the contribution check could not run on, with the reason. */
  contributionChecksSkipped: number;

  totalLines: number;
  /** Whether posting and filing are currently blocked, and why. */
  blockers: string[];
}

const listSchema = z.object({ runId: z.string().uuid() });

export const getPayrollVarianceReport = createServerFn({ method: "GET" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    return withSessionOrgContext(async ({ orgId, db }) => {
      const { runId } = listSchema.parse(rawData);

      const [run] = await db
        .select()
        .from(payrollRuns)
        .where(and(eq(payrollRuns.id, runId), eq(payrollRuns.organizationId, orgId)))
        .limit(1);
      if (!run) throw new Error("Payroll run not found");

      const rows = await db
        .select({
          lineId: payrollLines.id,
          employeePartyId: payrollLines.employeePartyId,
          employeeName: parties.name,
          computedTaxWithheld: payrollLines.computedTaxWithheld,
          reportedTaxWithheld: payrollLines.reportedTaxWithheld,
          varianceAmount: payrollLines.varianceAmount,
          contributionVarianceAmount: payrollLines.contributionVarianceAmount,
          contributionCheckStatus: payrollLines.contributionCheckStatus,
          expectedSssEmployeeShare: payrollLines.expectedSssEmployeeShare,
          sssEmployeeShare: payrollLines.sssEmployeeShare,
          expectedPhilHealthEmployeeShare: payrollLines.expectedPhilHealthEmployeeShare,
          philHealthEmployeeShare: payrollLines.philHealthEmployeeShare,
          expectedPagIbigEmployeeShare: payrollLines.expectedPagIbigEmployeeShare,
          pagIbigEmployeeShare: payrollLines.pagIbigEmployeeShare,
        })
        .from(payrollLines)
        .leftJoin(parties, eq(parties.id, payrollLines.employeePartyId))
        .where(eq(payrollLines.payrollRunId, runId));

      // A non-zero TEST, not a comparison of two amounts. Use the tax money
      // type so a sub-centavo string cannot be coerced through Number().
      const nonZero = (value: string | null) => isNonZeroMoney(value);

      const taxVariances = rows.filter((r) => nonZero(r.varianceAmount));
      const contributionVariances = rows.filter((r) => nonZero(r.contributionVarianceAmount));
      const skipped = rows.filter(
        (r) => r.contributionCheckStatus !== null && r.contributionCheckStatus !== "checked",
      ).length;

      const blockers: string[] = [];
      if (taxVariances.length > 0 && !run.acknowledgedAt) {
        blockers.push(
          `${taxVariances.length} tax variance(s) are unacknowledged. Posting would make an ` +
            `unreviewed figure the accounting record.`,
        );
      }
      if (contributionVariances.length > 0 && !run.acknowledgedAt) {
        blockers.push(
          `${contributionVariances.length} contribution variance(s) are unacknowledged. The tax ` +
            `may be arithmetically correct on a base that is itself wrong.`,
        );
      }
      if (run.journalHeaderId) {
        blockers.push("This run is already posted; its figures can no longer be changed.");
      }

      return {
        runId: run.id,
        status: run.status,
        periodStart: run.periodStart,
        periodEnd: run.periodEnd,
        taxableYear: run.taxableYear,
        acknowledgedAt: run.acknowledgedAt ? run.acknowledgedAt.toISOString() : null,
        acknowledgedBy: run.acknowledgedBy,
        journalHeaderId: run.journalHeaderId,
        taxVariances,
        contributionVariances,
        contributionChecksSkipped: skipped,
        totalLines: rows.length,
        blockers,
      } satisfies PayrollVarianceReport;
    });
  },
);

const acknowledgeSchema = z.object({
  runId: z.string().uuid(),
  /** Why the client's figures stand. Recorded immutably; required. */
  note: z.string().min(1),
});

/**
 * Record the client's acknowledgement that their figures stand.
 *
 * This does NOT change a single reported figure — that is the point. It records
 * a human decision and advances the run to `acknowledged`, which is what
 * unlocks posting.
 */
export const acknowledgePayrollVariances = createServerFn({ method: "POST" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "journal",
      "update",
      { routeKey: "payroll:acknowledge", limit: 30, windowMs: 60_000 },
      async ({ orgId, userId, db }) => {
        await assertPhTaxWritable(db, orgId);
        const { runId, note } = acknowledgeSchema.parse(rawData);

        const [run] = await db
          .select()
          .from(payrollRuns)
          .where(and(eq(payrollRuns.id, runId), eq(payrollRuns.organizationId, orgId)))
          .limit(1)
          .for("update");
        if (!run) throw new Error("Payroll run not found");

        if (run.journalHeaderId) {
          throw new Error(
            "This run is already posted. Acknowledging now would record a decision after the " +
              "fact — amend the journal instead.",
          );
        }
        if (run.status !== "computed" && run.status !== "acknowledged") {
          throw new Error(`A ${run.status} run has nothing to acknowledge — compute it first.`);
        }

        await db
          .update(payrollRuns)
          .set({
            status: "acknowledged",
            acknowledgedAt: new Date(),
            acknowledgedBy: userId,
            acknowledgementNote: note,
            updatedAt: new Date(),
          })
          .where(eq(payrollRuns.id, runId));

        return { acknowledged: true };
      },
    );
  },
);
