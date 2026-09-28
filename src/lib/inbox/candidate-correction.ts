import { and, asc, eq, inArray, notInArray } from "drizzle-orm";
import type { DbExecutor } from "@/db";
import { accounts } from "@/db/schema/accounts";
import { dimensions } from "@/db/schema/dimensions";
import { documentAttachments, documents } from "@/db/schema/documents";
import {
  inboxItems,
  organizationAccountingSettings,
  reviewFindings,
  sourceRecordDocuments,
  sourceRecords,
  transactionCandidateLines,
  transactionCandidateSources,
  transactionCandidates,
  workflowEvents,
} from "@/db/schema/inbox";
import { parties } from "@/db/schema/parties";
import { mappedAccountFamilyIds } from "@/lib/coa/resolve-mapped-account";
import { insertActivityLog } from "@/lib/insert-activity-log";
import {
  DUPLICATE_MATCHER_VERSION,
  normalizeDuplicateMatchInput,
  type EconomicEventClass,
  type TransactionDirection,
} from "./duplicate-matcher";
import { runDuplicateMatchingForSource } from "./duplicate-engine";
import {
  directionForEconomicEventClass,
  isReviewerEditableEconomicEventSource,
  preserveAuthoritativeEconomicEvent,
} from "./economic-event";
import type { DocumentSourceFacts } from "./email-attachment-source";
import { resolveFxRate } from "./fx";
import { lockInboxCandidateLifecycle } from "./lifecycle-lock";
import {
  compareMoney,
  multiplyMoney,
  normalizeCurrency,
  parseMoneyToScaled,
  sumMoney,
} from "./money";
import type { BookRuleAccount } from "./rules";
import { evaluateCandidateRules, withRuleSetProvenance, type CandidateRuleInput } from "./rule-set";
import { recordShadowRuleEvaluation, resolveCandidateRuleSets } from "./rule-snapshots";
import type { CandidateLineInput, InboxServiceContext } from "./types";
import { enqueueCandidateClassification } from "./candidate-classification-job";
import { collectDocumentFacts, loadCandidateDocuments } from "./candidate-document-facts";
import { noteCorrectionOfMemoryAnswer, supersedeMemoryApplication } from "./memory/tracking";
import {
  PARTY_PAYMENT_DETAILS_CHANGED_RULE_KEY,
  raisePaymentDetailsFindingIfChanged,
} from "./payment-details-check";

/**
 * Lines the system wrote and a reviewer never touched: the unselected
 * placeholders enrichment creates, and the lines stage 2 classified from them
 * (src/lib/inbox/candidate-classification.ts) — by a model or by a memory.
 * New facts may replace these; any other line is a reviewer's and is never
 * overwritten.
 */
function isSystemGeneratedLine(line: {
  accountId: string | null;
  predictionEvidence: Record<string, unknown> | null;
}): boolean {
  const source = line.predictionEvidence?.source;
  if (source === "inbox_classification" || source === "memory") return true;
  return line.accountId === null && line.predictionEvidence?.accountSelection === "not_inferred";
}

/** How a person's correction settles the draft, for the memory undo check. */
function settledSide(line: { originalDebit: string | null }): "debit" | "credit" {
  return line.originalDebit !== null ? "debit" : "credit";
}

export interface CandidateCorrectionLineInput {
  accountId: string;
  debit?: string | null;
  credit?: string | null;
  lineDescription?: string | null;
  departmentId?: string | null;
  locationId?: string | null;
  /**
   * The line's counterparty. `null` clears it. Omitted, the line keeps the party it should have:
   * see resolveCorrectionLinePartyIds.
   */
  partyId?: string | null;
}

export interface CorrectInboxCandidateInput {
  inboxItemId: string;
  expectedRevision: number;
  expectedLockVersion: number;
  transactionDate: string;
  transactionType: "pay_in" | "pay_out" | "journal" | "transfer";
  economicEventClass?: EconomicEventClass;
  memo?: string | null;
  referenceNumber?: string | null;
  partyId?: string | null;
  originalCurrency: string;
  exchangeRate?: string | null;
  lines: CandidateCorrectionLineInput[];
}

export function isCandidateEnrichmentFactComplete(fact: DocumentSourceFacts): boolean {
  return (
    fact.originalAmount !== null &&
    fact.originalCurrency !== null &&
    fact.effectiveDate !== null &&
    fact.direction !== "unknown" &&
    fact.economicEventClass !== "other"
  );
}

/**
 * The counterparty each corrected line carries. A correction replaces every line, and until now
 * wrote none of their parties back, so the vendor fell off a bill's payable line (and any per-line
 * party off a journal) the moment a reviewer saved an edit.
 *
 * An explicit `partyId` (null included) wins. Otherwise a payable or receivable line takes the
 * entry's party — a payable is owed to the bill's vendor, which is how the Bills editor writes it —
 * and any other line keeps the party of the line it replaces: the unused previous line on the same
 * account and side. A line with no such predecessor has no party.
 */
