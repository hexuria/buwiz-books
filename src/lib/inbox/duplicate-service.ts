import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";
import type { DbExecutor } from "@/db";
import { accounts } from "@/db/schema/accounts";
import { documentAttachments, documents } from "@/db/schema/documents";
import {
  inboxItems,
  integrationSources,
  ledgerSourceLinks,
  reviewFindings,
  sourceMatchCandidates,
  sourceRecordDocuments,
  sourceRecords,
  transactionCandidateLines,
  transactionCandidates,
  transactionCandidateSources,
  workflowEvents,
} from "@/db/schema/inbox";
import { journalHeaders, journalLines } from "@/db/schema/journals";
import { parties } from "@/db/schema/parties";
import { insertActivityLog } from "@/lib/insert-activity-log";
import type { InboxServiceContext } from "./types";

export const DUPLICATE_RESOLUTION_ACTIONS = [
  "consolidate_candidates",
  "attach_to_posted",
  "keep_separate",
  "merge_posted",
  "reject_source",
] as const;

export type DuplicateResolutionAction = (typeof DUPLICATE_RESOLUTION_ACTIONS)[number];

export interface DuplicateResolutionInput {
  caseId: string;
  action: DuplicateResolutionAction;
  canonicalId?: string | null;
  reason?: string | null;
  expectedVersion: number;
  idempotencyKey: string;
}

interface DuplicateSide {
  source: typeof sourceRecords.$inferSelect;
  provider: {
    provider: string;
    channel: string;
    name: string;
  } | null;
  candidates: Array<{
    candidate: typeof transactionCandidates.$inferSelect;
    partyName: string | null;
    inboxItem: typeof inboxItems.$inferSelect | null;
  }>;
  journals: Array<typeof journalHeaders.$inferSelect>;
  documents: Array<{
    id: string;
    filename: string;
    displayTitle: string | null;
    documentType: string;
    contentHash: string | null;
  }>;
}

function isPrivilegedRole(role: string): boolean {
  return role === "owner" || role === "admin" || role === "superuser";
}

function currentCandidate(side: DuplicateSide) {
  return (
    side.candidates.find(({ candidate }) => candidate.status === "current") ??
    side.candidates.find(({ candidate }) => candidate.status === "posted") ??
    side.candidates[0] ??
    null
  );
}

function activeJournal(side: DuplicateSide) {
  return (
    side.journals.find((journal) => journal.duplicateOfHeaderId === null) ??
    side.journals[0] ??
    null
  );
}

async function getDuplicateSide(
  db: DbExecutor,
  orgId: string,
  sourceRecordId: string,
): Promise<DuplicateSide> {
  const [sourceRow] = await db
    .select({
      source: sourceRecords,
      provider: integrationSources.provider,
      channel: integrationSources.channel,
      sourceName: integrationSources.name,
    })
    .from(sourceRecords)
    .leftJoin(
      integrationSources,
      and(
        eq(sourceRecords.sourceId, integrationSources.id),
        eq(integrationSources.organizationId, orgId),
      ),
    )
    .where(and(eq(sourceRecords.organizationId, orgId), eq(sourceRecords.id, sourceRecordId)))
    .limit(1);
  if (!sourceRow) throw new Error("Duplicate source record was not found.");

  const candidateRows = await db
    .select({
      candidate: transactionCandidates,
      partyName: parties.name,
      inboxItem: inboxItems,
    })
    .from(transactionCandidates)
    .leftJoin(
      transactionCandidateSources,
      and(
        eq(transactionCandidateSources.candidateId, transactionCandidates.id),
        eq(transactionCandidateSources.sourceRecordId, sourceRecordId),
        eq(transactionCandidateSources.organizationId, orgId),
      ),
    )
    .leftJoin(
      parties,
      and(eq(transactionCandidates.partyId, parties.id), eq(parties.organizationId, orgId)),
    )
    .leftJoin(
      inboxItems,
      and(
        eq(inboxItems.candidateId, transactionCandidates.id),
        eq(inboxItems.organizationId, orgId),
      ),
    )
    .where(
      and(
        eq(transactionCandidates.organizationId, orgId),
        or(
          eq(transactionCandidates.sourceRecordId, sourceRecordId),
          eq(transactionCandidateSources.sourceRecordId, sourceRecordId),
        ),
      ),
    )
    .orderBy(desc(transactionCandidates.updatedAt));

  const journals = await db
    .select({ journal: journalHeaders })
    .from(ledgerSourceLinks)
    .innerJoin(journalHeaders, eq(ledgerSourceLinks.journalHeaderId, journalHeaders.id))
    .where(
      and(
        eq(ledgerSourceLinks.organizationId, orgId),
        eq(ledgerSourceLinks.sourceRecordId, sourceRecordId),
        eq(journalHeaders.organizationId, orgId),
      ),
    )
    .orderBy(desc(journalHeaders.createdAt));

  const sourceDocuments = await db
    .select({
      id: documents.id,
      filename: documents.originalFilename,
      displayTitle: documents.displayTitle,
      documentType: documents.documentType,
      contentHash: documents.contentHash,
    })
    .from(sourceRecordDocuments)
    .innerJoin(
      documents,
      and(eq(sourceRecordDocuments.documentId, documents.id), eq(documents.organizationId, orgId)),
    )
    .where(
      and(
        eq(sourceRecordDocuments.organizationId, orgId),
        eq(sourceRecordDocuments.sourceRecordId, sourceRecordId),
      ),
    )
    .orderBy(asc(documents.createdAt));

  return {
    source: sourceRow.source,
    provider:
      sourceRow.provider && sourceRow.channel
        ? {
            provider: sourceRow.provider,
            channel: sourceRow.channel,
            name: sourceRow.sourceName ?? sourceRow.provider,
          }
        : null,
    candidates: candidateRows,
    journals: journals.map(({ journal }) => journal),
    documents: sourceDocuments,
  };
}

