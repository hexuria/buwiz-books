/**
 * The payroll journal — Stage 5b.
 *
 * The engine computed a run and posted nothing. This turns a computed run into
 * the balanced double entry the ledger and every subsequent form depend on:
 * 1601-C reconciles against the withholding-tax-payable movement, and the
 * remittance postings clear the same accounts this credits.
 *
 * THE ENTRY.
 *
 *   DR  Salaries and wages                gross compensation
 *   DR  SSS / PhilHealth / Pag-IBIG expense   EMPLOYER share only
 *       CR  Withholding tax payable (WTC)     tax withheld from employees
 *       CR  SSS payable                       employee + employer + EC
 *       CR  PhilHealth payable                employee + employer
 *       CR  Pag-IBIG payable                  employee + employer
 *       CR  Union dues payable                withheld, remitted to the union
 *       CR  Net pay payable                   what the employee actually receives
 *
 * THE PART THAT IS EASY TO GET WRONG. The employee's share is NOT an expense.
 * It is already inside gross compensation and is merely withheld from it — so
 * it reduces net pay and raises the payable, and never touches the expense
 * side. The employer's share IS an additional expense the employee never sees.
 * Booking the employee share as expense overstates payroll cost by roughly the
 * employee contribution every single period, and the entry still balances, so
 * nothing catches it. That is why net pay is DERIVED here rather than taken
 * from the register: deriving it forces the identity
 *
 *     net = gross − (employee statutory + union dues + tax withheld)
 *
 * to hold, and any register that disagrees is reported rather than posted.
 *
 * WHICH TAX FIGURE IS POSTED. The REPORTED one — what the employer actually
 * withheld and will actually remit — not the engine's computed figure. The
 * ledger records what happened. A variance between the two is a finding for
 * the verifier and a blocker on filing (D-N7: the product is the control, not
 * the computer of record); silently posting the computed figure would make the
 * ledger disagree with the payslips the employees were handed.
 */
import { and, eq } from "drizzle-orm";
import type { DbExecutor } from "@/db";
import { activityLogs } from "@/db/schema/activity-logs";
import { journalHeaders, journalLines } from "@/db/schema/journals";
import { payrollLines, payrollRuns } from "@/db/schema/payroll";
import { allocateJournalTransactionNumber } from "@/lib/sequence";
import { isDateInLockedPeriod } from "@/lib/period-close";
import { resolveFunctionalCurrency } from "@/lib/functional-currency";
import { requirePhAccounts } from "@/lib/tax/ph-account-resolver";
import { addAll, fromScaled, toScaled, ZERO } from "@/lib/tax/money";
import {
  summarizePayrollPosting,
  type PayrollPostingTotals,
} from "@/lib/tax/payroll-posting-summary";

export {
  summarizePayrollPosting,
  type PayrollPostingTotals,
} from "@/lib/tax/payroll-posting-summary";

export class PayrollRunNotComputedError extends Error {
  constructor(runId: string, status: string) {
    super(
      `Payroll run ${runId} is ${status}. Only a computed or acknowledged run can be posted — ` +
        `posting an uncomputed run would book a tax figure nothing has checked.`,
    );
    this.name = "PayrollRunNotComputedError";
  }
}

/**
 * A run carrying unacknowledged variances cannot be posted.
 *
 * D-N7: the product files the CLIENT's figure and records the variance, but it
 * refuses to ADVANCE while one stands unacknowledged. Posting to the ledger is
 * an advance — it makes the client's figure the accounting record — so the same
 * gate applies. `payroll_runs.status` is a one-way ladder for exactly this.
 */
export class UnacknowledgedVarianceError extends Error {
  constructor(
    runId: string,
    readonly varianceCount: number,
  ) {
    super(
      `Payroll run ${runId} has ${varianceCount} line(s) where the engine and the register ` +
        `disagree, and the run has not been acknowledged. Acknowledge the variances first — ` +
        `posting would make an unreviewed figure the accounting record.`,
    );
    this.name = "UnacknowledgedVarianceError";
  }
}

export class PayrollAlreadyPostedError extends Error {
  constructor(runId: string, journalHeaderId: string) {
    super(`Payroll run ${runId} is already posted as journal ${journalHeaderId}.`);
    this.name = "PayrollAlreadyPostedError";
  }
}

export interface PostPayrollResult {
  journalHeaderId: string;
  totals: PayrollPostingTotals;
}

/**
 * Compute the posting totals for a run without writing anything.
 *
 * Separated from the write so the figures can be previewed, and so the
 * arithmetic is testable without a database.
 */
/**
 * Post a computed payroll run.
 *
 * The caller must supply a transaction-scoped executor: the header, its lines
 * and the run's own status must land together, and the balance constraint from
 * 0041 is deferred to COMMIT.
 */