export function resolveCorrectionLinePartyIds(
  lines: ReadonlyArray<{
    accountId: string;
    originalDebit: string | null;
    partyId?: string | null;
  }>,
  previousLines: ReadonlyArray<{
    accountId: string | null;
    originalDebit: string | null;
    partyId: string | null;
  }>,
  context: { entryPartyId: string | null; counterpartyAccountIds: ReadonlySet<string> },
): Array<string | null> {
  const unused = previousLines.map((line) => ({ line, used: false }));
  return lines.map((line) => {
    if (line.partyId !== undefined) return line.partyId;
    if (context.counterpartyAccountIds.has(line.accountId)) return context.entryPartyId;
    const isDebit = line.originalDebit !== null;
    const predecessor = unused.find(
      (entry) =>
        !entry.used &&
        entry.line.accountId === line.accountId &&
        (entry.line.originalDebit !== null) === isDebit,
    );
    if (!predecessor) return null;
    predecessor.used = true;
    return predecessor.line.partyId;
  });
}

/**
 * Payable and receivable accounts, by the aging reports' definition: the mapped A/P and A/R
 * accounts with everything under them, plus any account with either subtype. Shared with inbox
 * stage 2, which writes a remembered answer's lines the way a correction writes them.
 */
export async function counterpartyAccountIds(
  db: DbExecutor,
  orgId: string,
  orgAccounts: ReadonlyArray<{ id: string; subtype: string | null }>,
): Promise<Set<string>> {
  const [payables, receivables] = await Promise.all([
    mappedAccountFamilyIds(db, orgId, "bill", "accounts_payable"),
    mappedAccountFamilyIds(db, orgId, "invoice", "accounts_receivable"),
  ]);
  return new Set([
    ...payables,
    ...receivables,
    ...orgAccounts
      .filter(
        (account) =>
          account.subtype === "accounts_payable" || account.subtype === "account_receivable",
      )
      .map((account) => account.id),
  ]);
}

type NormalizedCorrectionLine = CandidateCorrectionLineInput & {
  originalDebit: string | null;
  originalCredit: string | null;
  functionalDebit: string | null;
  functionalCredit: string | null;
};

function normalizedPositiveAmount(value: string | null | undefined): string | null {
  if (value == null || value.trim() === "") return null;
  const normalized = value.trim();
  if (parseMoneyToScaled(normalized) <= 0n) {
    throw new Error("Posting amounts must be greater than zero.");
  }
  return normalized;
}

function requestedDirection(
  transactionType: CorrectInboxCandidateInput["transactionType"],
): TransactionDirection {
  if (transactionType === "pay_out") return "outflow";
  if (transactionType === "pay_in") return "inflow";
  if (transactionType === "transfer") return "neutral";
  return "unknown";
}

export function correctedSourceClassification(
  transactionType: CorrectInboxCandidateInput["transactionType"],
  candidateType: string,
  existingEconomicEventClass: string | null | undefined,
  options: {
    economicEventClass?: EconomicEventClass;
    sourceIsReviewerEditable?: boolean;
  } = {},
): { economicEventClass: EconomicEventClass; direction: TransactionDirection } {
  const inferred: {
    economicEventClass: EconomicEventClass;
    direction: TransactionDirection;
  } =
    candidateType === "bill"
      ? { economicEventClass: "bill_accrual", direction: "outflow" }
      : candidateType === "invoice"
        ? { economicEventClass: "invoice_accrual", direction: "inflow" }
        : transactionType === "pay_out"
          ? { economicEventClass: "purchase", direction: "outflow" }
          : transactionType === "pay_in"
            ? { economicEventClass: "sale", direction: "inflow" }
            : transactionType === "transfer"
              ? { economicEventClass: "transfer", direction: "neutral" }
              : {
                  economicEventClass: "other",
                  direction: requestedDirection(transactionType),
                };
  const requested = requestedDirection(transactionType);
  const explicitClass = options.economicEventClass;
  const proposed = explicitClass
    ? {
        economicEventClass: explicitClass,
        direction:
          explicitClass === "other" ? requested : directionForEconomicEventClass(explicitClass),
      }
    : inferred;
  if (
    explicitClass &&
    requested !== "unknown" &&
    proposed.direction !== "unknown" &&
    proposed.direction !== requested
  ) {
    throw new Error(
      `The selected ${explicitClass.replaceAll("_", " ")} event conflicts with the transaction type.`,
    );
  }
  const classified = preserveAuthoritativeEconomicEvent(proposed, existingEconomicEventClass, {
    // Merely editing accounts must never rewrite identity. An explicit reviewer
    // selection may replace classifications produced by email/document OCR.
    authoritative: explicitClass ? !options.sourceIsReviewerEditable : true,
  });
  if (explicitClass && classified.economicEventClass !== explicitClass) {
    throw new Error(
      `The source's ${classified.economicEventClass.replaceAll("_", " ")} economic event is provider-owned and cannot be changed.`,
    );
  }
  return classified;
}