async function getCandidateLines(db: DbExecutor, orgId: string, candidateId: string | null) {
  if (!candidateId) return [];
  return db
    .select({
      id: transactionCandidateLines.id,
      accountId: transactionCandidateLines.accountId,
      accountNumber: accounts.accountNumber,
      accountName: accounts.name,
      originalDebit: transactionCandidateLines.originalDebit,
      originalCredit: transactionCandidateLines.originalCredit,
      functionalDebit: transactionCandidateLines.functionalDebit,
      functionalCredit: transactionCandidateLines.functionalCredit,
      originalCurrency: transactionCandidateLines.originalCurrency,
      lineDescription: transactionCandidateLines.lineDescription,
      sortOrder: transactionCandidateLines.sortOrder,
    })
    .from(transactionCandidateLines)
    .leftJoin(
      accounts,
      and(eq(transactionCandidateLines.accountId, accounts.id), eq(accounts.organizationId, orgId)),
    )
    .where(
      and(
        eq(transactionCandidateLines.organizationId, orgId),
        eq(transactionCandidateLines.candidateId, candidateId),
      ),
    )
    .orderBy(asc(transactionCandidateLines.sortOrder));
}

async function getJournalLines(db: DbExecutor, orgId: string, journalHeaderId: string | null) {
  if (!journalHeaderId) return [];
  return db
    .select({
      id: journalLines.id,
      accountId: journalLines.accountId,
      accountNumber: accounts.accountNumber,
      accountName: accounts.name,
      debit: journalLines.debit,
      credit: journalLines.credit,
      originalDebit: journalLines.originalDebit,
      originalCredit: journalLines.originalCredit,
      originalCurrency: journalLines.originalCurrency,
      lineDescription: journalLines.lineDescription,
      sortOrder: journalLines.sortOrder,
    })
    .from(journalLines)
    .leftJoin(
      accounts,
      and(eq(journalLines.accountId, accounts.id), eq(accounts.organizationId, orgId)),
    )
    .where(eq(journalLines.journalHeaderId, journalHeaderId))
    .orderBy(asc(journalLines.sortOrder));
}

export async function getDuplicateCase(
  ctx: Pick<InboxServiceContext, "db" | "orgId">,
  caseId: string,
) {
  const { db, orgId } = ctx;
  const [duplicateCase] = await db
    .select()
    .from(sourceMatchCandidates)
    .where(
      and(eq(sourceMatchCandidates.organizationId, orgId), eq(sourceMatchCandidates.id, caseId)),
    )
    .limit(1);
  if (!duplicateCase) throw new Error("Duplicate case not found.");

  const left = await getDuplicateSide(db, orgId, duplicateCase.leftSourceRecordId);
  const right = await getDuplicateSide(db, orgId, duplicateCase.rightSourceRecordId);
  const leftCandidate = currentCandidate(left)?.candidate ?? null;
  const rightCandidate = currentCandidate(right)?.candidate ?? null;
  const leftJournal = activeJournal(left);
  const rightJournal = activeJournal(right);
  const [leftCandidateLines, rightCandidateLines, leftJournalLines, rightJournalLines] =
    await Promise.all([
      getCandidateLines(db, orgId, leftCandidate?.id ?? null),
      getCandidateLines(db, orgId, rightCandidate?.id ?? null),
      getJournalLines(db, orgId, leftJournal?.id ?? null),
      getJournalLines(db, orgId, rightJournal?.id ?? null),
    ]);

  return {
    case: duplicateCase,
    left: {
      ...left,
      candidate: currentCandidate(left) ?? null,
      journal: leftJournal,
      candidateLines: leftCandidateLines,
      journalLines: leftJournalLines,
    },
    right: {
      ...right,
      candidate: currentCandidate(right) ?? null,
      journal: rightJournal,
      candidateLines: rightCandidateLines,
      journalLines: rightJournalLines,
    },
  };
}

