import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, inArray, ne, or, sql } from "drizzle-orm";
import type { DbExecutor } from "@/db";
import { accounts } from "@/db/schema/accounts";
import { organization } from "@/db/schema/auth";
import { bills } from "@/db/schema/bills";
import { dimensions } from "@/db/schema/dimensions";
import { documentAttachments, documents } from "@/db/schema/documents";
import {
  inboxItems,
  integrationSources,
  ledgerSourceLinks,
  organizationAccountingSettings,
  reviewDecisions,
  reviewFindings,
  reviewRuleConfigs,
  reviewRuleDefinitions,
  sourceMatchCandidates,
  sourceRecordDocuments,
  sourceRecordVersions,
  sourceRecords,
  transactionCandidateLines,
  transactionCandidateSources,
  transactionCandidates,
  workflowEvents,
} from "@/db/schema/inbox";
import { journalHeaders, journalLines } from "@/db/schema/journals";
import { parties } from "@/db/schema/parties";
import { insertActivityLog } from "@/lib/insert-activity-log";
import { assertIdempotencyPayloadMatches, idempotencyPayloadHash } from "@/lib/idempotency";
import { parseOrgMetadata } from "@/lib/org-metadata";
import { isDateInLockedPeriod } from "@/lib/period-close";
import { allocateJournalTransactionNumber } from "@/lib/sequence";
import {
  DUPLICATE_MATCHER_VERSION,
  normalizeAmountForCurrency,
  normalizeDuplicateMatchInput,
  type EconomicEventClass,
  type TransactionDirection,
} from "./duplicate-matcher";
import { loadDuplicateEngineConfig, runDuplicateMatchingForSource } from "./duplicate-engine";
import { preserveAuthoritativeEconomicEvent } from "./economic-event";
import { evaluateBookRules, type BookRuleAccount } from "./rules";
import { compareMoney, formatMoney, multiplyMoney, normalizeCurrency, sumMoney } from "./money";
import type { CreateCandidateInput, InboxServiceContext } from "./types";
import { resolveFxRate } from "./fx";
import { lockInboxCandidateLifecycle } from "./lifecycle-lock";

type AccountingSettings = typeof organizationAccountingSettings.$inferSelect;

async function recordExactReplaySuppressed(
  ctx: Pick<InboxServiceContext, "db" | "orgId" | "userId">,
  input: {
    entityType: "transaction_candidate" | "source_record";
    entityId: string;
    replayType: "request_idempotency" | "provider_identity";
    idempotencyKey: string;
    data?: Record<string, unknown>;
  },
) {
  await ctx.db
    .insert(workflowEvents)
    .values({
      organizationId: ctx.orgId,
      entityType: input.entityType,
      entityId: input.entityId,
      action: "exact_replay_suppressed",
      actorType: ctx.userId.startsWith("system") ? "system" : "user",
      actorId: ctx.userId,
      idempotencyKey: input.idempotencyKey,
      data: {
        replayType: input.replayType,
        ...input.data,
      },
    })
    .onConflictDoNothing();
}

function sourceProvider(input: CreateCandidateInput): string {
  return input.sourceProvider?.trim().toLowerCase() || "internal";
}

function sourceClassification(input: CreateCandidateInput): {
  economicEventClass: EconomicEventClass;
  direction: TransactionDirection;
} {
  if (input.sourceChannel === "payroll") {
    return { economicEventClass: "payroll", direction: "outflow" };
  }
  if (input.candidateType === "bill") {
    return { economicEventClass: "bill_accrual", direction: "outflow" };
  }
  if (input.candidateType === "invoice") {
    return { economicEventClass: "invoice_accrual", direction: "inflow" };
  }
  switch (input.transactionType) {
    case "pay_in":
      return { economicEventClass: "sale", direction: "inflow" };
    case "pay_out":
      return { economicEventClass: "purchase", direction: "outflow" };
    case "transfer":
      return { economicEventClass: "transfer", direction: "neutral" };
    default:
      return { economicEventClass: "other", direction: "unknown" };
  }
}

function journalSourceFor(channel: string): typeof journalHeaders.$inferInsert.source {
  switch (channel) {
    case "csv":
      return "import";
    case "upload":
      return "document";
    case "email":
      return "email";
    case "bills_expenses":
      return "bill";
    case "bank":
    case "card":
    case "payroll":
    case "revenue":
      return "integration";
    default:
      return "manual";
  }
}

async function getAccountingSettings(db: DbExecutor, orgId: string): Promise<AccountingSettings> {
  const [existing] = await db
    .select()
    .from(organizationAccountingSettings)
    .where(eq(organizationAccountingSettings.organizationId, orgId))
    .limit(1);
  if (existing) return existing;

  const [org] = await db
    .select({ metadata: organization.metadata })
    .from(organization)
    .where(eq(organization.id, orgId))
    .limit(1);
  const baseCurrency = normalizeCurrency(parseOrgMetadata(org?.metadata).currency ?? "USD");
  const [created] = await db
    .insert(organizationAccountingSettings)
    .values({ organizationId: orgId, baseCurrency })
    .onConflictDoNothing()
    .returning();
  if (created) return created;

  const [concurrent] = await db
    .select()
    .from(organizationAccountingSettings)
    .where(eq(organizationAccountingSettings.organizationId, orgId))
    .limit(1);
  if (!concurrent) throw new Error("Unable to initialize accounting settings.");
  return concurrent;
}

async function getOrCreateSource(db: DbExecutor, orgId: string, input: CreateCandidateInput) {
  const provider = sourceProvider(input);
  const channel = input.sourceChannel ?? "manual";
  const externalSourceId = `${provider}:${channel}`;
  const [existing] = await db
    .select()
    .from(integrationSources)
    .where(
      and(
        eq(integrationSources.organizationId, orgId),
        eq(integrationSources.provider, provider),
        eq(integrationSources.externalSourceId, externalSourceId),
      ),
    )
    .limit(1);
  if (existing) return existing;

  const [created] = await db
    .insert(integrationSources)
    .values({
      organizationId: orgId,
      provider,
      channel,
      externalSourceId,
      name: provider === "internal" ? `Internal ${channel}` : provider,
    })
    .onConflictDoNothing()
    .returning();
  if (created) return created;

  const [concurrent] = await db
    .select()
    .from(integrationSources)
    .where(
      and(
        eq(integrationSources.organizationId, orgId),
        eq(integrationSources.provider, provider),
        eq(integrationSources.externalSourceId, externalSourceId),
      ),
    )
    .limit(1);
  if (!concurrent) throw new Error("Unable to initialize transaction source.");
  return concurrent;
}