function transactionTypeForDirection(
  direction: TransactionDirection,
): CorrectInboxCandidateInput["transactionType"] {
  if (direction === "outflow") return "pay_out";
  if (direction === "inflow") return "pay_in";
  if (direction === "neutral") return "transfer";
  return "journal";
}

export function selectCandidateEnrichmentFacts(
  facts: readonly DocumentSourceFacts[],
): DocumentSourceFacts | null {
  const complete = facts.filter(isCandidateEnrichmentFactComplete);
  return complete.length === 1 ? complete[0] : null;
}

/**
 * Copy one unambiguous attachment's economic facts to the review candidate.
 * The two balanced placeholder lines preserve the extracted amount but keep
 * both accounts null: a receipt cannot prove which bank, card, cash, AP, AR,
 * or category accounts represent the economic event.
 */
export async function enrichCandidateFromExtractedFacts(
  ctx: Pick<InboxServiceContext, "db" | "orgId">,
  candidateId: string,
  extractedFacts: readonly DocumentSourceFacts[],
) {
  const facts = selectCandidateEnrichmentFacts(extractedFacts);
  if (!facts) {
    const completeFactCount = extractedFacts.filter(isCandidateEnrichmentFactComplete).length;
    return {
      enriched: false,
      reason:
        completeFactCount > 1
          ? ("ambiguous_or_incomplete_attachments" as const)
          : ("no_complete_attachment" as const),
    };
  }

  const [row] = await ctx.db
    .select({ candidate: transactionCandidates, item: inboxItems })
    .from(transactionCandidates)
    .innerJoin(inboxItems, eq(inboxItems.candidateId, transactionCandidates.id))
    .where(
      and(
        eq(transactionCandidates.organizationId, ctx.orgId),
        eq(transactionCandidates.id, candidateId),
      ),
    )
    .for("update", { of: [transactionCandidates, inboxItems] })
    .limit(1);
  if (!row || row.candidate.status !== "current") {
    return { enriched: false, reason: "candidate_not_editable" as const };
  }

  const existingLines = await ctx.db
    .select({
      id: transactionCandidateLines.id,
      accountId: transactionCandidateLines.accountId,
      predictionEvidence: transactionCandidateLines.predictionEvidence,
    })
    .from(transactionCandidateLines)
    .where(
      and(
        eq(transactionCandidateLines.organizationId, ctx.orgId),
        eq(transactionCandidateLines.candidateId, row.candidate.id),
      ),
    )
    .orderBy(transactionCandidateLines.sortOrder);
  const transactionDate = facts.transactionDate ?? facts.effectiveDate!;
  const originalCurrency = facts.originalCurrency!;
  const originalTotal = facts.originalAmount!;
  const functionalTotal =
    originalCurrency === row.candidate.functionalCurrency ? originalTotal : null;
  const transactionType = transactionTypeForDirection(facts.direction);
  const referenceNumber = facts.normalizedReference ?? row.candidate.referenceNumber;
  const memo = facts.description.trim() || row.candidate.memo || "Extracted transaction";
  const hasSystemPlaceholderLines =
    existingLines.length === 2 && existingLines.every(isSystemGeneratedLine);
  if (existingLines.length > 0 && !hasSystemPlaceholderLines) {
    return { enriched: false, reason: "reviewer_lines_present" as const };
  }
  const alreadyApplied =
    row.candidate.transactionDate === transactionDate &&
    row.candidate.transactionType === transactionType &&
    row.candidate.originalCurrency === originalCurrency &&
    row.candidate.originalTotal !== null &&
    compareMoney(row.candidate.originalTotal, originalTotal) === 0 &&
    row.candidate.referenceNumber === referenceNumber &&
    row.candidate.memo === memo &&
    existingLines.length > 0;
  if (alreadyApplied) {
    return { enriched: false, reason: "already_enriched" as const };
  }

  const nextRevision = row.candidate.revision + 1;
  await ctx.db
    .update(transactionCandidates)
    .set({
      transactionDate,
      transactionType,
      memo,
      referenceNumber,
      originalCurrency,
      exchangeRateId: null,
      exchangeRate: "1",
      originalTotal,
      functionalTotal,
      revision: nextRevision,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(transactionCandidates.organizationId, ctx.orgId),
        eq(transactionCandidates.id, row.candidate.id),
      ),
    );
  if (hasSystemPlaceholderLines) {
    await ctx.db
      .delete(transactionCandidateLines)
      .where(
        and(
          eq(transactionCandidateLines.organizationId, ctx.orgId),
          eq(transactionCandidateLines.candidateId, row.candidate.id),
        ),
      );
    // New facts replace a memory's answer before anyone judged it: that
    // application ends without counting for or against the memory.
    if (existingLines.some((line) => line.predictionEvidence?.source === "memory")) {
      await supersedeMemoryApplication(ctx.db, {
        orgId: ctx.orgId,
        candidateId: row.candidate.id,
        inboxItemId: row.item.id,
        reason: "source_facts_reenriched",
      });
    }
  }
  if (existingLines.length === 0 || hasSystemPlaceholderLines) {
    const functionalAmount =
      originalCurrency === row.candidate.functionalCurrency ? originalTotal : null;
    await ctx.db.insert(transactionCandidateLines).values([
      {
        organizationId: ctx.orgId,
        candidateId: row.candidate.id,
        accountId: null,
        originalDebit: originalTotal,
        originalCredit: null,
        functionalDebit: functionalAmount,
        functionalCredit: null,
        originalCurrency,
        exchangeRate: "1",
        lineDescription: "Debit account — reviewer selection required",
        predictionEvidence: {
          source: "document_extraction",
          matcherInputHash: facts.matcherInputHash,
          accountSelection: "not_inferred",
        },
        sortOrder: 0,
      },
      {
        organizationId: ctx.orgId,
        candidateId: row.candidate.id,
        accountId: null,
        originalDebit: null,
        originalCredit: originalTotal,
        functionalDebit: null,
        functionalCredit: functionalAmount,
        originalCurrency,
        exchangeRate: "1",
        lineDescription: "Credit account — reviewer selection required",
        predictionEvidence: {
          source: "document_extraction",
          matcherInputHash: facts.matcherInputHash,
          accountSelection: "not_inferred",
        },
        sortOrder: 1,
      },
    ]);
  }
  await ctx.db
    .update(inboxItems)
    .set({
      state: "needs_information",
      title: memo.slice(0, 255),
      candidateRevision: nextRevision,
      lockVersion: row.item.lockVersion + 1,
      updatedAt: new Date(),
    })
    .where(and(eq(inboxItems.organizationId, ctx.orgId), eq(inboxItems.id, row.item.id)));
  // Stage 2 picks the category and the counterparty for the fresh
  // placeholders, in a background job so no model call runs inside this
  // transaction. Until it lands, the draft blocks on `uncategorized`.
  if (existingLines.length === 0 || hasSystemPlaceholderLines) {
    await enqueueCandidateClassification(ctx.db, {
      orgId: ctx.orgId,
      candidateId: row.candidate.id,
      candidateRevision: nextRevision,
    });
  }
  await ctx.db
    .insert(workflowEvents)
    .values({
      organizationId: ctx.orgId,
      inboxItemId: row.item.id,
      entityType: "transaction_candidate",
      entityId: row.candidate.id,
      action: "source_facts_enriched",
      actorType: "system",
      idempotencyKey: `candidate:${row.candidate.id}:source-facts:${facts.matcherInputHash}`,
      data: {
        sourceRecordExternalId: facts.externalId,
        matcherInputHash: facts.matcherInputHash,
        originalAmount: facts.originalAmount,
        originalCurrency: facts.originalCurrency,
        effectiveDate: facts.effectiveDate,
        reference: facts.normalizedReference,
        postingLinesCreated: existingLines.length === 0,
        accountSelection: "reviewer_required",
      },
    })
    .onConflictDoNothing();
  return { enriched: true, revision: nextRevision, facts };
}