function validateResolution(
  detail: Awaited<ReturnType<typeof getDuplicateCase>>,
  input: Pick<DuplicateResolutionInput, "action" | "canonicalId" | "reason">,
  role: string,
) {
  const leftCandidate = detail.left.candidate?.candidate ?? null;
  const rightCandidate = detail.right.candidate?.candidate ?? null;
  const leftJournal = detail.left.journal;
  const rightJournal = detail.right.journal;
  const reason = input.reason?.trim() ?? "";
  const errors: string[] = [];
  const warnings: string[] = [];
  const isActiveInboxCandidate = (
    candidate: {
      candidate: typeof transactionCandidates.$inferSelect;
      inboxItem: typeof inboxItems.$inferSelect | null;
    } | null,
  ) =>
    Boolean(
      candidate &&
      candidate.candidate.status === "current" &&
      candidate.inboxItem &&
      ["received", "needs_information", "ready_for_review"].includes(candidate.inboxItem.state),
    );

  if (input.action === "merge_posted" && !isPrivilegedRole(role)) {
    errors.push("Only an owner or administrator can merge posted transactions.");
  }
  if (input.action !== "merge_posted" && leftJournal && rightJournal && !isPrivilegedRole(role)) {
    errors.push(
      "Only an owner or administrator can resolve a duplicate case between posted transactions.",
    );
  }
  if (input.action === "reject_source" && !isPrivilegedRole(role)) {
    errors.push("Only an owner or administrator can reject source evidence.");
  }
  if (
    input.action === "consolidate_candidates" &&
    (!leftCandidate ||
      !rightCandidate ||
      !isActiveInboxCandidate(detail.left.candidate) ||
      !isActiveInboxCandidate(detail.right.candidate) ||
      leftCandidate.postedJournalHeaderId ||
      rightCandidate.postedJournalHeaderId)
  ) {
    errors.push("Candidate consolidation requires two unposted Inbox candidates.");
  }
  if (
    input.action === "consolidate_candidates" &&
    input.canonicalId !== leftCandidate?.id &&
    input.canonicalId !== rightCandidate?.id
  ) {
    errors.push("Select which Inbox candidate should be retained.");
  }
  if (
    input.action === "attach_to_posted" &&
    input.canonicalId !== leftJournal?.id &&
    input.canonicalId !== rightJournal?.id
  ) {
    errors.push("Select the posted transaction that should receive this evidence.");
  }
  if (
    input.action === "attach_to_posted" &&
    ((!leftJournal && !rightJournal) ||
      (leftJournal && rightJournal) ||
      (!leftCandidate && !rightCandidate))
  ) {
    errors.push("Evidence attachment requires one posted transaction and one unposted candidate.");
  }
  if (input.action === "attach_to_posted" && (leftJournal || rightJournal)) {
    const candidateToAttach =
      input.canonicalId === leftJournal?.id ? detail.right.candidate : detail.left.candidate;
    const candidateRecord = candidateToAttach?.candidate ?? null;
    if (
      !isActiveInboxCandidate(candidateToAttach) ||
      !candidateRecord ||
      candidateRecord.postedJournalHeaderId
    ) {
      errors.push("Select an unposted Inbox candidate to attach to the posted transaction.");
    }
  }
  if (
    input.action === "merge_posted" &&
    (!leftJournal ||
      !rightJournal ||
      (input.canonicalId !== leftJournal.id && input.canonicalId !== rightJournal.id))
  ) {
    errors.push("Posted merge requires two posted transactions and an explicit canonical one.");
  }
  if (
    input.action === "reject_source" &&
    (!input.canonicalId ||
      ![detail.left.source.id, detail.right.source.id, leftCandidate?.id, rightCandidate?.id]
        .filter((id): id is string => Boolean(id))
        .includes(input.canonicalId))
  ) {
    errors.push("Select the incoming source or candidate to reject.");
  }
  if (input.action === "reject_source" && input.canonicalId) {
    const rejectLeft =
      input.canonicalId === detail.left.source.id || input.canonicalId === leftCandidate?.id;
    const rejectedSide = rejectLeft ? detail.left : detail.right;
    const rejectedCandidateDetail = rejectedSide.candidate;
    const rejectedCandidate = rejectedCandidateDetail?.candidate ?? null;
    if (
      rejectedSide.journals.length > 0 ||
      rejectedCandidate?.postedJournalHeaderId ||
      rejectedCandidate?.status === "posted" ||
      rejectedCandidate?.status === "attached"
    ) {
      errors.push(
        "Posted accounting evidence cannot be rejected. Attach it, keep it separate, or use the posted merge workflow.",
      );
    }
    if (rejectedCandidate && !isActiveInboxCandidate(rejectedCandidateDetail)) {
      errors.push("Only an active, unposted Inbox candidate can be rejected.");
    }
  }
  if (
    (input.action === "keep_separate" ||
      input.action === "merge_posted" ||
      input.action === "reject_source") &&
    reason.length < 3
  ) {
    errors.push("Enter a reason with at least 3 characters.");
  }

  if (input.action === "consolidate_candidates") {
    warnings.push("Accounting fields and posting lines will not be combined automatically.");
  }
  if (input.action === "attach_to_posted") {
    warnings.push("The unposted candidate will close without creating a second journal.");
  }
  if (input.action === "merge_posted") {
    warnings.push(
      "Both journals remain in the audit trail; reports count only the canonical journal.",
    );
  }
  if (input.action === "keep_separate") {
    warnings.push(
      "This pair will stay separated until its matcher inputs or algorithm version changes.",
    );
  }

  return { errors, warnings };
}

