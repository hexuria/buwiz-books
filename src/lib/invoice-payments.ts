/**
 * Shared invoice-payment posting used by the card/PayPal payment handlers
 * (server/routes/api/payments/*). Records a customer payment against an invoice as a
 * balanced ledger entry AND updates the invoice's amountPaid / balanceDue / status in a
 * single transaction, so a completed card payment always reconciles to the general ledger.
 *
 *   DR  Deposit account (bank / payment clearing)   amount
 *   CR  Accounts Receivable                          amount
 *
 * The manual payment path in routes/api/-invoices.ts posts the same entry shape; this module
 * exists so the unauthenticated Nitro payment routes can post it too without duplicating logic.
 */
import { and, eq, sql } from "drizzle-orm";
import { firstOpenDateAfter, orgDateOf, resolveOrgTimezone } from "./org-calendar";
import { isDateInLockedPeriod } from "./period-close";
import { dbAdmin, type DbExecutor } from "@/db";
import { invoices } from "@/db/schema/invoices";
import { journalHeaders, journalLines } from "@/db/schema/journals";
import { activityLogs } from "@/db/schema/activity-logs";
import {
  integrationSources,
  ledgerSourceLinks,
  organizationAccountingSettings,
  sourceRecordVersions,
  sourceRecords,
  workflowEvents,
} from "@/db/schema/inbox";
import { allocateJournalTransactionNumber } from "@/lib/sequence";
import { validateBalance } from "@/db/validation/journals";
import { createLogger } from "@/lib/logger";
import { centsToMoney, moneyToCents } from "@/lib/money";
import {
  DUPLICATE_MATCHER_VERSION,
  normalizeCurrency,
  normalizeDuplicateMatchInput,
} from "@/lib/inbox/duplicate-matcher";
import { runDuplicateMatchingForSource } from "@/lib/inbox/duplicate-engine";
import {
  requireMappedAccountId,
  resolveMappedAccountId,
  UnmappedAccountError,
} from "@/lib/coa/resolve-mapped-account";

const logger = createLogger("lib.invoice-payments");

async function resolveArAccount(db: DbExecutor, orgId: string): Promise<string> {
  return requireMappedAccountId(db, orgId, "invoice", "accounts_receivable");
}

/**
 * Resolve the account a card/PayPal payment is deposited into.
 *
 * Prefers the configured payment-clearing mapping (subtype 'asset_clearing',
 * e.g. "Undeposited Funds"); falls back to a bank account so an org without a
 * clearing account can still take payments. The bank fallback lives here rather
 * than in the generic resolver because it is specific to this posting decision.
 */
async function resolveDepositAccount(db: DbExecutor, orgId: string): Promise<string> {
  const clearing = await resolveMappedAccountId(db, orgId, "invoice", "payment_clearing");
  if (clearing) return clearing;

  const bank = await resolveMappedAccountId(db, orgId, "bank", "checking");
  if (bank) return bank;

  throw new UnmappedAccountError("invoice", "payment_clearing", "Payment Clearing");
}

export type RecordCardPaymentInput = {
  invoiceId: string;
  /** Amount actually captured, in major currency units (e.g. dollars). */
  amount: number;
  paidVia: "stripe" | "paypal";
  /** External reference (Stripe/PayPal capture id) for idempotency + audit. */
  externalRef: string;
  currency?: string;
  occurredAt?: Date;
  db?: DbExecutor;
};

export type RecordCardPaymentResult = {
  status: "paid" | "partial";
  journalHeaderId: string;
  alreadyRecorded: boolean;
};