async function loadRuleInputs(db: DbExecutor, orgId: string, input: CreateCandidateInput) {
  const accountIds = [
    ...new Set(input.lines.flatMap((line) => (line.accountId ? [line.accountId] : []))),
  ];
  const orgAccounts = await db
    .select({
      id: accounts.id,
      accountType: accounts.accountType,
      subtype: accounts.subtype,
      parentId: accounts.parentId,
    })
    .from(accounts)
    .where(eq(accounts.organizationId, orgId));
  const requestedAccounts = new Set(accountIds);
  if (accountIds.some((id) => !orgAccounts.some((account) => account.id === id))) {
    throw new Error("One or more selected accounts do not belong to this organization.");
  }
  const childCounts = new Map<string, number>();
  for (const account of orgAccounts) {
    if (account.parentId) {
      childCounts.set(account.parentId, (childCounts.get(account.parentId) ?? 0) + 1);
    }
  }
  const accountMap = new Map<string, BookRuleAccount>();
  for (const account of orgAccounts) {
    if (!requestedAccounts.has(account.id)) continue;
    accountMap.set(account.id, {
      id: account.id,
      accountType: account.accountType,
      subtype: account.subtype,
      childCount: childCounts.get(account.id) ?? 0,
    });
  }

  const [party] = input.partyId
    ? await db
        .select({
          id: parties.id,
          partyType: parties.partyType,
          name: parties.name,
        })
        .from(parties)
        .where(and(eq(parties.id, input.partyId), eq(parties.organizationId, orgId)))
        .limit(1)
    : [];
  if (input.partyId && !party) {
    throw new Error("The selected vendor or customer does not belong to this organization.");
  }

  const requestedDimensionIds = [
    ...new Set(
      input.lines.flatMap((line) =>
        [line.departmentId, line.locationId].filter((dimensionId): dimensionId is string =>
          Boolean(dimensionId),
        ),
      ),
    ),
  ];
  const selectedDimensions =
    requestedDimensionIds.length > 0
      ? await db
          .select({
            id: dimensions.id,
            dimensionType: dimensions.dimensionType,
            isActive: dimensions.isActive,
          })
          .from(dimensions)
          .where(
            and(
              eq(dimensions.organizationId, orgId),
              inArray(dimensions.id, requestedDimensionIds),
            ),
          )
      : [];
  const dimensionById = new Map(selectedDimensions.map((dimension) => [dimension.id, dimension]));
  for (const line of input.lines) {
    if (
      line.departmentId &&
      (dimensionById.get(line.departmentId)?.dimensionType !== "department" ||
        !dimensionById.get(line.departmentId)?.isActive)
    ) {
      throw new Error("The selected department is inactive or belongs to another organization.");
    }
    if (
      line.locationId &&
      (dimensionById.get(line.locationId)?.dimensionType !== "location" ||
        !dimensionById.get(line.locationId)?.isActive)
    ) {
      throw new Error("The selected location is inactive or belongs to another organization.");
    }
  }

  const documentIds = [...new Set(input.documentIds ?? [])];
  const selectedDocuments =
    documentIds.length > 0
      ? await db
          .select({
            id: documents.id,
            documentType: documents.documentType,
            contentHash: documents.contentHash,
          })
          .from(documents)
          .where(and(eq(documents.organizationId, orgId), inArray(documents.id, documentIds)))
      : [];
  if (selectedDocuments.length !== documentIds.length) {
    throw new Error("One or more attached documents do not belong to this organization.");
  }

  return { accountMap, party: party ?? null, documents: selectedDocuments };
}

