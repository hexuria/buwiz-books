/**
 * Post the CWT receivable for a captured 2307.
 *
 * The certificate is already the paper fact. This writes the ledger fact and
 * pins the journal on the certificate so a retry cannot claim the credit twice.
 */
import { and, eq } from "drizzle-orm";
import type { DbExecutor } from "@/db";
import { activityLogs } from "@/db/schema/activity-logs";
import { journalHeaders, journalLines } from "@/db/schema/journals";
import { taxCertificates } from "@/db/schema/tax-certificates";
import { allocateJournalTransactionNumber } from "@/lib/sequence";
import { isDateInLockedPeriod } from "@/lib/period-close";
import { resolveFunctionalCurrency } from "@/lib/functional-currency";
import { requireMappedAccountId } from "@/lib/coa/resolve-mapped-account";
import { requirePhAccount } from "@/lib/tax/ph-account-resolver";
import {
  CwtAlreadyPostedError,
  CwtNothingToPostError,
  summarizeCwtReceivable,
} from "@/lib/tax/cwt-receivable";

export async function postCwtReceivable(
  db: DbExecutor,
  input: { organizationId: string; userId: string; certificateId: string },
): Promise<{ journalHeaderId: string; taxWithheld: string }> {
  const [certificate] = await db
    .select()
    .from(taxCertificates)
    .where(
      and(
        eq(taxCertificates.id, input.certificateId),
        eq(taxCertificates.organizationId, input.organizationId),
      ),
    )
    .limit(1)
    .for("update");

  if (!certificate) throw new Error(`Certificate ${input.certificateId} was not found.`);
  if (certificate.journalHeaderId) {
    throw new CwtAlreadyPostedError(certificate.id, certificate.journalHeaderId);
  }

  const summary = summarizeCwtReceivable(certificate.taxWithheld);
  if (!summary.shouldPost) throw new CwtNothingToPostError(certificate.id);

  const transactionDate = certificate.periodEnd;
  const { locked, closedThrough } = await isDateInLockedPeriod(
    input.organizationId,
    transactionDate,
    db,
  );
  if (locked) {
    throw new Error(
      `Cannot post CWT for certificate ${certificate.id}: ${transactionDate} falls in a period ` +
        `locked through ${closedThrough}.`,
    );
  }

  const cwtAccountId = await requirePhAccount(db, input.organizationId, "ph_cwt_receivable");
  const arAccountId = await requireMappedAccountId(
    db,
    input.organizationId,
    "invoice",
    "accounts_receivable",
  );
  const transactionNumber = await allocateJournalTransactionNumber(input.organizationId, db);
  const functionalCurrency = await resolveFunctionalCurrency(db, input.organizationId);

  const [header] = await db
    .insert(journalHeaders)
    .values({
      organizationId: input.organizationId,
      transactionNumber,
      transactionDate,
      transactionType: "journal",
      source: "manual",
      functionalCurrency,
      memo: `CWT receivable: ${certificate.payorRegisteredName} ${certificate.atc}`,
      totalAmount: summary.taxWithheld,
      status: "posted",
      sourceDocumentId: certificate.id,
      sourceDocumentType: "tax_certificate",
      createdBy: input.userId,
      idempotencyKey: `cwt-receivable:${certificate.id}`,
    })
    .returning();
  if (!header) throw new Error("CWT receivable journal could not be posted.");

  await db.insert(journalLines).values([
    {
      journalHeaderId: header.id,
      accountId: cwtAccountId,
      debit: summary.taxWithheld,
      credit: null,
      lineDescription: `CWT receivable ${certificate.atc}`,
      sortOrder: 0,
    },
    {
      journalHeaderId: header.id,
      accountId: arAccountId,
      debit: null,
      credit: summary.taxWithheld,
      lineDescription: "A/R reduction for tax withheld by customer",
      sortOrder: 1,
    },
  ]);

  await db
    .update(taxCertificates)
    .set({ journalHeaderId: header.id, updatedAt: new Date() })
    .where(eq(taxCertificates.id, certificate.id));

  await db.insert(activityLogs).values({
    organizationId: input.organizationId,
    entityType: "transaction",
    entityId: header.id,
    action: "created",
    actorId: input.userId,
    changes: {
      source: "tax_certificate",
      certificateId: certificate.id,
      taxWithheld: summary.taxWithheld,
    },
  });

  return { journalHeaderId: header.id, taxWithheld: summary.taxWithheld };
}