export async function previewDuplicateResolution(
  ctx: InboxServiceContext,
  input: Pick<DuplicateResolutionInput, "caseId" | "action" | "canonicalId" | "reason">,
) {
  const detail = await getDuplicateCase(ctx, input.caseId);
  const validation = validateResolution(detail, input, ctx.role);
  let journalMergePreview: Awaited<
    ReturnType<(typeof import("@/lib/journal-merge"))["previewDuplicateJournalMerge"]>
  > | null = null;

  if (input.action === "merge_posted" && validation.errors.length === 0) {
    const leftJournal = detail.left.journal!;
    const rightJournal = detail.right.journal!;
    const canonicalJournal = input.canonicalId === leftJournal.id ? leftJournal : rightJournal;
    const duplicateJournal = canonicalJournal.id === leftJournal.id ? rightJournal : leftJournal;
    try {
      const { previewDuplicateJournalMerge } = await import("@/lib/journal-merge");
      journalMergePreview = await previewDuplicateJournalMerge(
        { db: ctx.db, orgId: ctx.orgId },
        {
          canonicalJournalId: canonicalJournal.id,
          duplicateJournalId: duplicateJournal.id,
        },
      );
      validation.errors.push(...journalMergePreview.blockers);
    } catch (error) {
      validation.errors.push(
        error instanceof Error ? error.message : "Unable to validate this journal merge.",
      );
    }
  }

  return {
    action: input.action,
    caseId: detail.case.id,
    expectedVersion: detail.case.lockVersion,
    allowed: validation.errors.length === 0,
    ...validation,
    canonicalId: input.canonicalId ?? null,
    journalMergePreview,
  };
}

async function sourceIdsForCandidate(
  db: DbExecutor,
  orgId: string,
  candidate: typeof transactionCandidates.$inferSelect,
) {
  const linked = await db
    .select({ sourceRecordId: transactionCandidateSources.sourceRecordId })
    .from(transactionCandidateSources)
    .where(
      and(
        eq(transactionCandidateSources.organizationId, orgId),
        eq(transactionCandidateSources.candidateId, candidate.id),
      ),
    );
  return [
    ...new Set([
      ...linked.map(({ sourceRecordId }) => sourceRecordId),
      ...(candidate.sourceRecordId ? [candidate.sourceRecordId] : []),
    ]),
  ];
}