export async function createTransactionCandidate(
  ctx: InboxServiceContext,
  input: CreateCandidateInput,
) {
  const { db, orgId, userId } = ctx;
  const requestIdempotencyKey = input.requestIdempotencyKey?.trim() || null;
  const requestPayloadHash = requestIdempotencyKey
    ? (input.requestPayloadHash ??
      idempotencyPayloadHash("transaction-candidate", {
        transactionDate: input.transactionDate,
        transactionType: input.transactionType,
        memo: input.memo,
        partyId: input.partyId,
        referenceNumber: input.referenceNumber,
        originalCurrency: input.originalCurrency,
        functionalCurrency: input.functionalCurrency,
        exchangeRate: input.exchangeRate,
        exchangeRateId: input.exchangeRateId,
        sourceChannel: input.sourceChannel,
        sourceProvider: input.sourceProvider,
        externalId: input.externalId,
        externalVersion: input.externalVersion,
        candidateType: input.candidateType,
        documentIds: [...new Set(input.documentIds ?? [])].sort(),
        lines: input.lines,
      }))
    : null;
  if (requestIdempotencyKey) {
    // All mutation entry points run inside withOrgContext's transaction, so this
    // serializes concurrent retries until the winning candidate is visible.
    await db.execute(sql`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${"candidate-request:" + orgId + ":" + requestIdempotencyKey}, 0::bigint)
      )
    `);
    const [replayedRequest] = await db
      .select({
        inboxItem: inboxItems,
        candidate: transactionCandidates,
        sourceRawData: sourceRecords.rawData,
      })
      .from(transactionCandidates)
      .innerJoin(inboxItems, eq(inboxItems.candidateId, transactionCandidates.id))
      .leftJoin(sourceRecords, eq(transactionCandidates.sourceRecordId, sourceRecords.id))
      .where(
        and(
          eq(transactionCandidates.organizationId, orgId),
          eq(transactionCandidates.requestIdempotencyKey, requestIdempotencyKey),
        ),
      )
      .limit(1);
    if (replayedRequest) {
      assertIdempotencyPayloadMatches(
        replayedRequest.sourceRawData?.requestPayloadHash,
        requestPayloadHash!,
        "transaction",
      );
      await recordExactReplaySuppressed(ctx, {
        entityType: "transaction_candidate",
        entityId: replayedRequest.candidate.id,
        replayType: "request_idempotency",
        idempotencyKey: `exact-replay:request:${replayedRequest.candidate.id}`,
        data: { sourceChannel: input.sourceChannel ?? "manual" },
      });
      return {
        inboxItem: replayedRequest.inboxItem,
        candidate: replayedRequest.candidate,
        findingCount: 0,
        deduplicated: true,
      };
    }
  }
  if (input.lines.length < 2) throw new Error("At least two posting lines are required.");

  const settings = await getAccountingSettings(db, orgId);
  const originalCurrency = normalizeCurrency(input.originalCurrency ?? settings.baseCurrency);
  const functionalCurrency = normalizeCurrency(input.functionalCurrency ?? settings.baseCurrency);
  const resolvedFx = await resolveFxRate({
    db,
    orgId,
    transactionDate: input.transactionDate,
    originalCurrency,
    functionalCurrency,
    suppliedRate: input.exchangeRate,
    suppliedRateId: input.exchangeRateId,
    suppliedBySource: (input.sourceChannel ?? "manual") !== "manual",
    actorId: userId,
  });
  const exchangeRate = resolvedFx.rate;

  const normalizedLines = input.lines.map((line, index) => {
    const originalDebit = line.originalDebit ?? line.debit ?? null;
    const originalCredit = line.originalCredit ?? line.credit ?? null;
    if (originalDebit && originalCredit) {
      throw new Error(`Line ${index + 1} cannot contain both a debit and a credit.`);
    }
    return {
      ...line,
      originalDebit,
      originalCredit,
      functionalDebit: originalDebit ? multiplyMoney(originalDebit, exchangeRate) : null,
      functionalCredit: originalCredit ? multiplyMoney(originalCredit, exchangeRate) : null,
    };
  });
  const originalDebits = sumMoney(normalizedLines.map((line) => line.originalDebit));
  const originalCredits = sumMoney(normalizedLines.map((line) => line.originalCredit));
  const functionalDebits = sumMoney(normalizedLines.map((line) => line.functionalDebit));
  const functionalCredits = sumMoney(normalizedLines.map((line) => line.functionalCredit));
  if (
    compareMoney(originalDebits, originalCredits) !== 0 ||
    compareMoney(functionalDebits, functionalCredits) !== 0
  ) {
    throw new Error(
      `Unbalanced entry: debits ${formatMoney(functionalDebits)} do not equal credits ${formatMoney(functionalCredits)}.`,
    );
  }

  const ruleInputs = await loadRuleInputs(db, orgId, input);
  const provider = sourceProvider(input);
  const source = await getOrCreateSource(db, orgId, input);
  const externalId = input.externalId?.trim() || randomUUID();
  const externalVersion = input.externalVersion?.trim() || "1";
  const sourceRawData = {
    referenceNumber: input.referenceNumber ?? null,
    transactionType: input.transactionType,
    requestPayloadHash,
  };
  const classification = sourceClassification(input);
  const normalizedSource = normalizeDuplicateMatchInput({
    economicEventClass: classification.economicEventClass,
    direction: classification.direction,
    originalAmount: originalDebits,
    originalCurrency,
    effectiveDate: input.transactionDate,
    party: ruleInputs.party?.name,
    reference: input.referenceNumber,
    description: input.memo,
    provider,
    documentHashes: ruleInputs.documents.flatMap(({ contentHash }) =>
      contentHash ? [contentHash] : [],
    ),
  });
  const normalizedOriginalAmount = normalizedSource.originalAmount ?? originalDebits;
  const normalizedFunctionalAmount =
    normalizeAmountForCurrency(functionalDebits, functionalCurrency) ?? functionalDebits;
  await db.execute(sql`
    SELECT pg_advisory_xact_lock(
      hashtextextended(${"provider-record:" + orgId + ":" + source.id + ":" + externalId}, 0::bigint)
    )
  `);

  const [existingLogicalRecord] = await db
    .select({
      id: sourceRecords.id,
      externalVersion: sourceRecords.externalVersion,
      economicEventClass: sourceRecords.economicEventClass,
      rawData: sourceRecords.rawData,
    })
    .from(sourceRecords)
    .where(
      and(
        eq(sourceRecords.organizationId, orgId),
        eq(sourceRecords.sourceId, source.id),
        eq(sourceRecords.externalId, externalId),
      ),
    )
    .orderBy(
      sql`case when ${sourceRecords.recordState} = 'active' then 0 when ${sourceRecords.recordState} = 'rejected' then 1 else 2 end`,
      desc(sourceRecords.updatedAt),
    )
    .limit(1);
  if (existingLogicalRecord) {
    const updatedClassification = preserveAuthoritativeEconomicEvent(
      classification,
      existingLogicalRecord.economicEventClass,
    );
    const updatedNormalizedSource = normalizeDuplicateMatchInput({
      economicEventClass: updatedClassification.economicEventClass,
      direction: updatedClassification.direction,
      originalAmount: originalDebits,
      originalCurrency,
      effectiveDate: input.transactionDate,
      party: ruleInputs.party?.name,
      reference: input.referenceNumber,
      description: input.memo,
      provider,
      documentHashes: ruleInputs.documents.flatMap(({ contentHash }) =>
        contentHash ? [contentHash] : [],
      ),
    });
    const preservedRequestPayloadHash = existingLogicalRecord.rawData?.requestPayloadHash;
    const versionRawData = {
      ...existingLogicalRecord.rawData,
      ...sourceRawData,
      requestPayloadHash: preservedRequestPayloadHash ?? requestPayloadHash,
    };
    await db
      .insert(sourceRecordVersions)
      .values({
        organizationId: orgId,
        sourceRecordId: existingLogicalRecord.id,
        externalVersion,
        rawData: versionRawData,
      })
      .onConflictDoNothing();
    if (existingLogicalRecord.externalVersion !== externalVersion) {
      await db
        .update(sourceRecords)
        .set({
          externalVersion,
          transactionDate: input.transactionDate,
          description: input.memo,
          amount: updatedNormalizedSource.originalAmount ?? originalDebits,
          currency: originalCurrency,
          economicEventClass: updatedClassification.economicEventClass,
          direction: updatedClassification.direction,
          originalAmount: updatedNormalizedSource.originalAmount ?? originalDebits,
          originalCurrency,
          functionalAmount: normalizedFunctionalAmount,
          functionalCurrency,
          effectiveDate: input.transactionDate,
          normalizedParty: updatedNormalizedSource.normalizedParty,
          normalizedReference: updatedNormalizedSource.normalizedReference,
          matcherInputHash: updatedNormalizedSource.inputHash,
          matcherVersion: DUPLICATE_MATCHER_VERSION,
          rawData: versionRawData,
          updatedAt: new Date(),
        })
        .where(eq(sourceRecords.id, existingLogicalRecord.id));
    }
    if (input.documentIds?.length) {
      await db
        .insert(sourceRecordDocuments)
        .values(
          [...new Set(input.documentIds)].map((documentId) => ({
            sourceRecordId: existingLogicalRecord.id,
            documentId,
            organizationId: orgId,
          })),
        )
        .onConflictDoNothing();
    }
    await runDuplicateMatchingForSource(ctx, existingLogicalRecord.id, "provider_updated");
    const [duplicate] = await db
      .select({ inboxItem: inboxItems, candidate: transactionCandidates })
      .from(inboxItems)
      .innerJoin(transactionCandidates, eq(inboxItems.candidateId, transactionCandidates.id))
      .where(
        and(
          eq(inboxItems.organizationId, orgId),
          eq(inboxItems.sourceRecordId, existingLogicalRecord.id),
        ),
      )
      .limit(1);
    if (duplicate) {
      if (existingLogicalRecord.externalVersion === externalVersion) {
        await recordExactReplaySuppressed(ctx, {
          entityType: "source_record",
          entityId: existingLogicalRecord.id,
          replayType: "provider_identity",
          idempotencyKey: `exact-replay:provider:${existingLogicalRecord.id}:${externalVersion}`,
          data: { sourceChannel: input.sourceChannel ?? "manual", provider },
        });
      }
      return { ...duplicate, findingCount: 0, deduplicated: true };
    }
    throw new Error("This source transaction was already received.");
  }

  const [sourceRecord] = await db
    .insert(sourceRecords)
    .values({
      organizationId: orgId,
      sourceId: source.id,
      recordType: input.candidateType ?? "transaction",
      externalId,
      externalVersion,
      transactionDate: input.transactionDate,
      description: input.memo,
      amount: normalizedOriginalAmount,
      currency: originalCurrency,
      economicEventClass: classification.economicEventClass,
      direction: classification.direction,
      originalAmount: normalizedOriginalAmount,
      originalCurrency,
      functionalAmount: normalizedFunctionalAmount,
      functionalCurrency,
      effectiveDate: input.transactionDate,
      normalizedParty: normalizedSource.normalizedParty,
      normalizedReference: normalizedSource.normalizedReference,
      matcherInputHash: normalizedSource.inputHash,
      matcherVersion: DUPLICATE_MATCHER_VERSION,
      rawData: sourceRawData,
    })
    .returning();
  await db.insert(sourceRecordVersions).values({
    organizationId: orgId,
    sourceRecordId: sourceRecord.id,
    externalVersion,
    rawData: sourceRawData,
  });
  const [candidate] = await db
    .insert(transactionCandidates)
    .values({
      organizationId: orgId,
      sourceRecordId: sourceRecord.id,
      requestIdempotencyKey,
      candidateType: input.candidateType ?? "transaction",
      transactionDate: input.transactionDate,
      transactionType: input.transactionType,
      memo: input.memo,
      referenceNumber: input.referenceNumber,
      partyId: input.partyId,
      originalCurrency,
      functionalCurrency,
      exchangeRateId: resolvedFx.id,
      exchangeRate,
      originalTotal: originalDebits,
      functionalTotal: functionalDebits,
      submittedBy: userId,
    })
    .returning();
  await db.insert(transactionCandidateSources).values({
    organizationId: orgId,
    candidateId: candidate.id,
    sourceRecordId: sourceRecord.id,
    relationship: "origin",
    isPrimary: true,
  });

  await db.insert(transactionCandidateLines).values(
    normalizedLines.map((line, index) => ({
      organizationId: orgId,
      candidateId: candidate.id,
      accountId: line.accountId,
      originalDebit: line.originalDebit,
      originalCredit: line.originalCredit,
      functionalDebit: line.functionalDebit,
      functionalCredit: line.functionalCredit,
      originalCurrency,
      exchangeRate,
      lineDescription: line.lineDescription,
      partyId: line.partyId,
      departmentId: line.departmentId,
      locationId: line.locationId,
      categoryConfidence: line.categoryConfidence,
      predictionEvidence: line.predictionEvidence,
      sortOrder: line.sortOrder ?? index,
    })),
  );

  const title =
    input.memo?.trim() ||
    ruleInputs.party?.name ||
    `${input.transactionType.replace("_", " ")} ${originalCurrency} ${formatMoney(originalDebits)}`;
  const [inboxItem] = await db
    .insert(inboxItems)
    .values({
      organizationId: orgId,
      candidateId: candidate.id,
      sourceRecordId: sourceRecord.id,
      title: title.slice(0, 255),
      submittedBy: userId,
      candidateRevision: candidate.revision,
    })
    .returning();

  if (input.documentIds?.length) {
    await db.insert(sourceRecordDocuments).values(
      [...new Set(input.documentIds)].map((documentId) => ({
        sourceRecordId: sourceRecord.id,
        documentId,
        organizationId: orgId,
      })),
    );
    await db.insert(documentAttachments).values(
      [...new Set(input.documentIds)].map((documentId) => ({
        documentId,
        organizationId: orgId,
        linkableType: "transaction_candidate",
        linkableId: candidate.id,
      })),
    );
  }

  const configuredRules = await db
    .select({
      key: reviewRuleDefinitions.key,
      enabled: reviewRuleConfigs.enabled,
      impact: reviewRuleConfigs.impact,
      config: reviewRuleConfigs.config,
    })
    .from(reviewRuleConfigs)
    .innerJoin(reviewRuleDefinitions, eq(reviewRuleConfigs.definitionId, reviewRuleDefinitions.id))
    .where(eq(reviewRuleConfigs.organizationId, orgId));
  const ruleConfigByKey = new Map(configuredRules.map((rule) => [rule.key, rule]));
  const lowConfidenceConfig = ruleConfigByKey.get("low_confidence_category")?.config as
    | { threshold?: number }
    | undefined;
  const receiptConfig = ruleConfigByKey.get("missing_receipt")?.config as
    | { threshold?: number; currency?: string }
    | undefined;
  const findings = evaluateBookRules({
    candidate: { ...input, originalCurrency, functionalCurrency, exchangeRate },
    lines: normalizedLines,
    accounts: ruleInputs.accountMap,
    party: ruleInputs.party,
    documents: ruleInputs.documents,
    settings: {
      lowConfidenceThreshold: String(
        lowConfidenceConfig?.threshold ?? settings.lowConfidenceThreshold,
      ),
      missingReceiptThreshold: String(receiptConfig?.threshold ?? settings.missingReceiptThreshold),
      missingReceiptCurrency: normalizeCurrency(
        receiptConfig?.currency ?? settings.missingReceiptCurrency,
      ),
      functionalCurrency,
    },
  })
    .filter((finding) => ruleConfigByKey.get(finding.ruleKey)?.enabled !== false)
    .map((finding) => ({
      ...finding,
      impact:
        (ruleConfigByKey.get(finding.ruleKey)?.impact as "blocking" | "warning" | undefined) ??
        finding.impact,
    }));
  if (findings.length > 0) {
    await db.insert(reviewFindings).values(
      findings.map((finding) => ({
        organizationId: orgId,
        inboxItemId: inboxItem.id,
        candidateId: candidate.id,
        ruleKey: finding.ruleKey,
        impact: finding.impact,
        subjectType: "transaction_candidate",
        subjectId: candidate.id,
        fingerprint: `${candidate.id}:${candidate.revision}:${finding.ruleKey}`,
        message: finding.message,
        evidence: finding.evidence,
      })),
    );
  }
  const duplicateDetection = await runDuplicateMatchingForSource(
    ctx,
    sourceRecord.id,
    "candidate_created",
  );
  const findingCount = findings.length + duplicateDetection.blockingCases.length;

  await db.insert(workflowEvents).values({
    organizationId: orgId,
    inboxItemId: inboxItem.id,
    entityType: "inbox_item",
    entityId: inboxItem.id,
    action: "submitted",
    actorType: "user",
    actorId: userId,
    idempotencyKey: `candidate:${candidate.id}:submitted`,
    data: { sourceChannel: input.sourceChannel ?? "manual", findingCount },
  });
  await insertActivityLog(
    {
      orgId,
      entityType: "inbox_item",
      entityId: inboxItem.id,
      action: "submitted",
      actorId: userId,
      changes: { candidateId: candidate.id, sourceRecordId: sourceRecord.id },
    },
    db,
  );

  return { inboxItem, candidate, findingCount, deduplicated: false };
}

