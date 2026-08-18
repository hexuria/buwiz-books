/**
 * Live payroll filing workspace.
 *
 * `buildFilingWorkspace` is the assembler: it orders already-computed
 * blockers and does not query. This module is the one place that gathers
 * those inputs from a payroll run so GET, snapshot, and file cannot invent
 * three different opinions of the same period.
 *
 * Opening balances are D7 — prior-employer 2316 / YTD intake for mid-year
 * hires — not "this run has a reference dataset version". A computed run
 * with no prior-employer 2316 can still be blocked here.
 */
import { and, eq, gte, lte, sql } from "drizzle-orm";
import type { DbExecutor } from "@/db";
import { journalHeaders, journalLines } from "@/db/schema/journals";
import { partyTaxProfiles } from "@/db/schema/party-tax";
import {
  payrollEmployeeYearState,
  payrollLines,
  payrollRuns,
  previousEmployer2316,
} from "@/db/schema/payroll";
import { preflightAlphalist, type PreflightFinding } from "@/lib/tax/alphalist-preflight";
import {
  buildFilingWorkspace,
  type FilingStage,
  type FilingWorkspace,
} from "@/lib/tax/filing-workspace";
import type { FilingPeriod, FilingPeriodState } from "@/lib/tax/filing-period";
import { ZERO, toScaled } from "@/lib/tax/money";
import { requirePhAccount } from "@/lib/tax/ph-account-resolver";

export type PayrollRunRow = typeof payrollRuns.$inferSelect;
export type PayrollLineRow = typeof payrollLines.$inferSelect;

export class FilingWorkspaceBlockedError extends Error {
  constructor(
    readonly stage: FilingStage,
    readonly blockers: FilingWorkspace["blockers"],
  ) {
    const first = blockers[0];
    super(first?.message ?? `Filing is blocked at ${stage}`);
    this.name = "FilingWorkspaceBlockedError";
  }
}

export function isNonZeroMoney(value: string | null | undefined): boolean {
  if (value == null || value === "") return false;
  return toScaled(value) !== ZERO;
}

/**
 * The filing-period ladder, from the run's own timestamps.
 *
 * `journalHeaderId` is a posting fact, not a period state. A posted but
 * uncomputed run, or a computed run that has already been filed, must not
 * collapse to "computed" just because a journal exists.
 */
export function filingPeriodStateFromRun(run: {
  filedAt: Date | null;
  filingReference: string | null;
  snapshotChecksum: string | null;
  computedAt: Date | null;
  status: string;
}): FilingPeriodState {
  if (run.filedAt || run.filingReference) return "filed";
  if (
    run.snapshotChecksum ||
    run.computedAt ||
    run.status === "computed" ||
    run.status === "acknowledged" ||
    run.status === "locked"
  ) {
    return "computed";
  }
  return "open";
}

export function toFilingPeriod(run: PayrollRunRow): FilingPeriod {
  return {
    formCode: "1604C",
    periodStart: run.periodStart,
    periodEnd: run.periodEnd,
    state: filingPeriodStateFromRun(run),
    filingReference: run.filingReference ?? null,
    snapshotChecksum: run.snapshotChecksum ?? null,
    amendmentSequence: 0,
  };
}

export async function openingBalancesCompleteForRun(
  db: DbExecutor,
  organizationId: string,
  run: Pick<PayrollRunRow, "taxableYear" | "periodIndex">,
  lines: ReadonlyArray<Pick<PayrollLineRow, "employeePartyId">>,
): Promise<boolean> {
  if (run.periodIndex <= 1) return true;

  for (const line of lines) {
    const [prior] = await db
      .select({ id: previousEmployer2316.id })
      .from(previousEmployer2316)
      .where(
        and(
          eq(previousEmployer2316.organizationId, organizationId),
          eq(previousEmployer2316.employeePartyId, line.employeePartyId),
          eq(previousEmployer2316.taxableYear, run.taxableYear),
        ),
      )
      .limit(1);
    if (prior) continue;

    const [state] = await db
      .select({
        periodsElapsed: payrollEmployeeYearState.periodsElapsed,
        ytdTaxableRegular: payrollEmployeeYearState.ytdTaxableRegular,
        isPreMigration: payrollEmployeeYearState.isPreMigration,
        openingBalanceAsOf: payrollEmployeeYearState.openingBalanceAsOf,
      })
      .from(payrollEmployeeYearState)
      .where(
        and(
          eq(payrollEmployeeYearState.organizationId, organizationId),
          eq(payrollEmployeeYearState.employeePartyId, line.employeePartyId),
          eq(payrollEmployeeYearState.taxableYear, run.taxableYear),
        ),
      )
      .limit(1);

    if (state?.isPreMigration || state?.openingBalanceAsOf) continue;
    if (state != null && state.periodsElapsed === 0 && !isNonZeroMoney(state.ytdTaxableRegular)) {
      return false;
    }
  }
  return true;
}

