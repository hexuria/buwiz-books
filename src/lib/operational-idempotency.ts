import { and, eq } from "drizzle-orm";
import type { DbExecutor } from "@/db";
import { accountingOperationIdempotency } from "@/db/schema/operation-idempotency";
import { parties } from "@/db/schema/parties";
import {
  integrationSources,
  ledgerSourceLinks,
  organizationAccountingSettings,
  sourceRecordVersions,
  sourceRecords,
  workflowEvents,
} from "@/db/schema/inbox";
import { assertIdempotencyPayloadMatches, idempotencyPayloadHash } from "@/lib/idempotency";
import {
  DUPLICATE_MATCHER_VERSION,
  normalizeCurrency,
  normalizeDuplicateMatchInput,
  type EconomicEventClass,
  type TransactionDirection,
} from "@/lib/inbox/duplicate-matcher";
import { runDuplicateMatchingForSource } from "@/lib/inbox/duplicate-engine";

export type AccountingOperation = typeof accountingOperationIdempotency.$inferSelect;

export type BeginAccountingOperationInput = {
  organizationId: string;
  operationType: string;
  entityType: "bill" | "invoice";
  entityId: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  actorId: string;
};

export type BeginAccountingOperationResult =
  | { replayed: false; operation: AccountingOperation; payloadHash: string }
  | { replayed: true; operation: AccountingOperation; payloadHash: string };

/**
 * Claim an operation key inside the same transaction that owns the locked
 * bill/invoice row. A conflicting insert waits for the original transaction;
 * after it commits, the retry reads the completed result and never posts again.
 */
export async function beginAccountingOperation(
  db: DbExecutor,
  input: BeginAccountingOperationInput,
): Promise<BeginAccountingOperationResult> {
  const payloadHash = idempotencyPayloadHash(input.operationType, input.payload);
  const [created] = await db
    .insert(accountingOperationIdempotency)
    .values({
      organizationId: input.organizationId,
      operationType: input.operationType,
      entityType: input.entityType,
      entityId: input.entityId,
      idempotencyKey: input.idempotencyKey,
      payloadHash,
      actorId: input.actorId,
    })
    .onConflictDoNothing()
    .returning();

  if (created) {
    return { replayed: false, operation: created, payloadHash };
  }

  const [existing] = await db
    .select()
    .from(accountingOperationIdempotency)
    .where(
      and(
        eq(accountingOperationIdempotency.organizationId, input.organizationId),
        eq(accountingOperationIdempotency.idempotencyKey, input.idempotencyKey),
      ),
    )
    .limit(1);
  if (!existing) {
    throw new Error("Unable to resolve the idempotent accounting operation.");
  }

  assertIdempotencyPayloadMatches(existing.payloadHash, payloadHash, "accounting operation");
  if (
    existing.operationType !== input.operationType ||
    existing.entityType !== input.entityType ||
    existing.entityId !== input.entityId
  ) {
    throw new Error("This idempotency key was already used for a different accounting operation.");
  }
  if (existing.state !== "completed") {
    throw new Error("The accounting operation is still in progress. Retry shortly.");
  }

  await db
    .insert(workflowEvents)
    .values({
      organizationId: input.organizationId,
      entityType: input.entityType,
      entityId: input.entityId,
      action: "exact_replay_suppressed",
      actorType: "user",
      actorId: input.actorId,
      idempotencyKey: `operation-replay:${existing.id}`,
      data: {
        operationType: existing.operationType,
        operationId: existing.id,
        journalHeaderId: existing.journalHeaderId,
      },
    })
    .onConflictDoNothing();

  return { replayed: true, operation: existing, payloadHash };
}

export async function completeAccountingOperation(
  db: DbExecutor,
  input: {
    operationId: string;
    journalHeaderId?: string | null;
    sourceRecordId?: string | null;
    result: Record<string, unknown>;
  },
): Promise<AccountingOperation> {
  const [completed] = await db
    .update(accountingOperationIdempotency)
    .set({
      state: "completed",
      journalHeaderId: input.journalHeaderId ?? null,
      sourceRecordId: input.sourceRecordId ?? null,
      result: input.result,
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(accountingOperationIdempotency.id, input.operationId),
        eq(accountingOperationIdempotency.state, "pending"),
      ),
    )
    .returning();
  if (!completed) {
    throw new Error("The accounting operation could not be completed exactly once.");
  }
  return completed;
}