export interface ApproveInboxInput {
  inboxItemId: string;
  expectedRevision: number;
  expectedLockVersion: number;
  overrideReason?: string | null;
}

export const DUPLICATE_APPROVAL_BLOCKED_MESSAGE =
  "Resolve the blocking Possible Duplicate case before approving this transaction.";

export type ApproveInboxResult =
  | {
      approvalOutcome: "approved";
      journalHeaderId: string;
      transactionNumber?: string;
      alreadyApproved: boolean;
    }
  | {
      approvalOutcome: "blocked";
      reason: "possible_duplicate";
      caseId: string;
      message: typeof DUPLICATE_APPROVAL_BLOCKED_MESSAGE;
    };

export async function approveInboxItem(
  ctx: InboxServiceContext,
  input: ApproveInboxInput,
): Promise<ApproveInboxResult> {
  const { db, orgId, userId, role } = ctx;
  const lifecycle = await lockInboxCandidateLifecycle(db, orgId, input.inboxItemId);
  if (!lifecycle) throw new Error("Inbox item not found.");
  const [sourceRow] = lifecycle.item.sourceRecordId
    ? await db
        .select({
          source: integrationSources,
          sourceRecordExternalId: sourceRecords.externalId,
        })
        .from(sourceRecords)
        .leftJoin(integrationSources, eq(sourceRecords.sourceId, integrationSources.id))
        .where(
          and(
            eq(sourceRecords.organizationId, orgId),
            eq(sourceRecords.id, lifecycle.item.sourceRecordId),
          ),
        )
        .limit(1)
    : [];
  const row = {
    ...lifecycle,
    source: sourceRow?.source ?? null,
    sourceRecordExternalId: sourceRow?.sourceRecordExternalId ?? null,
  };
  if (row.item.state === "approved" && row.candidate.postedJournalHeaderId) {
    return {
      approvalOutcome: "approved",
      journalHeaderId: row.candidate.postedJournalHeaderId,
      alreadyApproved: true,
    };
  }
  if (row.item.state !== "ready_for_review") {
    throw new Error(`This item cannot be approved while it is ${row.item.state}.`);
  }
  if (
    row.item.lockVersion !== input.expectedLockVersion ||
    row.item.candidateRevision !== input.expectedRevision
  ) {
    throw new Error("This Inbox item changed after you opened it. Refresh and review it again.");
  }

  const settings = await getAccountingSettings(db, orgId);
  if (settings.requireDifferentApprover && row.item.submittedBy === userId) {
    const ownerOverride =
      role === "owner" && settings.allowOwnerOverride && Boolean(input.overrideReason?.trim());
    if (!ownerOverride) {
      throw new Error(
        role === "owner"
          ? "The submitter cannot approve this transaction without an owner override reason."
          : "The submitter cannot approve their own transaction.",
      );
    }
  }

  const linkedCandidateSources = await db
    .select({
      sourceRecordId: transactionCandidateSources.sourceRecordId,
      relationship: transactionCandidateSources.relationship,
      isPrimary: transactionCandidateSources.isPrimary,
    })
    .from(transactionCandidateSources)
    .where(
      and(
        eq(transactionCandidateSources.organizationId, orgId),
        eq(transactionCandidateSources.candidateId, row.candidate.id),
      ),
    );
  const candidateSourceIds = [
    ...new Set(
      [
        row.candidate.sourceRecordId,
        row.item.sourceRecordId,
        ...linkedCandidateSources.map(({ sourceRecordId }) => sourceRecordId),
      ].filter((sourceRecordId): sourceRecordId is string => Boolean(sourceRecordId)),
    ),
  ];
  const primaryLinkedSourceRecordId =
    linkedCandidateSources.find(({ isPrimary }) => isPrimary)?.sourceRecordId ??
    row.candidate.sourceRecordId ??
    row.item.sourceRecordId ??
    candidateSourceIds[0] ??
    null;
  const candidateSources =
    candidateSourceIds.length > 0
      ? await db
          .select({
            id: sourceRecords.id,
            parentSourceRecordId: sourceRecords.parentSourceRecordId,
            recordType: sourceRecords.recordType,
            recordState: sourceRecords.recordState,
            economicEventClass: sourceRecords.economicEventClass,
            direction: sourceRecords.direction,
          })
          .from(sourceRecords)
          .where(
            and(
              eq(sourceRecords.organizationId, orgId),
              inArray(sourceRecords.id, candidateSourceIds),
            ),
          )
      : [];
  const accountingSources = candidateSources
    .filter(
      (source) =>
        source.recordState === "active" &&
        source.recordType !== "email" &&
        source.economicEventClass !== "other" &&
        source.direction !== "unknown",
    )
    .sort((left, right) => left.id.localeCompare(right.id));
  const originSourceRecordId =
    accountingSources.find(({ id }) => id === primaryLinkedSourceRecordId)?.id ??
    accountingSources.find(
      ({ parentSourceRecordId }) => parentSourceRecordId === primaryLinkedSourceRecordId,
    )?.id ??
    accountingSources[0]?.id ??
    primaryLinkedSourceRecordId;

  const openFindings = await db
    .select({ id: reviewFindings.id })
    .from(reviewFindings)
    .where(
      and(
        eq(reviewFindings.inboxItemId, row.item.id),
        eq(reviewFindings.state, "open"),
        eq(reviewFindings.impact, "blocking"),
        ne(reviewFindings.ruleKey, "possible_duplicate"),
      ),
    );
  if (openFindings.length > 0) {
    throw new Error(`Resolve the ${openFindings.length} blocking Book finding(s) before approval.`);
  }

  const period = await isDateInLockedPeriod(orgId, row.candidate.transactionDate, db);
  if (period.locked) {
    throw new Error(`The accounting period is locked through ${period.closedThrough}.`);
  }

  const lines = await db
    .select()
    .from(transactionCandidateLines)
    .where(
      and(
        eq(transactionCandidateLines.organizationId, orgId),
        eq(transactionCandidateLines.candidateId, row.candidate.id),
      ),
    )
    .orderBy(transactionCandidateLines.sortOrder);
  if (lines.length < 2 || lines.some((line) => !line.accountId)) {
    throw new Error("Every posting line must have an account before approval.");
  }
  const debits = sumMoney(lines.map((line) => line.functionalDebit));
  const credits = sumMoney(lines.map((line) => line.functionalCredit));
  if (compareMoney(debits, credits) !== 0) {
    throw new Error("The candidate is no longer balanced.");
  }

  if (candidateSourceIds.length > 0) {
    // Serialize approval against every linked source, including normalized
    // accounting children beneath an email container. A child that already
    // originated a journal must not evade the one-origin invariant merely
    // because the envelope was marked primary on the Inbox candidate.
    const lockedSources = await db
      .select({ id: sourceRecords.id })
      .from(sourceRecords)
      .where(
        and(eq(sourceRecords.organizationId, orgId), inArray(sourceRecords.id, candidateSourceIds)),
      )
      .orderBy(sourceRecords.id)
      .for("update");
    if (lockedSources.length !== candidateSourceIds.length) {
      throw new Error("One or more transaction sources are no longer available.");
    }
    const [existingOriginJournal] = await db
      .select({
        journalHeaderId: ledgerSourceLinks.journalHeaderId,
        transactionNumber: journalHeaders.transactionNumber,
      })
      .from(ledgerSourceLinks)
      .innerJoin(journalHeaders, eq(ledgerSourceLinks.journalHeaderId, journalHeaders.id))
      .where(
        and(
          eq(ledgerSourceLinks.organizationId, orgId),
          inArray(ledgerSourceLinks.sourceRecordId, candidateSourceIds),
          eq(ledgerSourceLinks.relationship, "origin"),
        ),
      )
      .limit(1);
    if (existingOriginJournal) {
      throw new Error(
        `This source already produced posted transaction ${
          existingOriginJournal.transactionNumber ?? existingOriginJournal.journalHeaderId
        }. Attach the new evidence or resolve the duplicate case instead.`,
      );
    }
  }

  // Duplicate matching is deliberately the final approval gate. It may create
  // or reopen a durable case and finding, so a blocked result is returned
  // instead of thrown here. The caller can commit this transaction and turn the
  // result into the existing user-facing error outside withOrgContext.
  const duplicateConfig = await loadDuplicateEngineConfig(db, orgId);
  const duplicateBlockingScore = duplicateConfig.blockingScore ?? 70;
  const duplicateAlgorithmVersion = duplicateConfig.algorithmVersion ?? DUPLICATE_MATCHER_VERSION;
  if (candidateSourceIds.length > 0 && duplicateConfig.enabled && duplicateConfig.mode !== "off") {
    for (const sourceRecordId of candidateSourceIds) {
      await runDuplicateMatchingForSource(ctx, sourceRecordId, "source_updated");
    }
    const [unresolvedDuplicateCase] = await db
      .select({ id: sourceMatchCandidates.id })
      .from(sourceMatchCandidates)
      .where(
        and(
          eq(sourceMatchCandidates.organizationId, orgId),
          eq(sourceMatchCandidates.state, "open"),
          eq(sourceMatchCandidates.matchClass, "duplicate"),
          eq(sourceMatchCandidates.disposition, "blocking"),
          eq(sourceMatchCandidates.algorithmVersion, duplicateAlgorithmVersion),
          or(
            sql`${sourceMatchCandidates.evidence}->>'reason' = 'exact_document'`,
            and(
              sql`${duplicateConfig.mode} = 'enforce'`,
              sql`${duplicateConfig.impact} = 'blocking'`,
              gte(sourceMatchCandidates.score, String(duplicateBlockingScore)),
            ),
          ),
          or(
            inArray(sourceMatchCandidates.leftSourceRecordId, candidateSourceIds),
            inArray(sourceMatchCandidates.rightSourceRecordId, candidateSourceIds),
          ),
        ),
      )
      .limit(1);
    if (unresolvedDuplicateCase) {
      return {
        approvalOutcome: "blocked",
        reason: "possible_duplicate",
        caseId: unresolvedDuplicateCase.id,
        message: DUPLICATE_APPROVAL_BLOCKED_MESSAGE,
      };
    }
  }

  const transactionNumber = await allocateJournalTransactionNumber(orgId, db);
  const [header] = await db
    .insert(journalHeaders)
    .values({
      organizationId: orgId,
      transactionNumber,
      idempotencyKey: `inbox:${row.item.id}:approve:${row.candidate.revision}`,
      transactionDate: row.candidate.transactionDate,
      transactionType: row.candidate
        .transactionType as typeof journalHeaders.$inferInsert.transactionType,
      source: journalSourceFor(row.source?.channel ?? "manual"),
      memo: row.candidate.memo,
      partyId: row.candidate.partyId,
      referenceNumber: row.candidate.referenceNumber,
      totalAmount: debits,
      functionalCurrency: row.candidate.functionalCurrency,
      transactionCurrency: row.candidate.originalCurrency,
      exchangeRateId: row.candidate.exchangeRateId,
      status: "posted",
      postedAt: new Date(),
      createdBy: userId,
    })
    .returning();
  await db.insert(journalLines).values(
    lines.map((line) => ({
      journalHeaderId: header.id,
      accountId: line.accountId!,
      debit: line.functionalDebit,
      credit: line.functionalCredit,
      originalDebit: line.originalDebit,
      originalCredit: line.originalCredit,
      originalCurrency: line.originalCurrency,
      exchangeRate: line.exchangeRate,
      exchangeRateId: row.candidate.exchangeRateId,
      lineDescription: line.lineDescription,
      partyId: line.partyId,
      departmentId: line.departmentId,
      locationId: line.locationId,
      sortOrder: line.sortOrder,
    })),
  );

  const sourceDocuments =
    candidateSourceIds.length > 0
      ? await db
          .select({ documentId: sourceRecordDocuments.documentId })
          .from(sourceRecordDocuments)
          .where(
            and(
              eq(sourceRecordDocuments.organizationId, orgId),
              inArray(sourceRecordDocuments.sourceRecordId, candidateSourceIds),
            ),
          )
      : [];
  const candidateDocuments = await db
    .select({ documentId: documentAttachments.documentId })
    .from(documentAttachments)
    .where(
      and(
        eq(documentAttachments.organizationId, orgId),
        eq(documentAttachments.linkableType, "transaction_candidate"),
        eq(documentAttachments.linkableId, row.candidate.id),
      ),
    );
  const documentIds = [
    ...new Set([
      ...sourceDocuments.map(({ documentId }) => documentId),
      ...candidateDocuments.map(({ documentId }) => documentId),
    ]),
  ];
  if (documentIds.length > 0) {
    await db.insert(documentAttachments).values(
      documentIds.map((documentId) => ({
        organizationId: orgId,
        documentId,
        linkableType: "journal_header",
        linkableId: header.id,
      })),
    );
  }
  if (candidateSourceIds.length > 0) {
    if (originSourceRecordId) {
      await db.insert(ledgerSourceLinks).values({
        organizationId: orgId,
        journalHeaderId: header.id,
        sourceRecordId: originSourceRecordId,
        relationship: "origin",
      });
    }
    const supportingSourceIds = candidateSourceIds.filter(
      (sourceRecordId) => sourceRecordId !== originSourceRecordId,
    );
    if (supportingSourceIds.length > 0) {
      await db
        .insert(ledgerSourceLinks)
        .values(
          supportingSourceIds.map((sourceRecordId) => ({
            organizationId: orgId,
            journalHeaderId: header.id,
            sourceRecordId,
            relationship: "supporting",
          })),
        )
        .onConflictDoNothing();
    }
  }
  if (row.candidate.candidateType === "bill" && row.sourceRecordExternalId) {
    await db
      .update(bills)
      .set({
        status: "awaiting_payment",
        journalHeaderId: header.id,
        approverId: userId,
        approvedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(bills.id, row.sourceRecordExternalId), eq(bills.organizationId, orgId)));
  }

  await db
    .update(transactionCandidates)
    .set({
      status: "posted",
      postedJournalHeaderId: header.id,
      updatedAt: new Date(),
    })
    .where(eq(transactionCandidates.id, row.candidate.id));
  await db
    .update(inboxItems)
    .set({
      state: "approved",
      resolvedBy: userId,
      resolvedAt: new Date(),
      resolutionNote: input.overrideReason?.trim() || null,
      lockVersion: row.item.lockVersion + 1,
      updatedAt: new Date(),
    })
    .where(eq(inboxItems.id, row.item.id));
  await db.insert(reviewDecisions).values({
    organizationId: orgId,
    inboxItemId: row.item.id,
    decision: input.overrideReason?.trim() ? "owner_override_approved" : "approved",
    actorId: userId,
    candidateRevision: row.candidate.revision,
    reason: input.overrideReason?.trim() || null,
    beforeState: row.item.state,
    afterState: "approved",
    journalHeaderId: header.id,
  });
  await db.insert(workflowEvents).values({
    organizationId: orgId,
    inboxItemId: row.item.id,
    entityType: "inbox_item",
    entityId: row.item.id,
    action: "approved",
    actorType: "user",
    actorId: userId,
    idempotencyKey: `inbox:${row.item.id}:approved:${row.candidate.revision}`,
    data: { journalHeaderId: header.id },
  });
  await insertActivityLog(
    {
      orgId,
      entityType: "transaction",
      entityId: header.id,
      action: "approved_from_inbox",
      actorId: userId,
      changes: { inboxItemId: row.item.id, transactionNumber },
    },
    db,
  );

  return {
    approvalOutcome: "approved",
    journalHeaderId: header.id,
    transactionNumber,
    alreadyApproved: false,
  };
}