async function ensurePaymentSourceLineage(
  tx: DbExecutor,
  input: {
    organizationId: string;
    invoiceId: string;
    invoiceNumber: string;
    customerId: string;
    provider: "stripe" | "paypal";
    externalRef: string;
    amount: string;
    currency: string;
    effectiveDate: string;
    journalHeaderId: string;
    replayed: boolean;
  },
) {
  const externalSourceId = `${input.provider}:invoice-payments`;
  const [createdSource] = await tx
    .insert(integrationSources)
    .values({
      organizationId: input.organizationId,
      provider: input.provider,
      channel: "revenue",
      externalSourceId,
      name: `${input.provider === "stripe" ? "Stripe" : "PayPal"} invoice payments`,
    })
    .onConflictDoNothing()
    .returning();
  const [existingSource] = createdSource
    ? [createdSource]
    : await tx
        .select()
        .from(integrationSources)
        .where(
          and(
            eq(integrationSources.organizationId, input.organizationId),
            eq(integrationSources.provider, input.provider),
            eq(integrationSources.externalSourceId, externalSourceId),
          ),
        )
        .limit(1);
  if (!existingSource) throw new Error("Payment integration source could not be initialized.");

  await tx.execute(sql`
    SELECT pg_advisory_xact_lock(
      hashtextextended(
        ${`provider-record:${input.organizationId}:${existingSource.id}:${input.externalRef}`},
        0::bigint
      )
    )
  `);
  const normalized = normalizeDuplicateMatchInput({
    economicEventClass: "invoice_payment",
    direction: "inflow",
    originalAmount: input.amount,
    originalCurrency: input.currency,
    effectiveDate: input.effectiveDate,
    reference: input.externalRef,
    description: `${input.provider} payment for invoice ${input.invoiceNumber}`,
    provider: input.provider,
  });
  const rawData = {
    invoiceId: input.invoiceId,
    invoiceNumber: input.invoiceNumber,
    customerId: input.customerId,
    provider: input.provider,
    externalRef: input.externalRef,
    journalHeaderId: input.journalHeaderId,
  };
  const [existingRecord] = await tx
    .select()
    .from(sourceRecords)
    .where(
      and(
        eq(sourceRecords.organizationId, input.organizationId),
        eq(sourceRecords.sourceId, existingSource.id),
        eq(sourceRecords.externalId, input.externalRef),
      ),
    )
    .limit(1);
  const [createdRecord] = existingRecord
    ? [existingRecord]
    : await tx
        .insert(sourceRecords)
        .values({
          organizationId: input.organizationId,
          sourceId: existingSource.id,
          recordType: "invoice_payment",
          externalId: input.externalRef,
          externalVersion: "1",
          providerStatus: "captured",
          transactionDate: input.effectiveDate,
          description: `${input.provider} payment for invoice ${input.invoiceNumber}`,
          amount: normalized.originalAmount,
          currency: input.currency,
          economicEventClass: "invoice_payment",
          direction: "inflow",
          originalAmount: normalized.originalAmount,
          originalCurrency: input.currency,
          functionalAmount: normalized.originalAmount,
          functionalCurrency: input.currency,
          effectiveDate: input.effectiveDate,
          normalizedReference: normalized.normalizedReference,
          matcherInputHash: normalized.inputHash,
          matcherVersion: DUPLICATE_MATCHER_VERSION,
          rawData,
        })
        .returning();
  if (!createdRecord) throw new Error("Payment source record could not be initialized.");

  await tx
    .insert(sourceRecordVersions)
    .values({
      organizationId: input.organizationId,
      sourceRecordId: createdRecord.id,
      externalVersion: "1",
      providerStatus: "captured",
      rawData,
      occurredAt: new Date(`${input.effectiveDate}T00:00:00.000Z`),
    })
    .onConflictDoNothing();
  await tx
    .insert(ledgerSourceLinks)
    .values({
      organizationId: input.organizationId,
      journalHeaderId: input.journalHeaderId,
      sourceRecordId: createdRecord.id,
      relationship: "origin",
    })
    .onConflictDoNothing();

  await runDuplicateMatchingForSource(
    { db: tx, orgId: input.organizationId, userId: "system" },
    createdRecord.id,
    "provider_updated",
  );
  if (input.replayed) {
    await tx
      .insert(workflowEvents)
      .values({
        organizationId: input.organizationId,
        entityType: "source_record",
        entityId: createdRecord.id,
        action: "exact_replay_suppressed",
        actorType: "system",
        actorId: "system",
        idempotencyKey: `invoice-payment-replay:${input.provider}:${input.externalRef}`,
        data: {
          replayType: "provider_identity",
          provider: input.provider,
          externalRef: input.externalRef,
          journalHeaderId: input.journalHeaderId,
        },
      })
      .onConflictDoNothing();
  }
  return createdRecord;
}