export async function preflightFindingsForLines(
  db: DbExecutor,
  organizationId: string,
  lines: ReadonlyArray<Pick<PayrollLineRow, "employeePartyId" | "basicSalary">>,
): Promise<PreflightFinding[]> {
  const rows = [];
  for (const [index, line] of lines.entries()) {
    const [profile] = await db
      .select({
        tin: partyTaxProfiles.tin,
        branchCode: partyTaxProfiles.branchCode,
        lastName: partyTaxProfiles.lastName,
        firstName: partyTaxProfiles.firstName,
        registeredName: partyTaxProfiles.registeredName,
      })
      .from(partyTaxProfiles)
      .where(
        and(
          eq(partyTaxProfiles.organizationId, organizationId),
          eq(partyTaxProfiles.partyId, line.employeePartyId),
        ),
      )
      .limit(1);

    rows.push({
      tin: profile?.tin ?? null,
      branchCode: profile?.branchCode ?? null,
      lastName: profile?.lastName ?? null,
      firstName: profile?.firstName ?? null,
      registeredName: profile?.registeredName ?? `employee ${index + 1}`,
      amount: line.basicSalary,
    });
  }
  return preflightAlphalist(rows);
}

export function unacknowledgedVarianceCount(
  run: Pick<PayrollRunRow, "acknowledgedAt">,
  lines: ReadonlyArray<Pick<PayrollLineRow, "varianceAmount" | "contributionVarianceAmount">>,
): number {
  if (run.acknowledgedAt) return 0;
  return lines.filter(
    (line) =>
      isNonZeroMoney(line.varianceAmount) || isNonZeroMoney(line.contributionVarianceAmount),
  ).length;
}

export interface AssembledPayrollFiling {
  run: PayrollRunRow;
  lines: PayrollLineRow[];
  workspace: FilingWorkspace;
  preflightFindings: PreflightFinding[];
}

/**
 * Gather every engine input for one payroll run and assemble the workspace.
 *
 * Callers that mutate must refuse when this workspace still blocks the
 * requested stage. Do not re-derive a subset of these checks at the endpoint.
 */
export async function assemblePayrollFilingWorkspace(
  db: DbExecutor,
  organizationId: string,
  run: PayrollRunRow,
): Promise<AssembledPayrollFiling> {
  const lines = await db
    .select()
    .from(payrollLines)
    .where(
      and(eq(payrollLines.payrollRunId, run.id), eq(payrollLines.organizationId, organizationId)),
    );

  const [openingBalancesComplete, preflightFindings] = await Promise.all([
    openingBalancesCompleteForRun(db, organizationId, run, lines),
    preflightFindingsForLines(db, organizationId, lines),
  ]);

  const unacknowledgedVariances = unacknowledgedVarianceCount(run, lines);
  const fatalPreflightFindings = preflightFindings.filter((f) => f.severity === "fatal").length;

  const workspace = buildFilingWorkspace({
    period: toFilingPeriod(run),
    targetState: "filed",
    context: {
      unacknowledgedVariances,
      fatalPreflightFindings,
      hasSnapshot: run.snapshotChecksum !== null,
      filingReference: run.filingReference ?? null,
      openingBalancesComplete,
    },
    preflightFindings,
    posted: run.journalHeaderId !== null,
  });

  return { run, lines, workspace, preflightFindings };
}

/** Stages that must be clear before a snapshot can be taken. */
const SNAPSHOT_PREREQUISITES: readonly FilingStage[] = [
  "opening_balances",
  "computation",
  "variance_review",
  "posting",
  "reconciliation",
  "preflight",
];

export function assertWorkspaceAllowsSnapshot(workspace: FilingWorkspace): void {
  const blockers = workspace.blockers.filter((b) => SNAPSHOT_PREREQUISITES.includes(b.stage));
  if (blockers.length > 0) {
    throw new FilingWorkspaceBlockedError(blockers[0].stage, blockers);
  }
}

export function assertWorkspaceAllowsFile(workspace: FilingWorkspace): void {
  const blockers = workspace.blockers.filter((b) => b.stage !== "submission");
  if (blockers.length > 0) {
    throw new FilingWorkspaceBlockedError(blockers[0].stage, blockers);
  }
}

export async function controlAccountMovementForRun(
  db: DbExecutor,
  organizationId: string,
  run: Pick<PayrollRunRow, "journalHeaderId" | "periodStart" | "periodEnd">,
): Promise<{ credits: string; debits: string }> {
  const wtcAccount = await requirePhAccount(db, organizationId, "ph_wtc_payable");

  const scopedToRun = run.journalHeaderId
    ? eq(journalHeaders.id, run.journalHeaderId)
    : and(
        gte(journalHeaders.transactionDate, run.periodStart),
        lte(journalHeaders.transactionDate, run.periodEnd),
      );

  const [movement] = await db
    .select({
      credits: sql<string>`COALESCE(SUM(${journalLines.credit}), 0)`,
      debits: sql<string>`COALESCE(SUM(${journalLines.debit}), 0)`,
    })
    .from(journalLines)
    .innerJoin(journalHeaders, eq(journalHeaders.id, journalLines.journalHeaderId))
    .where(
      and(
        eq(journalLines.accountId, wtcAccount),
        eq(journalHeaders.organizationId, organizationId),
        eq(journalHeaders.status, "posted"),
        scopedToRun,
      ),
    );

  return {
    credits: movement?.credits ?? "0",
    debits: movement?.debits ?? "0",
  };
}