export async function rejectInboxItem(
  ctx: InboxServiceContext,
  input: { inboxItemId: string; expectedLockVersion: number; reason: string },
) {
  const reason = input.reason.trim();
  if (!reason) throw new Error("A rejection reason is required.");
  const row = await lockInboxCandidateLifecycle(ctx.db, ctx.orgId, input.inboxItemId);
  if (!row) throw new Error("Inbox item not found.");
  const { item, candidate } = row;
  if (item.lockVersion !== input.expectedLockVersion) {
    throw new Error("This Inbox item changed after you opened it. Refresh and review it again.");
  }
  if (!["received", "needs_information", "ready_for_review", "failed"].includes(item.state)) {
    throw new Error(`This item cannot be rejected while it is ${item.state}.`);
  }
  if (candidate.status !== "current") {
    throw new Error("This transaction candidate is no longer rejectable.");
  }

  const linkedSources = await ctx.db
    .select({ sourceRecordId: transactionCandidateSources.sourceRecordId })
    .from(transactionCandidateSources)
    .where(
      and(
        eq(transactionCandidateSources.organizationId, ctx.orgId),
        eq(transactionCandidateSources.candidateId, candidate.id),
      ),
    );
  const sourceRecordIds = [
    ...new Set(
      [
        candidate.sourceRecordId,
        item.sourceRecordId,
        ...linkedSources.map(({ sourceRecordId }) => sourceRecordId),
      ].filter((sourceRecordId): sourceRecordId is string => Boolean(sourceRecordId)),
    ),
  ].sort();
  if (sourceRecordIds.length > 0) {
    const lockedSources = await ctx.db
      .select({ id: sourceRecords.id })
      .from(sourceRecords)
      .where(
        and(
          eq(sourceRecords.organizationId, ctx.orgId),
          inArray(sourceRecords.id, sourceRecordIds),
        ),
      )
      .orderBy(sourceRecords.id)
      .for("update");
    if (lockedSources.length !== sourceRecordIds.length) {
      throw new Error("One or more transaction sources are no longer available.");
    }
  }

  const [otherCandidateUses, ledgerUses] =
    sourceRecordIds.length > 0
      ? await Promise.all([
          ctx.db
            .select({
              compatibilitySourceId: transactionCandidates.sourceRecordId,
              linkedSourceId: transactionCandidateSources.sourceRecordId,
            })
            .from(transactionCandidates)
            .leftJoin(
              transactionCandidateSources,
              eq(transactionCandidateSources.candidateId, transactionCandidates.id),
            )
            .where(
              and(
                eq(transactionCandidates.organizationId, ctx.orgId),
                ne(transactionCandidates.id, candidate.id),
                inArray(transactionCandidates.status, ["current", "posted", "attached"]),
                or(
                  inArray(transactionCandidates.sourceRecordId, sourceRecordIds),
                  inArray(transactionCandidateSources.sourceRecordId, sourceRecordIds),
                ),
              ),
            ),
          ctx.db
            .select({ sourceRecordId: ledgerSourceLinks.sourceRecordId })
            .from(ledgerSourceLinks)
            .where(
              and(
                eq(ledgerSourceLinks.organizationId, ctx.orgId),
                inArray(ledgerSourceLinks.sourceRecordId, sourceRecordIds),
              ),
            ),
        ])
      : [[], []];
  const protectedSourceIds = new Set([
    ...otherCandidateUses.flatMap(({ compatibilitySourceId, linkedSourceId }) =>
      [compatibilitySourceId, linkedSourceId].filter((sourceRecordId): sourceRecordId is string =>
        Boolean(sourceRecordId),
      ),
    ),
    ...ledgerUses.map(({ sourceRecordId }) => sourceRecordId),
  ]);
  const rejectedSourceIds = sourceRecordIds.filter(
    (sourceRecordId) => !protectedSourceIds.has(sourceRecordId),
  );
  if (rejectedSourceIds.length > 0) {
    await ctx.db
      .update(sourceRecords)
      .set({ recordState: "rejected", updatedAt: new Date() })
      .where(
        and(
          eq(sourceRecords.organizationId, ctx.orgId),
          inArray(sourceRecords.id, rejectedSourceIds),
          eq(sourceRecords.recordState, "active"),
        ),
      );
  }

  const duplicateCases =
    rejectedSourceIds.length > 0
      ? await ctx.db
          .select()
          .from(sourceMatchCandidates)
          .where(
            and(
              eq(sourceMatchCandidates.organizationId, ctx.orgId),
              eq(sourceMatchCandidates.state, "open"),
              or(
                inArray(sourceMatchCandidates.leftSourceRecordId, rejectedSourceIds),
                inArray(sourceMatchCandidates.rightSourceRecordId, rejectedSourceIds),
              ),
            ),
          )
          .orderBy(sourceMatchCandidates.id)
          .for("update")
      : [];
  const duplicateCaseIds = duplicateCases.map(({ id }) => id);
  for (const duplicateCase of duplicateCases) {
    const [resolvedCase] = await ctx.db
      .update(sourceMatchCandidates)
      .set({
        state: "resolved",
        resolutionAction: "reject_source",
        resolutionReason: reason,
        resolvedBy: ctx.userId,
        resolvedAt: new Date(),
        lockVersion: duplicateCase.lockVersion + 1,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(sourceMatchCandidates.organizationId, ctx.orgId),
          eq(sourceMatchCandidates.id, duplicateCase.id),
          eq(sourceMatchCandidates.lockVersion, duplicateCase.lockVersion),
        ),
      )
      .returning({ id: sourceMatchCandidates.id });
    if (!resolvedCase) {
      throw new Error("A duplicate case changed while the source was being rejected.");
    }
  }

  const [rejectedCandidate] = await ctx.db
    .update(transactionCandidates)
    .set({ status: "rejected", updatedAt: new Date() })
    .where(
      and(
        eq(transactionCandidates.organizationId, ctx.orgId),
        eq(transactionCandidates.id, candidate.id),
        eq(transactionCandidates.status, "current"),
      ),
    )
    .returning({ id: transactionCandidates.id });
  if (!rejectedCandidate) {
    throw new Error("This transaction candidate changed while it was being rejected.");
  }
  const [rejectedItem] = await ctx.db
    .update(inboxItems)
    .set({
      state: "rejected",
      resolvedBy: ctx.userId,
      resolvedAt: new Date(),
      resolutionNote: reason,
      lockVersion: item.lockVersion + 1,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(inboxItems.organizationId, ctx.orgId),
        eq(inboxItems.id, item.id),
        eq(inboxItems.lockVersion, item.lockVersion),
      ),
    )
    .returning({ id: inboxItems.id });
  if (!rejectedItem) {
    throw new Error("This Inbox item changed while it was being rejected.");
  }
  await ctx.db
    .update(reviewFindings)
    .set({
      state: "resolved",
      resolvedBy: ctx.userId,
      resolvedAt: new Date(),
      resolutionNote: reason,
      lastSeenAt: new Date(),
    })
    .where(
      and(
        eq(reviewFindings.organizationId, ctx.orgId),
        eq(reviewFindings.state, "open"),
        or(
          eq(reviewFindings.inboxItemId, item.id),
          duplicateCaseIds.length > 0
            ? inArray(sql<string>`${reviewFindings.evidence}->>'caseId'`, duplicateCaseIds)
            : sql`false`,
        ),
      ),
    );
  await ctx.db.insert(reviewDecisions).values({
    organizationId: ctx.orgId,
    inboxItemId: item.id,
    decision: "rejected",
    actorId: ctx.userId,
    candidateRevision: item.candidateRevision,
    reason,
    beforeState: item.state,
    afterState: "rejected",
  });
  await ctx.db.insert(workflowEvents).values({
    organizationId: ctx.orgId,
    inboxItemId: item.id,
    entityType: "inbox_item",
    entityId: item.id,
    action: "rejected",
    actorType: "user",
    actorId: ctx.userId,
    idempotencyKey: `inbox:${item.id}:rejected:${item.candidateRevision}`,
    data: {
      reason,
      candidateId: candidate.id,
      rejectedSourceRecordIds: rejectedSourceIds,
      preservedSharedSourceRecordIds: [...protectedSourceIds],
      resolvedDuplicateCaseIds: duplicateCaseIds,
    },
  });
  await insertActivityLog(
    {
      orgId: ctx.orgId,
      entityType: "inbox_item",
      entityId: item.id,
      action: "rejected",
      actorId: ctx.userId,
      changes: {
        reason,
        candidateId: candidate.id,
        rejectedSourceRecordIds: rejectedSourceIds,
        resolvedDuplicateCaseIds: duplicateCaseIds,
      },
    },
    ctx.db,
  );
  return { id: item.id, state: "rejected" as const };
}