export async function ensureOperationalPaymentLineage(
  db: DbExecutor,
  input: {
    organizationId: string;
    actorId: string;
    entityType: "bill" | "invoice";
    entityId: string;
    documentNumber: string | null;
    paymentReference?: string | null;
    partyId: string | null;
    bankAccountId: string;
    idempotencyKey: string;
    requestPayloadHash: string;
    amount: string;
    effectiveDate: string;
    journalHeaderId: string;
  },
): Promise<typeof sourceRecords.$inferSelect> {
  const isBill = input.entityType === "bill";
  const provider = isBill ? "manual_bill_payment" : "manual_invoice_payment";
  const eventClass: EconomicEventClass = isBill ? "bill_payment" : "invoice_payment";
  const direction: TransactionDirection = isBill ? "outflow" : "inflow";
  const channel = isBill ? "bills_expenses" : "revenue";
  const externalSourceId = `${provider}:operations`;

  const [accountingSettings, party] = await Promise.all([
    db
      .select({ baseCurrency: organizationAccountingSettings.baseCurrency })
      .from(organizationAccountingSettings)
      .where(eq(organizationAccountingSettings.organizationId, input.organizationId))
      .limit(1)
      .then((rows) => rows[0]),
    input.partyId
      ? db
          .select({ name: parties.name })
          .from(parties)
          .where(
            and(eq(parties.organizationId, input.organizationId), eq(parties.id, input.partyId)),
          )
          .limit(1)
          .then((rows) => rows[0])
      : Promise.resolve(undefined),
  ]);
  const currency =
    normalizeCurrency(accountingSettings?.baseCurrency ?? "USD") ??
    (() => {
      throw new Error("The organization's base currency is invalid.");
    })();

  const [createdSource] = await db
    .insert(integrationSources)
    .values({
      organizationId: input.organizationId,
      provider,
      channel,
      externalSourceId,
      name: isBill ? "Manual bill payments" : "Manual invoice payments",
      currency,
    })
    .onConflictDoNothing()
    .returning();
  const [source] = createdSource
    ? [createdSource]
    : await db
        .select()
        .from(integrationSources)
        .where(
          and(
            eq(integrationSources.organizationId, input.organizationId),
            eq(integrationSources.provider, provider),
            eq(integrationSources.externalSourceId, externalSourceId),
          ),
        )
        .limit(1);
  if (!source) throw new Error("The operational payment source could not be initialized.");

  const description = `${isBill ? "Bill" : "Invoice"} payment${
    input.documentNumber ? `: ${input.documentNumber}` : ""
  }`;
  const normalized = normalizeDuplicateMatchInput({
    economicEventClass: eventClass,
    direction,
    originalAmount: input.amount,
    originalCurrency: currency,
    effectiveDate: input.effectiveDate,
    party: party?.name ?? null,
    reference: input.paymentReference ?? input.documentNumber ?? input.idempotencyKey,
    description,
    sourceAccountRef: input.bankAccountId,
    provider,
  });
  const rawData = {
    entityType: input.entityType,
    entityId: input.entityId,
    documentNumber: input.documentNumber,
    paymentReference: input.paymentReference ?? null,
    bankAccountId: input.bankAccountId,
    journalHeaderId: input.journalHeaderId,
    requestPayloadHash: input.requestPayloadHash,
  };

  const [record] = await db
    .insert(sourceRecords)
    .values({
      organizationId: input.organizationId,
      sourceId: source.id,
      recordType: eventClass,
      externalId: input.idempotencyKey,
      externalVersion: "1",
      providerStatus: "posted",
      transactionDate: input.effectiveDate,
      description,
      amount: normalized.originalAmount,
      currency,
      economicEventClass: eventClass,
      direction,
      originalAmount: normalized.originalAmount,
      originalCurrency: currency,
      functionalAmount: normalized.originalAmount,
      functionalCurrency: currency,
      effectiveDate: input.effectiveDate,
      normalizedParty: normalized.normalizedParty,
      normalizedReference: normalized.normalizedReference,
      sourceAccountRef: input.bankAccountId,
      matcherInputHash: normalized.inputHash,
      matcherVersion: DUPLICATE_MATCHER_VERSION,
      rawData,
    })
    .returning();
  if (!record) throw new Error("The operational payment record could not be initialized.");

  await db.insert(sourceRecordVersions).values({
    organizationId: input.organizationId,
    sourceRecordId: record.id,
    externalVersion: "1",
    payloadHash: input.requestPayloadHash,
    providerStatus: "posted",
    rawData,
    occurredAt: new Date(`${input.effectiveDate}T00:00:00.000Z`),
  });
  await db.insert(ledgerSourceLinks).values({
    organizationId: input.organizationId,
    journalHeaderId: input.journalHeaderId,
    sourceRecordId: record.id,
    relationship: "origin",
  });
  await db
    .insert(workflowEvents)
    .values({
      organizationId: input.organizationId,
      entityType: input.entityType,
      entityId: input.entityId,
      action: "payment_posted",
      actorType: "user",
      actorId: input.actorId,
      idempotencyKey: `operational-payment:${record.id}`,
      data: {
        sourceRecordId: record.id,
        journalHeaderId: input.journalHeaderId,
        amount: normalized.originalAmount,
        currency,
      },
    })
    .onConflictDoNothing();

  await runDuplicateMatchingForSource(
    { db, orgId: input.organizationId, userId: input.actorId },
    record.id,
    "source_updated",
  );

  return record;
}