async function copyCandidateEvidence(
  db: DbExecutor,
  orgId: string,
  sourceCandidate: typeof transactionCandidates.$inferSelect,
  canonicalCandidateId: string,
) {
  const sourceIds = await sourceIdsForCandidate(db, orgId, sourceCandidate);
  if (sourceIds.length === 0) return { sourceIds, documentIds: [] as string[] };

  await db
    .insert(transactionCandidateSources)
    .values(
      sourceIds.map((sourceRecordId) => ({
        organizationId: orgId,
        candidateId: canonicalCandidateId,
        sourceRecordId,
        relationship: "supporting",
        isPrimary: false,
      })),
    )
    .onConflictDoNothing();

  const sourceDocuments = await db
    .select({ documentId: sourceRecordDocuments.documentId })
    .from(sourceRecordDocuments)
    .where(
      and(
        eq(sourceRecordDocuments.organizationId, orgId),
        inArray(sourceRecordDocuments.sourceRecordId, sourceIds),
      ),
    );
  const candidateDocuments = await db
    .select({ documentId: documentAttachments.documentId })
    .from(documentAttachments)
    .where(
      and(
        eq(documentAttachments.organizationId, orgId),
        eq(documentAttachments.linkableType, "transaction_candidate"),
        eq(documentAttachments.linkableId, sourceCandidate.id),
      ),
    );
  const documentIds = [
    ...new Set([
      ...sourceDocuments.map(({ documentId }) => documentId),
      ...candidateDocuments.map(({ documentId }) => documentId),
    ]),
  ];
  if (documentIds.length > 0) {
    const existing = await db
      .select({ documentId: documentAttachments.documentId })
      .from(documentAttachments)
      .where(
        and(
          eq(documentAttachments.organizationId, orgId),
          eq(documentAttachments.linkableType, "transaction_candidate"),
          eq(documentAttachments.linkableId, canonicalCandidateId),
          inArray(documentAttachments.documentId, documentIds),
        ),
      );
    const existingIds = new Set(existing.map(({ documentId }) => documentId));
    const missingIds = documentIds.filter((documentId) => !existingIds.has(documentId));
    if (missingIds.length > 0) {
      await db.insert(documentAttachments).values(
        missingIds.map((documentId) => ({
          organizationId: orgId,
          documentId,
          linkableType: "transaction_candidate",
          linkableId: canonicalCandidateId,
        })),
      );
    }
  }
  return { sourceIds, documentIds };
}

async function attachCandidateToJournal(
  db: DbExecutor,
  orgId: string,
  candidate: typeof transactionCandidates.$inferSelect,
  journalHeaderId: string,
) {
  const sourceIds = await sourceIdsForCandidate(db, orgId, candidate);
  if (sourceIds.length > 0) {
    await db
      .insert(ledgerSourceLinks)
      .values(
        sourceIds.map((sourceRecordId) => ({
          organizationId: orgId,
          journalHeaderId,
          sourceRecordId,
          relationship: "supporting",
        })),
      )
      .onConflictDoNothing();
  }

  const sourceDocuments =
    sourceIds.length > 0
      ? await db
          .select({ documentId: sourceRecordDocuments.documentId })
          .from(sourceRecordDocuments)
          .where(
            and(
              eq(sourceRecordDocuments.organizationId, orgId),
              inArray(sourceRecordDocuments.sourceRecordId, sourceIds),
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
        eq(documentAttachments.linkableId, candidate.id),
      ),
    );
  const documentIds = [
    ...new Set([
      ...sourceDocuments.map(({ documentId }) => documentId),
      ...candidateDocuments.map(({ documentId }) => documentId),
    ]),
  ];
  if (documentIds.length > 0) {
    const existing = await db
      .select({ documentId: documentAttachments.documentId })
      .from(documentAttachments)
      .where(
        and(
          eq(documentAttachments.organizationId, orgId),
          eq(documentAttachments.linkableType, "journal_header"),
          eq(documentAttachments.linkableId, journalHeaderId),
          inArray(documentAttachments.documentId, documentIds),
        ),
      );
    const existingIds = new Set(existing.map(({ documentId }) => documentId));
    const missingIds = documentIds.filter((documentId) => !existingIds.has(documentId));
    if (missingIds.length > 0) {
      await db.insert(documentAttachments).values(
        missingIds.map((documentId) => ({
          organizationId: orgId,
          documentId,
          linkableType: "journal_header",
          linkableId: journalHeaderId,
        })),
      );
    }
  }
  return { sourceIds, documentIds };
}