/**
 * Idempotently record a captured card/PayPal payment against an invoice. Safe to call more
 * than once for the same capture (webhook retries) — the externalRef guard prevents a second
 * journal from being posted.
 */
export async function recordCardInvoicePayment(
  input: RecordCardPaymentInput,
): Promise<RecordCardPaymentResult> {
  // Stripe/PayPal captures arrive with no session, so no RLS org context can be
  // set — default to the admin connection rather than the raw app pool.
  const executor = input.db ?? dbAdmin;

  return executor.transaction(async (tx) => {
    const [invoice] = await tx
      .select({
        id: invoices.id,
        organizationId: invoices.organizationId,
        invoiceNumber: invoices.invoiceNumber,
        customerId: invoices.customerId,
        total: invoices.total,
        amountPaid: invoices.amountPaid,
        status: invoices.status,
      })
      .from(invoices)
      .where(eq(invoices.id, input.invoiceId))
      .limit(1)
      .for("update");

    if (!invoice) throw new Error("Invoice not found");

    const orgId = invoice.organizationId;
    const idempotencyKey = `invoice-payment:${input.paidVia}:${input.externalRef}`;
    const amountCents = moneyToCents(input.amount, "Payment amount");
    if (amountCents <= 0) throw new Error("Payment amount must be greater than zero");
    const amount = centsToMoney(amountCents);
    const [accountingSettings] = await tx
      .select({ baseCurrency: organizationAccountingSettings.baseCurrency })
      .from(organizationAccountingSettings)
      .where(eq(organizationAccountingSettings.organizationId, orgId))
      .limit(1);
    const baseCurrency = normalizeCurrency(accountingSettings?.baseCurrency ?? "USD") ?? "USD";
    const paymentCurrency = normalizeCurrency(input.currency ?? baseCurrency);
    if (!paymentCurrency) throw new Error("Payment currency must be a three-letter ISO code.");
    if (paymentCurrency !== baseCurrency) {
      throw new Error(
        `Captured ${paymentCurrency} payments require an explicit FX posting before they can be recorded in ${baseCurrency}.`,
      );
    }
    const occurredAt = input.occurredAt ?? new Date();
    if (Number.isNaN(occurredAt.getTime())) throw new Error("Payment date is invalid.");
    // The capture day on the ORG's calendar, not UTC's — a 07:00 Manila
    // capture on 1 September is 31 August in UTC, the prior period.
    const effectiveDate = orgDateOf(occurredAt, await resolveOrgTimezone(tx, orgId));

    // This was the only posting path with no period-close check. A captured
    // payment is a fact — money moved — so a locked period never REJECTS it:
    // the journal posts on the first open day instead, and the memo says so.
    // The lineage below keeps the true capture date.
    let postingDate = effectiveDate;
    let lockNote = "";
    {
      const { locked, closedThrough } = await isDateInLockedPeriod(orgId, effectiveDate, tx);
      if (locked && closedThrough) {
        postingDate = firstOpenDateAfter(closedThrough);
        lockNote = ` (captured ${effectiveDate}; posted ${postingDate} — period locked through ${closedThrough})`;
      }
    }

    // Idempotency: if a payment journal for this capture ref already exists, do nothing.
    const [existing] = await tx
      .select({ id: journalHeaders.id })
      .from(journalHeaders)
      .where(
        and(
          eq(journalHeaders.organizationId, orgId),
          eq(journalHeaders.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1);
    if (existing) {
      await ensurePaymentSourceLineage(tx, {
        organizationId: orgId,
        invoiceId: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        customerId: invoice.customerId,
        provider: input.paidVia,
        externalRef: input.externalRef,
        amount,
        currency: paymentCurrency,
        effectiveDate,
        journalHeaderId: existing.id,
        replayed: true,
      });
      logger.info("Card payment already recorded — skipping duplicate", {
        invoiceId: invoice.id,
        externalRef: input.externalRef,
      });
      return {
        status: invoice.status === "paid" ? "paid" : "partial",
        journalHeaderId: existing.id,
        alreadyRecorded: true,
      };
    }

    if (!["sent", "viewed", "overdue", "partial"].includes(invoice.status)) {
      throw new Error(`Invoice cannot accept payment while status is "${invoice.status}"`);
    }

    const totalCents = moneyToCents(invoice.total, "Invoice total");
    const previousPaidCents = moneyToCents(invoice.amountPaid ?? "0", "Amount paid");
    const remainingCents = totalCents - previousPaidCents;
    if (amountCents > remainingCents) {
      throw new Error(
        `Payment amount ${centsToMoney(amountCents)} exceeds the remaining balance ${centsToMoney(remainingCents)}.`,
      );
    }
    const arAccountId = await resolveArAccount(tx, orgId);
    const depositAccountId = await resolveDepositAccount(tx, orgId);

    const lineInputs = [
      { accountId: depositAccountId, debit: amount },
      { accountId: arAccountId, credit: amount },
    ];
    const balance = validateBalance(lineInputs);
    if (!balance.valid) {
      throw new Error("Payment journal does not balance — refusing to post.");
    }

    const txnNumber = await allocateJournalTransactionNumber(orgId, tx);
    const [header] = await tx
      .insert(journalHeaders)
      .values({
        organizationId: orgId,
        transactionNumber: txnNumber,
        transactionDate: postingDate,
        transactionType: "pay_in",
        source: "payment",
        memo: `Payment (${input.paidVia}): ${invoice.invoiceNumber}${lockNote}`,
        partyId: invoice.customerId,
        totalAmount: amount,
        functionalCurrency: baseCurrency,
        transactionCurrency: paymentCurrency,
        status: "posted",
        postedAt: new Date(),
        sourceDocumentId: invoice.id,
        sourceDocumentType: "invoice",
        referenceNumber: input.externalRef,
        idempotencyKey,
      })
      .returning();

    await tx.insert(journalLines).values([
      {
        journalHeaderId: header.id,
        accountId: depositAccountId,
        debit: amount,
        credit: null,
        originalDebit: amount,
        originalCredit: null,
        originalCurrency: paymentCurrency,
        exchangeRate: "1",
        lineDescription: `${input.paidVia} payment for invoice ${invoice.invoiceNumber}`,
        partyId: invoice.customerId,
        sortOrder: 0,
      },
      {
        journalHeaderId: header.id,
        accountId: arAccountId,
        debit: null,
        credit: amount,
        originalDebit: null,
        originalCredit: amount,
        originalCurrency: paymentCurrency,
        exchangeRate: "1",
        lineDescription: `A/R reduction for invoice ${invoice.invoiceNumber}`,
        partyId: invoice.customerId,
        sortOrder: 1,
      },
    ]);

    // Update invoice paid/balance/status.
    const newPaidCents = previousPaidCents + amountCents;
    const newBalanceCents = totalCents - newPaidCents;
    const fullyPaid = newBalanceCents === 0;

    await tx
      .update(invoices)
      .set({
        status: fullyPaid ? "paid" : "partial",
        amountPaid: centsToMoney(newPaidCents),
        balanceDue: centsToMoney(newBalanceCents),
        paidAt: fullyPaid ? new Date() : undefined,
        paidVia: input.paidVia,
        updatedAt: new Date(),
      })
      .where(eq(invoices.id, invoice.id));

    await tx.insert(activityLogs).values({
      organizationId: orgId,
      entityType: "invoice",
      entityId: invoice.id,
      action: "updated",
      actorId: null,
      changes: {
        source: `${input.paidVia}_payment`,
        amount,
        externalRef: input.externalRef,
        transactionNumber: txnNumber,
      },
    });
    await ensurePaymentSourceLineage(tx, {
      organizationId: orgId,
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      customerId: invoice.customerId,
      provider: input.paidVia,
      externalRef: input.externalRef,
      amount,
      currency: paymentCurrency,
      effectiveDate,
      journalHeaderId: header.id,
      replayed: false,
    });

    return {
      status: fullyPaid ? "paid" : "partial",
      journalHeaderId: header.id,
      alreadyRecorded: false,
    };
  });
}
