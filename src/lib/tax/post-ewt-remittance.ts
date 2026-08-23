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
import { reconcileQuarter, remittanceObligationsFor } from "@/lib/tax/ewt";

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

  // The quarterly 1601-EQ covers the WHOLE quarter — but months 1 and 2 were
  // already debited by their own 0619-E remittance journals. Posting the full
  // quarter again drove EWT payable negative by two months and over-credited
  // cash (₱10k+₱10k on 0619-E, then ₱30k on the EQ). reconcileQuarter exists
  // for exactly this netting; what counts as "remitted" is what was ACTUALLY
  // posted, read back by the prior journals' idempotency keys, so a skipped
  // monthly remittance is correctly still owed on the quarterly return.
  let amountToPost = summary.taxWithheld;
  let nettingNote = "";
  if (summary.formCode === "1601EQ") {
    const quarterStartMonth = input.month - 2;
    const priorAmounts: string[] = [];
    for (const priorMonth of [quarterStartMonth, quarterStartMonth + 1]) {
      const prior = remittanceObligationsFor(priorMonth, input.year)[0];
      if (!prior) {
        priorAmounts.push("0");
        continue;
      }
      const [posted] = await db
        .select({ totalAmount: journalHeaders.totalAmount })
        .from(journalHeaders)
        .where(
          eq(
            journalHeaders.idempotencyKey,
            `ewt-remittance:${input.organizationId}:${prior.formCode}:${prior.periodStart}:${prior.periodEnd}`,
          ),
        )
        .limit(1);
      priorAmounts.push(posted?.totalAmount ?? "0");
    }
    const reconciliation = reconcileQuarter({
      quarterWithheld: summary.taxWithheld,
      remittedMonth1: priorAmounts[0],
      remittedMonth2: priorAmounts[1],
    });
    if (!reconciliation.reconciled) {
      throw new Error(reconciliation.issues.join(" "));
    }
    amountToPost = reconciliation.stillDue;
    nettingNote = ` (quarter ${summary.taxWithheld} less ${priorAmounts[0]} and ${priorAmounts[1]} remitted on 0619-E)`;
  }

  if (!summary.shouldPost || Number(amountToPost) === 0) {
    throw new EwtNothingToRemitError(summary.periodStart, summary.periodEnd);
  }

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
      memo: `${summary.formCode} remittance ${summary.periodStart} to ${summary.periodEnd}${nettingNote}`,
      totalAmount: amountToPost,
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
      debit: amountToPost,
      credit: null,
      lineDescription: `${summary.formCode} remittance`,
      sortOrder: 0,
    },
    {
      journalHeaderId: header.id,
      accountId: cashAccountId,
      debit: null,
      credit: amountToPost,
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
    taxWithheld: amountToPost,
    dueDate: summary.dueDate,
  };
}