async function resolveDuplicateFindings(
  db: DbExecutor,
  orgId: string,
  userId: string,
  caseId: string,
  candidateIds: string[],
  action: DuplicateResolutionAction,
  reason: string | null,
) {
  if (candidateIds.length === 0) return;
  await db
    .update(reviewFindings)
    .set({
      state: "resolved",
      resolvedBy: userId,
      resolvedAt: new Date(),
      resolutionNote: reason || action.replaceAll("_", " "),
    })
    .where(
      and(
        eq(reviewFindings.organizationId, orgId),
        eq(reviewFindings.ruleKey, "possible_duplicate"),
        eq(reviewFindings.state, "open"),
        inArray(reviewFindings.candidateId, candidateIds),
        sql`${reviewFindings.fingerprint} like ${`%:possible_duplicate:${caseId}`}`,
      ),
    );
}

async function recordWorkflow(
  ctx: InboxServiceContext,
  caseId: string,
  action: DuplicateResolutionAction,
  idempotencyKey: string,
  data: Record<string, unknown>,
) {
  await ctx.db.insert(workflowEvents).values({
    organizationId: ctx.orgId,
    entityType: "duplicate_case",
    entityId: caseId,
    action,
    actorType: "user",
    actorId: ctx.userId,
    idempotencyKey: `duplicate-resolution:${idempotencyKey}`,
    data,
  });
  await insertActivityLog(
    {
      orgId: ctx.orgId,
      entityType: "duplicate_case",
      entityId: caseId,
      action,
      actorId: ctx.userId,
      changes: data,
    },
    ctx.db,
  );
}

