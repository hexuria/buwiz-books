/** Post an 0619-E / 1601-EQ remittance that clears EWT payable. */
import { eq } from "drizzle-orm";
import type { DbExecutor } from "@/db";
import { activityLogs } from "@/db/schema/activity-logs";
import { journalHeaders, journalLines } from "@/db/schema/journals";
import { taxComputedReturns, taxWithholdingPayments } from "@/db/schema/tax-stage-remainder";
import { allocateJournalTransactionNumber } from "@/lib/sequence";
import { isDateInLockedPeriod } from "@/lib/period-close";
import { resolveFunctionalCurrency } from "@/lib/functional-currency";
import { requireMappedAccountId } from "@/lib/coa/resolve-mapped-account";
import { requirePhAccount } from "@/lib/tax/ph-account-resolver";
import { asJsonPayload } from "@/lib/tax/json-payload";
import { summarizeEwtRemittance } from "@/lib/tax/ewt-remittance";

export class EwtNothingToRemitError extends Error {
  constructor(periodStart: string, periodEnd: string) {
    super(`No withheld tax to remit for ${periodStart} to ${periodEnd}.`);
    this.name = "EwtNothingToRemitError";
  }
}

export async function postEwtRemittance(
  db: DbExecutor,
  input: { organizationId: string; userId: string; month: number; year: number },
): Promise<{ journalHeaderId: string; formCode: string; taxWithheld: string; dueDate: string }> {
  const payments = await db
    .select({
      taxWithheld: taxWithholdingPayments.taxWithheld,
      periodStart: taxWithholdingPayments.periodStart,
      periodEnd: taxWithholdingPayments.periodEnd,
    })
    .from(taxWithholdingPayments)
    .where(eq(taxWithholdingPayments.organizationId, input.organizationId));

  const window = summarizeEwtRemittance({ month: input.month, year: input.year, amounts: [] });
  const summary = summarizeEwtRemittance({
    month: input.month,
    year: input.year,
    amounts: payments
      .filter(
        (payment) =>
          payment.periodStart >= window.periodStart && payment.periodEnd <= window.periodEnd,
      )
      .map((payment) => payment.taxWithheld),
  });

  if (!summary.shouldPost) throw new EwtNothingToRemitError(summary.periodStart, summary.periodEnd);

  const { locked, closedThrough } = await isDateInLockedPeriod(
    input.organizationId,
    summary.dueDate,
    db,
  );
  if (locked) {
    throw new Error(
      `Cannot remit ${summary.formCode}: ${summary.dueDate} falls in a period locked through ${closedThrough}.`,
    );
  }

  const ewtAccountId = await requirePhAccount(db, input.organizationId, "ph_ewt_payable");
  const cashAccountId = await requireMappedAccountId(db, input.organizationId, "bank", "checking");
  const transactionNumber = await allocateJournalTransactionNumber(input.organizationId, db);
  const functionalCurrency = await resolveFunctionalCurrency(db, input.organizationId);

  const [header] = await db
    .insert(journalHeaders)
    .values({
      organizationId: input.organizationId,
      transactionNumber,
      transactionDate: summary.dueDate,
      transactionType: "journal",
      source: "manual",
      functionalCurrency,
      memo: `${summary.formCode} remittance ${summary.periodStart} to ${summary.periodEnd}`,
      totalAmount: summary.taxWithheld,
      status: "posted",
      sourceDocumentType: "tax_remittance",
      createdBy: input.userId,
      idempotencyKey: `ewt-remittance:${input.organizationId}:${summary.formCode}:${summary.periodStart}:${summary.periodEnd}`,
    })
    .returning();
  if (!header) throw new Error("EWT remittance journal could not be posted.");

  await db.insert(journalLines).values([
    {
      journalHeaderId: header.id,
      accountId: ewtAccountId,
      debit: summary.taxWithheld,
      credit: null,
      lineDescription: `${summary.formCode} remittance`,
      sortOrder: 0,
    },
    {
      journalHeaderId: header.id,
      accountId: cashAccountId,
      debit: null,
      credit: summary.taxWithheld,
      lineDescription: "Cash remitted to BIR",
      sortOrder: 1,
    },
  ]);

  await db
    .insert(taxComputedReturns)
    .values({
      organizationId: input.organizationId,
      formCode: summary.formCode,
      periodStart: summary.periodStart,
      periodEnd: summary.periodEnd,
      payload: asJsonPayload({ ...summary, journalHeaderId: header.id }),
      blockingIssueCount: 0,
      createdBy: input.userId,
    })
    .onConflictDoUpdate({
      target: [
        taxComputedReturns.organizationId,
        taxComputedReturns.formCode,
        taxComputedReturns.periodStart,
        taxComputedReturns.periodEnd,
      ],
      set: {
        payload: asJsonPayload({ ...summary, journalHeaderId: header.id }),
        updatedAt: new Date(),
      },
    });

  await db.insert(activityLogs).values({
    organizationId: input.organizationId,
    entityType: "transaction",
    entityId: header.id,
    action: "created",
    actorId: input.userId,
    changes: { source: "ewt_remittance", ...summary },
  });

  return {
    journalHeaderId: header.id,
    formCode: summary.formCode,
    taxWithheld: summary.taxWithheld,
    dueDate: summary.dueDate,
  };
}
