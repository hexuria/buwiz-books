/**
 * Filing server functions — the route-level glue.
 *
 * The engines were all reachable individually and connected to nothing. This
 * drives one period from a computed payroll run through to a filed return,
 * which is the path a client actually walks in January.
 *
 * THE SEQUENCE IT ENFORCES, and why each step is where it is:
 *
 *   compute → review variances → post to the ledger → reconcile → pre-flight
 *   → snapshot → file
 *
 * Nothing here re-implements a check. `assemblePayrollFilingWorkspace` gathers
 * what the engines say, and these functions refuse anything the workspace
 * reports as blocked. That means a caller cannot skip a step by calling a
 * later endpoint directly — the check is on the server, not in the screen's
 * sequencing.
 */
import { createServerFn } from "@tanstack/react-start";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { payrollRuns } from "../../db/schema/payroll";
import { withMutationPermissionOrgContext, withSessionOrgContext } from "../../lib/server-context";
// D6 country gate: every PH tax/payroll WRITE refuses unless the module is active.
import { assertPhTaxWritable } from "../../lib/tax/module-state";
import {
  assemblePayrollFilingWorkspace,
  assertWorkspaceAllowsFile,
  assertWorkspaceAllowsSnapshot,
  controlAccountMovementForRun,
} from "../../lib/tax/assemble-payroll-filing-workspace";
import { takeSnapshot, type SnapshotLine } from "../../lib/tax/filing-snapshot";
import type { FilingWorkspace } from "../../lib/tax/filing-workspace";

const periodSchema = z.object({ runId: z.string().uuid() });

async function loadRun(
  db: Parameters<typeof assemblePayrollFilingWorkspace>[0],
  orgId: string,
  runId: string,
  lock = false,
) {
  const query = db
    .select()
    .from(payrollRuns)
    .where(and(eq(payrollRuns.id, runId), eq(payrollRuns.organizationId, orgId)))
    .limit(1);
  const [run] = lock ? await query.for("update") : await query;
  if (!run) throw new Error("Payroll run not found");
  return run;
}

/**
 * Everything blocking a payroll period from being filed.
 *
 * Assembled from the live state of the run, its lines, party tax profiles,
 * and the ledger — so the answer reflects what is actually true rather than
 * a cached verdict.
 */
export const getFilingWorkspace = createServerFn({ method: "GET" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    return withSessionOrgContext(async ({ orgId, db }) => {
      const { runId } = periodSchema.parse(rawData);
      const run = await loadRun(db, orgId, runId);
      const assembled = await assemblePayrollFilingWorkspace(db, orgId, run);
      return assembled.workspace satisfies FilingWorkspace;
    });
  },
);

const snapshotSchema = z.object({
  runId: z.string().uuid(),
  /**
   * Optional client hint. The run's own reference dataset version wins; an
   * empty run version is a defect, not a prompt to invent one.
   */
  referenceDatasetVersion: z.string().min(1).optional(),
});

/**
 * Take the as-filed snapshot.
 *
 * Refuses when anything BEFORE the snapshot stage is still blocking. A
 * snapshot of figures that are not yet final records the wrong thing
 * permanently, and the whole point of it is that it is not revised.
 */