export async function postPayrollRun(
  db: DbExecutor,
  input: {
    organizationId: string;
    userId: string;
    runId: string;
  },
): Promise<PostPayrollResult> {
  const [run] = await db
    .select()
    .from(payrollRuns)
    .where(
      and(eq(payrollRuns.id, input.runId), eq(payrollRuns.organizationId, input.organizationId)),
    )
    .limit(1)
    .for("update");

  if (!run) throw new PayrollRunNotComputedError(input.runId, "missing");
  if (run.journalHeaderId) throw new PayrollAlreadyPostedError(input.runId, run.journalHeaderId);
  if (run.status !== "computed" && run.status !== "acknowledged") {
    throw new PayrollRunNotComputedError(input.runId, run.status);
  }

  const { locked, closedThrough } = await isDateInLockedPeriod(
    input.organizationId,
    run.periodEnd,
    db,
  );
  if (locked) {
    throw new Error(
      `Cannot post payroll run ${input.runId}: its pay date ${run.periodEnd} falls in a period ` +
        `locked through ${closedThrough}.`,
    );
  }

  const lines = await db
    .select()
    .from(payrollLines)
    .where(eq(payrollLines.payrollRunId, input.runId));
  if (lines.length === 0) {
    throw new Error(`Payroll run ${input.runId} has no lines — nothing to post.`);
  }

  // The D-N7 gate. A run whose engine figures disagree with the register must
  // be acknowledged before those figures become the accounting record.
  if (run.status !== "acknowledged") {
    const variances = lines.filter(
      (line) => line.varianceAmount !== null && toScaled(line.varianceAmount) !== ZERO,
    ).length;
    if (variances > 0) throw new UnacknowledgedVarianceError(input.runId, variances);
  }

  const { totals } = summarizePayrollPosting(lines);

  // Resolved together so an organization missing the preset is told about
  // every absent account at once rather than one error at a time.
  const account = await requirePhAccounts(db, input.organizationId, [
    "salaries",
    "employer_payroll_taxes",
    "ph_wtc_payable",
    "ph_sss_payable",
    "ph_philhealth_payable",
    "ph_pagibig_payable",
    "payroll_liabilities",
    "ph_net_pay_payable",
  ]);

  const transactionNumber = await allocateJournalTransactionNumber(input.organizationId, db);
  const functionalCurrency = await resolveFunctionalCurrency(db, input.organizationId);

  const totalDebits = fromScaled(
    addAll(toScaled(totals.grossCompensation), toScaled(totals.employerContributionExpense)),
  );

  const [header] = await db
    .insert(journalHeaders)
    .values({
      organizationId: input.organizationId,
      transactionNumber,
      transactionDate: run.periodEnd,
      transactionType: "journal",
      source: "manual",
      functionalCurrency,
      memo: `Payroll: ${run.periodStart} to ${run.periodEnd}`,
      totalAmount: totalDebits,
      status: "posted",
      postedAt: new Date(),
      sourceDocumentId: run.id,
      sourceDocumentType: "payroll_run",
      createdBy: input.userId,
      idempotencyKey: `payroll-run:${run.id}`,
    })
    .returning();
  if (!header) throw new Error("Payroll journal could not be posted.");

  // Zero-value legs are omitted rather than written as 0.00 rows: an
  // organization with no union dues should not carry an empty line every
  // period.
  const candidates: Array<{
    accountId: string;
    debit?: string;
    credit?: string;
    lineDescription: string;
  }> = [
    {
      accountId: account.salaries,
      debit: totals.grossCompensation,
      lineDescription: "Salaries and wages",
    },
    {
      accountId: account.employer_payroll_taxes,
      debit: totals.employerContributionExpense,
      lineDescription: "Employer share — SSS, PhilHealth, Pag-IBIG",
    },
    {
      accountId: account.ph_wtc_payable,
      credit: totals.taxWithheld,
      lineDescription: "Withholding tax on compensation",
    },
    {
      accountId: account.ph_sss_payable,
      credit: fromScaled(addAll(toScaled(totals.sssEmployee), toScaled(totals.sssEmployer))),
      lineDescription: "SSS payable — employee and employer share",
    },
    {
      accountId: account.ph_philhealth_payable,
      credit: fromScaled(
        addAll(toScaled(totals.philHealthEmployee), toScaled(totals.philHealthEmployer)),
      ),
      lineDescription: "PhilHealth payable — employee and employer share",
    },
    {
      accountId: account.ph_pagibig_payable,
      credit: fromScaled(
        addAll(toScaled(totals.pagIbigEmployee), toScaled(totals.pagIbigEmployer)),
      ),
      lineDescription: "Pag-IBIG payable — employee and employer share",
    },
    {
      accountId: account.payroll_liabilities,
      credit: totals.unionDues,
      lineDescription: "Union dues withheld",
    },
    {
      accountId: account.ph_net_pay_payable,
      credit: totals.netPay,
      lineDescription: "Net pay payable",
    },
  ];

  const values = candidates
    .filter((c) => toScaled(c.debit ?? c.credit ?? "0") !== ZERO)
    .map((c, index) => ({
      journalHeaderId: header.id,
      accountId: c.accountId,
      debit: c.debit ?? null,
      credit: c.credit ?? null,
      lineDescription: c.lineDescription,
      sortOrder: index,
    }));

  await db.insert(journalLines).values(values);

  await db
    .update(payrollRuns)
    // `locked` is the top of the ladder: a run whose figures are now in the
    // ledger must not be recomputed in place.
    .set({ journalHeaderId: header.id, status: "locked", updatedAt: new Date() })
    .where(eq(payrollRuns.id, run.id));

  await db.insert(activityLogs).values({
    organizationId: input.organizationId,
    entityType: "transaction",
    entityId: header.id,
    action: "created",
    actorId: input.userId,
    changes: {
      source: "payroll_run",
      payrollRunId: run.id,
      employeeCount: lines.length,
      ...totals,
    },
  });

  return { journalHeaderId: header.id, totals };
}