async function loadCorrectionDocuments(
  db: DbExecutor,
  orgId: string,
  candidateId: string,
  sourceRecordIds: string[],
) {
  const sourceDocuments =
    sourceRecordIds.length > 0
      ? await db
          .select({
            id: documents.id,
            documentType: documents.documentType,
          })
          .from(sourceRecordDocuments)
          .innerJoin(documents, eq(sourceRecordDocuments.documentId, documents.id))
          .where(
            and(
              eq(sourceRecordDocuments.organizationId, orgId),
              eq(documents.organizationId, orgId),
              inArray(sourceRecordDocuments.sourceRecordId, sourceRecordIds),
            ),
          )
      : [];
  const candidateDocuments = await db
    .select({
      id: documents.id,
      documentType: documents.documentType,
    })
    .from(documentAttachments)
    .innerJoin(documents, eq(documentAttachments.documentId, documents.id))
    .where(
      and(
        eq(documentAttachments.organizationId, orgId),
        eq(documents.organizationId, orgId),
        eq(documentAttachments.linkableType, "transaction_candidate"),
        eq(documentAttachments.linkableId, candidateId),
      ),
    );
  return [
    ...new Map(
      [...sourceDocuments, ...candidateDocuments].map((document) => [document.id, document]),
    ).values(),
  ];
}