export const takeFilingSnapshot = createServerFn({ method: "POST" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "journal",
      "update",
      { routeKey: "filing:snapshot", limit: 20, windowMs: 60_000 },
      async ({ orgId, db }) => {
        await assertPhTaxWritable(db, orgId);
        const { runId } = snapshotSchema.parse(rawData);
        const run = await loadRun(db, orgId, runId, true);
        const assembled = await assemblePayrollFilingWorkspace(db, orgId, run);
        assertWorkspaceAllowsSnapshot(assembled.workspace);

        const referenceDatasetVersion = run.referenceDatasetVersion;
        if (!referenceDatasetVersion) {
          throw new Error(
            "This run has no reference dataset version. A snapshot that cannot name its inputs " +
              "cannot explain its outputs.",
          );
        }

        // Every figure the 1604-C/alphalist REPORTS per employee goes under
        // the checksum — six of ~27 used to be covered, so a post-snapshot
        // edit to (say) commission or de minimis re-produced the same
        // "as-filed" checksum. Variance/expected-* diagnostics stay out:
        // they are internal reconciliation aids, not filed figures.
        const snapshotLines: SnapshotLine[] = assembled.lines.map((line) => ({
          key: line.employeePartyId,
          values: {
            basicSalary: line.basicSalary,
            representationAllowance: line.representationAllowance,
            transportationAllowance: line.transportationAllowance,
            costOfLivingAllowance: line.costOfLivingAllowance,
            fixedHousingAllowance: line.fixedHousingAllowance,
            otherTaxableRegular: line.otherTaxableRegular,
            commission: line.commission,
            profitSharing: line.profitSharing,
            directorsFees: line.directorsFees,
            overtimePay: line.overtimePay,
            hazardPay: line.hazardPay,
            otherTaxableSupplementary: line.otherTaxableSupplementary,
            basicSalaryMwe: line.basicSalaryMwe,
            holidayPayMwe: line.holidayPayMwe,
            overtimePayMwe: line.overtimePayMwe,
            nightShiftDifferentialMwe: line.nightShiftDifferentialMwe,
            hazardPayMwe: line.hazardPayMwe,
            thirteenthMonthAndOtherBenefits: line.thirteenthMonthAndOtherBenefits,
            deMinimisBenefits: line.deMinimisBenefits,
            nonTaxableRetirementSeparation: line.nonTaxableRetirementSeparation,
            otherExempt: line.otherExempt,
            sss: line.sssEmployeeShare,
            philhealth: line.philHealthEmployeeShare,
            pagibig: line.pagIbigEmployeeShare,
            unionDues: line.unionDues,
            withheld: line.reportedTaxWithheld ?? line.computedTaxWithheld,
            computed: line.computedTaxWithheld,
          },
        }));

        const movement = await controlAccountMovementForRun(db, orgId, run);
        const snapshot = takeSnapshot({
          formCode: "1604C",
          periodStart: run.periodStart,
          periodEnd: run.periodEnd,
          amendmentSequence: 0,
          referenceDatasetVersion,
          totals: {
            employeeCount: assembled.lines.length,
            controlAccountCredits: movement.credits,
            controlAccountDebits: movement.debits,
          },
          lines: snapshotLines,
        });

        await db
          .update(payrollRuns)
          .set({
            snapshotChecksum: snapshot.checksum,
            snapshotTakenAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(payrollRuns.id, runId));

        return { checksum: snapshot.checksum, employeeCount: assembled.lines.length };
      },
    );
  },
);

const fileSchema = z.object({
  runId: z.string().uuid(),
  filingReference: z.string().min(1),
});

/**
 * Record the period as filed.
 *
 * Re-checks the workspace on the server rather than trusting that the screen
 * only offered the button when it was safe. A client calling this endpoint
 * directly must hit the same wall.
 */
export const markPeriodFiled = createServerFn({ method: "POST" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "journal",
      "update",
      { routeKey: "filing:file", limit: 20, windowMs: 60_000 },
      async ({ orgId, db }) => {
        await assertPhTaxWritable(db, orgId);
        const { runId, filingReference } = fileSchema.parse(rawData);
        const run = await loadRun(db, orgId, runId, true);
        if (run.filingReference) {
          throw new Error(`This period was already filed under reference ${run.filingReference}.`);
        }

        const assembled = await assemblePayrollFilingWorkspace(db, orgId, run);
        assertWorkspaceAllowsFile(assembled.workspace);

        await db
          .update(payrollRuns)
          .set({ filingReference, filedAt: new Date(), updatedAt: new Date() })
          .where(eq(payrollRuns.id, runId));

        return { filed: true, filingReference };
      },
    );
  },
);