export async function resolveDuplicateCase(
  ctx: InboxServiceContext,
  input: DuplicateResolutionInput,
) {
  const { db, orgId, userId } = ctx;
  const idempotencyKey = input.idempotencyKey.trim();
  if (idempotencyKey.length < 8 || idempotencyKey.length > 255) {
    throw new Error("A stable resolution idempotency key is required.");
  }

  const [initialCase] = await db
    .select()
    .from(sourceMatchCandidates)
    .where(
      and(
        eq(sourceMatchCandidates.organizationId, orgId),
        eq(sourceMatchCandidates.id, input.caseId),
      ),
    )
    .limit(1);
  if (!initialCase) throw new Error("Duplicate case not found.");
  if (initialCase.state !== "open" && initialCase.resolutionIdempotencyKey === idempotencyKey) {
    const replayEvidence = initialCase.evidence as Record<string, unknown>;
    const replaySelectionId =
      typeof replayEvidence.resolutionSelectionId === "string"
        ? replayEvidence.resolutionSelectionId
        : null;
    const requestedReason = input.reason?.trim() || null;
    if (
      initialCase.resolutionAction !== input.action ||
      initialCase.resolutionReason !== requestedReason ||
      replaySelectionId !== (input.canonicalId ?? null)
    ) {
      throw new Error(
        "This idempotency key was already used for a different duplicate resolution.",
      );
    }
    return {
      caseId: initialCase.id,
      action: initialCase.resolutionAction as DuplicateResolutionAction,
      alreadyResolved: true,
    };
  }
  if (initialCase.state !== "open") {
    throw new Error("This duplicate case has already been resolved.");
  }

  // Approval locks candidate/Inbox rows before running the duplicate matcher.
  // Resolve in the same order, across both sides in stable UUID order, so the
  // two workflows serialize without deadlocks or stale lifecycle snapshots.
  const initialDetail = await getDuplicateCase(ctx, input.caseId);
  const lifecycleCandidateIds = [
    ...new Set(
      [
        initialDetail.left.candidate?.candidate.id,
        initialDetail.right.candidate?.candidate.id,
      ].filter((candidateId): candidateId is string => Boolean(candidateId)),
    ),
  ].sort();
  if (lifecycleCandidateIds.length > 0) {
    const lockedCandidates = await db
      .select({ id: transactionCandidates.id })
      .from(transactionCandidates)
      .where(
        and(
          eq(transactionCandidates.organizationId, orgId),
          inArray(transactionCandidates.id, lifecycleCandidateIds),
        ),
      )
      .orderBy(transactionCandidates.id)
      .for("update");
    if (lockedCandidates.length !== lifecycleCandidateIds.length) {
      throw new Error("One or more duplicate candidates are no longer available.");
    }
    await db
      .select({ id: inboxItems.id })
      .from(inboxItems)
      .where(
        and(
          eq(inboxItems.organizationId, orgId),
          inArray(inboxItems.candidateId, lifecycleCandidateIds),
        ),
      )
      .orderBy(inboxItems.id)
      .for("update");
  }

  const sourceIds = [initialCase.leftSourceRecordId, initialCase.rightSourceRecordId].sort();
  const lockedSources = await db
    .select({ id: sourceRecords.id })
    .from(sourceRecords)
    .where(and(eq(sourceRecords.organizationId, orgId), inArray(sourceRecords.id, sourceIds)))
    .orderBy(sourceRecords.id)
    .for("update");
  if (lockedSources.length !== sourceIds.length) {
    throw new Error("One or more duplicate sources are no longer available.");
  }

  const [lockedCase] = await db
    .select()
    .from(sourceMatchCandidates)
    .where(
      and(
        eq(sourceMatchCandidates.organizationId, orgId),
        eq(sourceMatchCandidates.id, input.caseId),
      ),
    )
    .for("update")
    .limit(1);
  if (!lockedCase || lockedCase.state !== "open") {
    throw new Error("This duplicate case has already been resolved.");
  }
  if (lockedCase.lockVersion !== input.expectedVersion) {
    throw new Error(
      "This duplicate case changed after you opened it. Refresh and review it again.",
    );
  }

  const detail = await getDuplicateCase(ctx, input.caseId);
  const validation = validateResolution(detail, input, ctx.role);
  if (validation.errors.length > 0) throw new Error(validation.errors[0]);

  const leftCandidate = detail.left.candidate?.candidate ?? null;
  const rightCandidate = detail.right.candidate?.candidate ?? null;
  const leftJournal = detail.left.journal;
  const rightJournal = detail.right.journal;
  const reason = input.reason?.trim() || null;
  let canonicalCandidateId: string | null = null;
  let canonicalJournalHeaderId: string | null = null;
  const result: Record<string, unknown> = {};

  if (input.action === "consolidate_candidates") {
    const canonical = input.canonicalId === leftCandidate!.id ? leftCandidate! : rightCandidate!;
    const duplicate = canonical.id === leftCandidate!.id ? rightCandidate! : leftCandidate!;
    const [superseded] = await db
      .update(transactionCandidates)
      .set({
        status: "superseded",
        supersededById: canonical.id,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(transactionCandidates.organizationId, orgId),
          eq(transactionCandidates.id, duplicate.id),
          eq(transactionCandidates.status, "current"),
        ),
      )
      .returning({ id: transactionCandidates.id });
    if (!superseded) {
      throw new Error("The duplicate candidate changed before it could be consolidated.");
    }
    const [dismissedItem] = await db
      .update(inboxItems)
      .set({
        state: "dismissed",
        resolvedBy: userId,
        resolvedAt: new Date(),
        resolutionNote: reason || "Consolidated into another Inbox candidate.",
        lockVersion: sql`${inboxItems.lockVersion} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(inboxItems.organizationId, orgId),
          eq(inboxItems.candidateId, duplicate.id),
          inArray(inboxItems.state, ["received", "needs_information", "ready_for_review"]),
        ),
      )
      .returning({ id: inboxItems.id });
    if (!dismissedItem) {
      throw new Error("The duplicate Inbox item changed before it could be consolidated.");
    }
    await copyCandidateEvidence(db, orgId, duplicate, canonical.id);
    canonicalCandidateId = canonical.id;
    result.supersededCandidateId = duplicate.id;
  } else if (input.action === "attach_to_posted") {
    const canonicalJournal = input.canonicalId === leftJournal?.id ? leftJournal : rightJournal!;
    const candidate = canonicalJournal.id === leftJournal?.id ? rightCandidate! : leftCandidate!;
    const [attached] = await db
      .update(transactionCandidates)
      .set({
        status: "attached",
        postedJournalHeaderId: canonicalJournal.id,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(transactionCandidates.organizationId, orgId),
          eq(transactionCandidates.id, candidate.id),
          eq(transactionCandidates.status, "current"),
        ),
      )
      .returning({ id: transactionCandidates.id });
    if (!attached) {
      throw new Error("The Inbox candidate changed before its evidence could be attached.");
    }
    const [dismissedItem] = await db
      .update(inboxItems)
      .set({
        state: "dismissed",
        resolvedBy: userId,
        resolvedAt: new Date(),
        resolutionNote: reason || "Evidence attached to an existing posted transaction.",
        lockVersion: sql`${inboxItems.lockVersion} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(inboxItems.organizationId, orgId),
          eq(inboxItems.candidateId, candidate.id),
          inArray(inboxItems.state, ["received", "needs_information", "ready_for_review"]),
        ),
      )
      .returning({ id: inboxItems.id });
    if (!dismissedItem) {
      throw new Error("The Inbox item changed before its evidence could be attached.");
    }
    await attachCandidateToJournal(db, orgId, candidate, canonicalJournal.id);
    canonicalJournalHeaderId = canonicalJournal.id;
    result.attachedCandidateId = candidate.id;
  } else if (input.action === "keep_separate") {
    result.keptSeparate = true;
  } else if (input.action === "reject_source") {
    const rejectLeft =
      input.canonicalId === detail.left.source.id || input.canonicalId === leftCandidate?.id;
    const rejectedSide = rejectLeft ? detail.left : detail.right;
    const rejectedCandidate = rejectedSide.candidate?.candidate ?? null;
    if (rejectedCandidate) {
      const [rejected] = await db
        .update(transactionCandidates)
        .set({ status: "rejected", updatedAt: new Date() })
        .where(
          and(
            eq(transactionCandidates.organizationId, orgId),
            eq(transactionCandidates.id, rejectedCandidate.id),
            eq(transactionCandidates.status, "current"),
          ),
        )
        .returning({ id: transactionCandidates.id });
      if (!rejected) {
        throw new Error("The duplicate candidate changed before its source could be rejected.");
      }
      const [rejectedItem] = await db
        .update(inboxItems)
        .set({
          state: "rejected",
          resolvedBy: userId,
          resolvedAt: new Date(),
          resolutionNote: reason,
          lockVersion: sql`${inboxItems.lockVersion} + 1`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(inboxItems.organizationId, orgId),
            eq(inboxItems.candidateId, rejectedCandidate.id),
            inArray(inboxItems.state, ["received", "needs_information", "ready_for_review"]),
          ),
        )
        .returning({ id: inboxItems.id });
      if (!rejectedItem) {
        throw new Error("The duplicate Inbox item changed before its source could be rejected.");
      }
    }
    const [rejectedSource] = await db
      .update(sourceRecords)
      .set({ recordState: "rejected", updatedAt: new Date() })
      .where(
        and(
          eq(sourceRecords.organizationId, orgId),
          eq(sourceRecords.id, rejectedSide.source.id),
          eq(sourceRecords.recordState, "active"),
        ),
      )
      .returning({ id: sourceRecords.id });
    if (!rejectedSource) {
      throw new Error("The duplicate source changed before it could be rejected.");
    }
    result.rejectedSourceRecordId = rejectedSide.source.id;
  } else if (input.action === "merge_posted") {
    // Kept as a late import so the Inbox workflow and Ledger route share one
    // merge implementation without introducing a module cycle.
    const { mergeDuplicateJournals } = await import("@/lib/journal-merge");
    const canonicalJournal = input.canonicalId === leftJournal!.id ? leftJournal! : rightJournal!;
    const duplicateJournal = canonicalJournal.id === leftJournal!.id ? rightJournal! : leftJournal!;
    const mergeResult = await mergeDuplicateJournals(ctx, {
      canonicalJournalId: canonicalJournal.id,
      duplicateJournalId: duplicateJournal.id,
      duplicateCaseId: lockedCase.id,
      reason: reason!,
      idempotencyKey,
    });
    canonicalJournalHeaderId = canonicalJournal.id;
    result.merge = mergeResult;
  }

  const candidateIds = [leftCandidate?.id, rightCandidate?.id].filter(
    (candidateId): candidateId is string => Boolean(candidateId),
  );
  await resolveDuplicateFindings(
    db,
    orgId,
    userId,
    lockedCase.id,
    candidateIds,
    input.action,
    reason,
  );

  const [resolvedCase] = await db
    .update(sourceMatchCandidates)
    .set({
      state: "resolved",
      resolutionAction: input.action,
      canonicalCandidateId,
      canonicalJournalHeaderId,
      resolutionReason: reason,
      resolutionIdempotencyKey: idempotencyKey,
      evidence: {
        ...(lockedCase.evidence as Record<string, unknown>),
        resolutionSelectionId: input.canonicalId ?? null,
      },
      resolvedBy: userId,
      resolvedAt: new Date(),
      lockVersion: lockedCase.lockVersion + 1,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(sourceMatchCandidates.organizationId, orgId),
        eq(sourceMatchCandidates.id, lockedCase.id),
        eq(sourceMatchCandidates.lockVersion, lockedCase.lockVersion),
      ),
    )
    .returning();
  if (!resolvedCase) {
    throw new Error("This duplicate case was resolved concurrently. Refresh and review it again.");
  }

  await recordWorkflow(ctx, lockedCase.id, input.action, idempotencyKey, {
    canonicalCandidateId,
    canonicalJournalHeaderId,
    reason,
    ...result,
  });
  return {
    caseId: resolvedCase.id,
    action: input.action,
    canonicalCandidateId,
    canonicalJournalHeaderId,
    alreadyResolved: false,
    ...result,
  };
}