export async function correctInboxCandidate(
  ctx: InboxServiceContext,
  input: CorrectInboxCandidateInput,
) {
  if (input.lines.length < 2) throw new Error("At least two posting lines are required.");
  const { db, orgId, userId } = ctx;
  const row = await lockInboxCandidateLifecycle(db, orgId, input.inboxItemId);
  if (!row) throw new Error("Inbox item not found.");
  if (!["needs_information", "ready_for_review"].includes(row.item.state)) {
    throw new Error(`This item cannot be edited while it is ${row.item.state}.`);
  }
  if (row.candidate.status !== "current") {
    throw new Error("This transaction candidate is no longer editable.");
  }
  if (
    row.item.lockVersion !== input.expectedLockVersion ||
    row.item.candidateRevision !== input.expectedRevision ||
    row.candidate.revision !== input.expectedRevision
  ) {
    throw new Error("This Inbox item changed after you opened it. Refresh and review it again.");
  }

  const originalCurrency = normalizeCurrency(input.originalCurrency);
  const resolvedFx = await resolveFxRate({
    db,
    orgId,
    transactionDate: input.transactionDate,
    originalCurrency,
    functionalCurrency: row.candidate.functionalCurrency,
    suppliedRate: input.exchangeRate?.trim() || null,
    suppliedBySource: false,
    actorId: userId,
  });
  const normalizedLines: NormalizedCorrectionLine[] = input.lines.map((line, index) => {
    const originalDebit = normalizedPositiveAmount(line.debit);
    const originalCredit = normalizedPositiveAmount(line.credit);
    if ((originalDebit === null) === (originalCredit === null)) {
      throw new Error(`Line ${index + 1} must contain exactly one debit or credit amount.`);
    }
    return {
      ...line,
      lineDescription: line.lineDescription?.trim() || null,
      originalDebit,
      originalCredit,
      functionalDebit: originalDebit ? multiplyMoney(originalDebit, resolvedFx.rate) : null,
      functionalCredit: originalCredit ? multiplyMoney(originalCredit, resolvedFx.rate) : null,
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
    throw new Error("The accounting entry must have equal debits and credits.");
  }

  const accountIds = [...new Set(normalizedLines.map(({ accountId }) => accountId))];
  const orgAccounts = await db
    .select({
      id: accounts.id,
      accountType: accounts.accountType,
      subtype: accounts.subtype,
      parentId: accounts.parentId,
      isActive: accounts.isActive,
    })
    .from(accounts)
    .where(eq(accounts.organizationId, orgId));
  const accountById = new Map(orgAccounts.map((account) => [account.id, account]));
  if (accountIds.some((accountId) => !accountById.get(accountId)?.isActive)) {
    throw new Error("Every posting line must use an active account from this organization.");
  }
  const parentAccountIds = new Set(
    orgAccounts.flatMap((account) => (account.parentId ? [account.parentId] : [])),
  );
  if (accountIds.some((accountId) => parentAccountIds.has(accountId))) {
    throw new Error("Every posting line must use a leaf account.");
  }
  const departmentIds = [
    ...new Set(normalizedLines.flatMap(({ departmentId }) => (departmentId ? [departmentId] : []))),
  ];
  const locationIds = [
    ...new Set(normalizedLines.flatMap(({ locationId }) => (locationId ? [locationId] : []))),
  ];
  const dimensionIds = [...new Set([...departmentIds, ...locationIds])];
  const selectedDimensions =
    dimensionIds.length > 0
      ? await db
          .select({
            id: dimensions.id,
            dimensionType: dimensions.dimensionType,
          })
          .from(dimensions)
          .where(and(eq(dimensions.organizationId, orgId), inArray(dimensions.id, dimensionIds)))
      : [];
  const dimensionById = new Map(
    selectedDimensions.map((dimension) => [dimension.id, dimension.dimensionType]),
  );
  if (departmentIds.some((id) => dimensionById.get(id) !== "department")) {
    throw new Error("Every selected department must belong to this organization.");
  }
  if (locationIds.some((id) => dimensionById.get(id) !== "location")) {
    throw new Error("Every selected location must belong to this organization.");
  }

  const linkedSources = await db
    .select({
      sourceRecordId: transactionCandidateSources.sourceRecordId,
      relationship: transactionCandidateSources.relationship,
      isPrimary: transactionCandidateSources.isPrimary,
      recordType: sourceRecords.recordType,
      economicEventClass: sourceRecords.economicEventClass,
    })
    .from(transactionCandidateSources)
    .innerJoin(
      sourceRecords,
      and(
        eq(transactionCandidateSources.sourceRecordId, sourceRecords.id),
        eq(sourceRecords.organizationId, orgId),
      ),
    )
    .where(
      and(
        eq(transactionCandidateSources.organizationId, orgId),
        eq(transactionCandidateSources.candidateId, row.candidate.id),
      ),
    );
  const sourceRecordIds = [
    ...new Set(
      [
        row.candidate.sourceRecordId,
        row.item.sourceRecordId,
        ...linkedSources.map(({ sourceRecordId }) => sourceRecordId),
      ].filter((sourceRecordId): sourceRecordId is string => Boolean(sourceRecordId)),
    ),
  ];
  const economicOriginSources = linkedSources.filter(
    ({ relationship, recordType, economicEventClass }) =>
      relationship === "origin" && recordType !== "email" && economicEventClass !== "other",
  );
  if (economicOriginSources.length > 1) {
    throw new Error(
      "This Inbox item contains multiple economic origin records. Split or reject the source before editing one accounting entry.",
    );
  }
  const nonContainerSources = linkedSources.filter(({ recordType }) => recordType !== "email");
  const primarySourceRecordId =
    economicOriginSources.find(({ isPrimary }) => isPrimary)?.sourceRecordId ??
    economicOriginSources[0]?.sourceRecordId ??
    (nonContainerSources.length === 1 ? nonContainerSources[0]?.sourceRecordId : null) ??
    linkedSources.find(({ isPrimary }) => isPrimary)?.sourceRecordId ??
    row.candidate.sourceRecordId ??
    row.item.sourceRecordId ??
    null;
  const [party] = input.partyId
    ? await db
        .select({
          id: parties.id,
          name: parties.name,
          partyType: parties.partyType,
        })
        .from(parties)
        .where(and(eq(parties.organizationId, orgId), eq(parties.id, input.partyId)))
        .limit(1)
    : [];
  if (input.partyId && !party) {
    throw new Error("The selected vendor or customer does not belong to this organization.");
  }
  const linePartyIdsGiven = [
    ...new Set(normalizedLines.flatMap(({ partyId }) => (partyId ? [partyId] : []))),
  ];
  if (linePartyIdsGiven.length > 0) {
    const ownedLineParties = await db
      .select({ id: parties.id })
      .from(parties)
      .where(and(eq(parties.organizationId, orgId), inArray(parties.id, linePartyIdsGiven)));
    if (ownedLineParties.length !== linePartyIdsGiven.length) {
      throw new Error("Every line's vendor or customer must belong to this organization.");
    }
  }
  const previousLines = await db
    .select({
      accountId: transactionCandidateLines.accountId,
      originalDebit: transactionCandidateLines.originalDebit,
      partyId: transactionCandidateLines.partyId,
    })
    .from(transactionCandidateLines)
    .where(
      and(
        eq(transactionCandidateLines.organizationId, orgId),
        eq(transactionCandidateLines.candidateId, row.candidate.id),
      ),
    )
    .orderBy(asc(transactionCandidateLines.sortOrder));
  const linePartyIds = resolveCorrectionLinePartyIds(normalizedLines, previousLines, {
    entryPartyId: input.partyId ?? null,
    counterpartyAccountIds: await counterpartyAccountIds(db, orgId, orgAccounts),
  });
  const [primarySource] = primarySourceRecordId
    ? await db
        .select({
          rawData: sourceRecords.rawData,
          recordType: sourceRecords.recordType,
          economicEventClass: sourceRecords.economicEventClass,
        })
        .from(sourceRecords)
        .where(
          and(eq(sourceRecords.organizationId, orgId), eq(sourceRecords.id, primarySourceRecordId)),
        )
        .limit(1)
    : [];
  const classification = correctedSourceClassification(
    input.transactionType,
    row.candidate.candidateType,
    primarySource?.economicEventClass,
    {
      economicEventClass: input.economicEventClass,
      sourceIsReviewerEditable: isReviewerEditableEconomicEventSource(primarySource?.recordType),
    },
  );
  const economicEventChanged =
    Boolean(primarySource?.economicEventClass) &&
    primarySource?.economicEventClass !== classification.economicEventClass;
  const normalizedSource = normalizeDuplicateMatchInput({
    economicEventClass: classification.economicEventClass,
    direction: classification.direction,
    originalAmount: originalDebits,
    originalCurrency,
    effectiveDate: input.transactionDate,
    party: party?.name,
    reference: input.referenceNumber,
    description: input.memo,
  });

  await db
    .delete(transactionCandidateLines)
    .where(
      and(
        eq(transactionCandidateLines.organizationId, orgId),
        eq(transactionCandidateLines.candidateId, row.candidate.id),
      ),
    );
  await db.insert(transactionCandidateLines).values(
    normalizedLines.map((line, index) => ({
      organizationId: orgId,
      candidateId: row.candidate.id,
      accountId: line.accountId,
      originalDebit: line.originalDebit,
      originalCredit: line.originalCredit,
      functionalDebit: line.functionalDebit,
      functionalCredit: line.functionalCredit,
      originalCurrency,
      exchangeRate: resolvedFx.rate,
      lineDescription: line.lineDescription,
      partyId: linePartyIds[index],
      departmentId: line.departmentId,
      locationId: line.locationId,
      sortOrder: index,
    })),
  );

  const nextRevision = row.candidate.revision + 1;
  await db
    .update(transactionCandidates)
    .set({
      revision: nextRevision,
      transactionDate: input.transactionDate,
      transactionType: input.transactionType,
      memo: input.memo?.trim() || null,
      referenceNumber: input.referenceNumber?.trim() || null,
      partyId: input.partyId ?? null,
      originalCurrency,
      exchangeRateId: resolvedFx.id,
      exchangeRate: resolvedFx.rate,
      originalTotal: originalDebits,
      functionalTotal: functionalDebits,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(transactionCandidates.organizationId, orgId),
        eq(transactionCandidates.id, row.candidate.id),
      ),
    );
  if (primarySourceRecordId) {
    await db
      .update(sourceRecords)
      .set({
        transactionDate: input.transactionDate,
        description: input.memo?.trim() || null,
        amount: normalizedSource.originalAmount ?? originalDebits,
        currency: originalCurrency,
        economicEventClass: classification.economicEventClass,
        direction: classification.direction,
        originalAmount: normalizedSource.originalAmount ?? originalDebits,
        originalCurrency,
        functionalAmount: functionalDebits,
        functionalCurrency: row.candidate.functionalCurrency,
        effectiveDate: input.transactionDate,
        normalizedParty: normalizedSource.normalizedParty,
        normalizedReference: normalizedSource.normalizedReference,
        matcherInputHash: normalizedSource.inputHash,
        matcherVersion: DUPLICATE_MATCHER_VERSION,
        rawData: {
          ...primarySource?.rawData,
          reviewerCorrection: {
            candidateId: row.candidate.id,
            candidateRevision: nextRevision,
            correctedBy: userId,
            correctedAt: new Date().toISOString(),
            economicEventClassBefore: primarySource?.economicEventClass ?? null,
            economicEventClassAfter: classification.economicEventClass,
          },
        },
        updatedAt: new Date(),
      })
      .where(
        and(eq(sourceRecords.organizationId, orgId), eq(sourceRecords.id, primarySourceRecordId)),
      );
  }

  // A changed payee bank account is never cleared by an edit: a reviewer
  // resolves it explicitly, with a note, like a possible duplicate.
  await db
    .update(reviewFindings)
    .set({
      state: "resolved",
      resolvedBy: userId,
      resolvedAt: new Date(),
      resolutionNote: "Re-evaluated after the accounting entry was corrected.",
    })
    .where(
      and(
        eq(reviewFindings.organizationId, orgId),
        eq(reviewFindings.inboxItemId, row.item.id),
        eq(reviewFindings.state, "open"),
        notInArray(reviewFindings.ruleKey, [
          "possible_duplicate",
          PARTY_PAYMENT_DETAILS_CHANGED_RULE_KEY,
        ]),
      ),
    );

  const childCounts = new Map<string, number>();
  for (const account of orgAccounts) {
    if (account.parentId) {
      childCounts.set(account.parentId, (childCounts.get(account.parentId) ?? 0) + 1);
    }
  }
  const ruleAccounts = new Map<string, BookRuleAccount>();
  for (const accountId of accountIds) {
    const account = accountById.get(accountId)!;
    ruleAccounts.set(accountId, {
      id: account.id,
      accountType: account.accountType,
      subtype: account.subtype,
      childCount: childCounts.get(account.id) ?? 0,
    });
  }
  const [settings] = await db
    .select()
    .from(organizationAccountingSettings)
    .where(eq(organizationAccountingSettings.organizationId, orgId))
    .limit(1);
  if (!settings) throw new Error("Accounting settings are not configured.");
  // The paper's routine decides the rules: its pinned snapshot when it has
  // one, live configs otherwise. A shadow snapshot is evaluated below and only
  // ever logged.
  const ruleSets = await resolveCandidateRuleSets(db, orgId, row.candidate.id, {
    lowConfidenceThreshold: settings.lowConfidenceThreshold,
    missingReceiptThreshold: settings.missingReceiptThreshold,
    missingReceiptCurrency: settings.missingReceiptCurrency,
  });
  const correctionLines: CandidateLineInput[] = normalizedLines.map((line) => ({
    accountId: line.accountId,
    debit: line.originalDebit,
    credit: line.originalCredit,
    departmentId: line.departmentId,
    locationId: line.locationId,
    lineDescription: line.lineDescription,
  }));
  const candidateDocuments = await loadCorrectionDocuments(
    db,
    orgId,
    row.candidate.id,
    sourceRecordIds,
  );
  const ruleInput: CandidateRuleInput = {
    candidate: {
      transactionDate: input.transactionDate,
      transactionType: input.transactionType,
      memo: input.memo,
      partyId: input.partyId ?? null,
      referenceNumber: input.referenceNumber,
      originalCurrency,
      functionalCurrency: row.candidate.functionalCurrency,
      exchangeRate: resolvedFx.rate,
      lines: correctionLines,
    },
    lines: correctionLines,
    accounts: ruleAccounts,
    party: party ? { id: party.id, partyType: party.partyType } : null,
    documents: candidateDocuments,
    functionalCurrency: row.candidate.functionalCurrency,
  };
  const enforcedFindings = evaluateCandidateRules(ruleSets.active, ruleInput);
  const findings = withRuleSetProvenance(enforcedFindings, ruleSets.active.provenance);
  if (findings.length > 0) {
    await db.insert(reviewFindings).values(
      findings.map((finding) => ({
        organizationId: orgId,
        inboxItemId: row.item.id,
        candidateId: row.candidate.id,
        ruleKey: finding.ruleKey,
        impact: finding.impact,
        subjectType: "transaction_candidate",
        subjectId: row.candidate.id,
        fingerprint: `${row.candidate.id}:${nextRevision}:${finding.ruleKey}`,
        message: finding.message,
        evidence: finding.evidence,
      })),
    );
  }
  // Shadow rules are evaluated on the same draft and only ever logged.
  if (ruleSets.shadow) {
    await recordShadowRuleEvaluation(db, {
      orgId,
      inboxItemId: row.item.id,
      candidateId: row.candidate.id,
      candidateRevision: nextRevision,
      active: ruleSets.active,
      activeFindings: enforcedFindings,
      shadow: ruleSets.shadow,
      shadowFindings: withRuleSetProvenance(
        evaluateCandidateRules(ruleSets.shadow, ruleInput),
        ruleSets.shadow.provenance,
      ),
    });
  }
  // However the payee got linked, a document asking to be paid somewhere
  // other than the payee's stored bank account needs a human. A system rule:
  // no rule set, live or pinned, can switch it off.
  if (party && ["vendor", "both", "employee"].includes(party.partyType)) {
    await raisePaymentDetailsFindingIfChanged(db, {
      orgId,
      inboxItemId: row.item.id,
      candidateId: row.candidate.id,
      partyId: party.id,
      facts: collectDocumentFacts(
        await loadCandidateDocuments(db, orgId, row.candidate.id, primarySourceRecordId),
        { from: null },
      ),
    });
  }

  const title =
    input.memo?.trim() ||
    input.referenceNumber?.trim() ||
    `${input.transactionType.replace("_", " ")} ${originalCurrency} ${originalDebits}`;
  const [updatedItem] = await db
    .update(inboxItems)
    .set({
      state: "ready_for_review",
      title: title.slice(0, 255),
      candidateRevision: nextRevision,
      lockVersion: row.item.lockVersion + 1,
      updatedAt: new Date(),
    })
    .where(and(eq(inboxItems.organizationId, orgId), eq(inboxItems.id, row.item.id)))
    .returning();
  await db.insert(workflowEvents).values({
    organizationId: orgId,
    inboxItemId: row.item.id,
    entityType: "transaction_candidate",
    entityId: row.candidate.id,
    action: "candidate_corrected",
    actorType: "user",
    actorId: userId,
    data: {
      previousRevision: row.candidate.revision,
      candidateRevision: nextRevision,
      lineCount: normalizedLines.length,
      originalTotal: originalDebits,
      originalCurrency,
      functionalTotal: functionalDebits,
      functionalCurrency: row.candidate.functionalCurrency,
      sourceRecordId: primarySourceRecordId,
      economicEventClassBefore: primarySource?.economicEventClass ?? null,
      economicEventClassAfter: classification.economicEventClass,
      economicEventChanged,
      ruleSet: ruleSets.active.provenance,
    },
  });
  await insertActivityLog(
    {
      orgId,
      entityType: "inbox_item",
      entityId: row.item.id,
      action: "candidate_corrected",
      actorId: userId,
      changes: {
        candidateId: row.candidate.id,
        previousRevision: row.candidate.revision,
        candidateRevision: nextRevision,
        lineCount: normalizedLines.length,
        originalTotal: originalDebits,
        originalCurrency,
        economicEventClassBefore: primarySource?.economicEventClass ?? null,
        economicEventClassAfter: classification.economicEventClass,
        economicEventChanged,
      },
    },
    db,
  );

  // A correction that departs from what a memory answered this draft is an
  // undo for that memory (src/lib/inbox/memory/tracking.ts).
  const memory = await noteCorrectionOfMemoryAnswer(db, {
    orgId,
    candidateId: row.candidate.id,
    inboxItemId: row.item.id,
    userId,
    settled: {
      docKind: classification.economicEventClass,
      partyId: input.partyId ?? null,
      lines: normalizedLines.map((line) => ({
        side: settledSide(line),
        accountId: line.accountId,
      })),
    },
  });

  for (const sourceRecordId of sourceRecordIds) {
    await runDuplicateMatchingForSource(ctx, sourceRecordId, "source_updated");
  }
  return {
    inboxItem: updatedItem,
    candidateId: row.candidate.id,
    candidateRevision: nextRevision,
    findingCount: findings.length,
    memory,
  };
}
