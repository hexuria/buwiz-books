import { createServerFn } from "@tanstack/react-start";
import { and, asc, desc, eq, gte, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import { accounts } from "@/db/schema/accounts";
import { member, user } from "@/db/schema/auth";
import { dimensions } from "@/db/schema/dimensions";
import { documentAttachments, documents } from "@/db/schema/documents";
import {
  inboxItems,
  integrationSources,
  reviewDecisions,
  reviewFindings,
  sourceMatchCandidates,
  sourceRecordDocuments,
  sourceRecords,
  transactionCandidateLines,
  transactionCandidates,
  transactionCandidateSources,
  workflowEvents,
} from "@/db/schema/inbox";
import { parties } from "@/db/schema/parties";
import {
  correctInboxCandidate,
  type CorrectInboxCandidateInput,
} from "@/lib/inbox/candidate-correction";
import {
  DUPLICATE_RESOLUTION_ACTIONS,
  getDuplicateCase as getDuplicateCaseService,
  previewDuplicateResolution as previewDuplicateResolutionService,
  resolveDuplicateCase as resolveDuplicateCaseService,
} from "@/lib/inbox/duplicate-service";
import { DUPLICATE_MATCHER_VERSION } from "@/lib/inbox/duplicate-matcher";
import { loadDuplicateEngineConfig } from "@/lib/inbox/duplicate-engine";
import { isReviewerEditableEconomicEventSource } from "@/lib/inbox/economic-event";
import { approveInboxItem, rejectInboxItem } from "@/lib/inbox/service";
import { requeueFailedInboundEmailJob } from "@/lib/inbox/inbound-email-job";
import { withMutationPermissionOrgContext, withPermissionOrgContext } from "@/lib/server-context";
import { toSerializableRecord } from "@/lib/serializable-json";

const listInboxSchema = z.object({
  state: z
    .enum([
      "open",
      "received",
      "processing",
      "needs_information",
      "ready_for_review",
      "approved",
      "rejected",
      "dismissed",
      "failed",
      "all",
    ])
    .optional()
    .default("open"),
  search: z.string().max(120).optional(),
  limit: z.number().int().min(1).max(250).optional().default(100),
});

export const listInboxItems = createServerFn({ method: "GET" })
  .inputValidator((input: unknown) => listInboxSchema.parse(input ?? {}))
  .handler(async ({ data }) =>
    withPermissionOrgContext("inbox", "view", async ({ orgId, db }) => {
      const duplicateConfig = await loadDuplicateEngineConfig(db, orgId);
      const duplicatesBlockNow =
        duplicateConfig.enabled &&
        duplicateConfig.mode === "enforce" &&
        duplicateConfig.impact === "blocking";
      const exactDuplicatesBlockNow = duplicateConfig.enabled && duplicateConfig.mode !== "off";
      const duplicateAlgorithmVersion =
        duplicateConfig.algorithmVersion ?? DUPLICATE_MATCHER_VERSION;
      const filters = [eq(inboxItems.organizationId, orgId)];
      if (data.state === "open") {
        filters.push(
          inArray(inboxItems.state, [
            "received",
            "processing",
            "needs_information",
            "ready_for_review",
          ]),
        );
      } else if (data.state !== "all") {
        filters.push(eq(inboxItems.state, data.state));
      }
      if (data.search?.trim()) {
        filters.push(sql`${inboxItems.title} ilike ${`%${data.search.trim()}%`}`);
      }

      return db
        .select({
          id: inboxItems.id,
          title: inboxItems.title,
          state: inboxItems.state,
          priority: inboxItems.priority,
          assigneeId: inboxItems.assigneeId,
          submittedBy: inboxItems.submittedBy,
          submittedByName: user.name,
          candidateRevision: inboxItems.candidateRevision,
          lockVersion: inboxItems.lockVersion,
          createdAt: inboxItems.createdAt,
          transactionDate: transactionCandidates.transactionDate,
          transactionType: transactionCandidates.transactionType,
          originalTotal: transactionCandidates.originalTotal,
          originalCurrency: transactionCandidates.originalCurrency,
          functionalTotal: transactionCandidates.functionalTotal,
          functionalCurrency: transactionCandidates.functionalCurrency,
          sourceProvider: integrationSources.provider,
          sourceChannel: integrationSources.channel,
          openFindingCount: sql<number>`(
            select count(*)::int from review_findings rf
            where rf.inbox_item_id = ${inboxItems.id} and rf.state = 'open'
          )`,
          blockingFindingCount: sql<number>`(
            select count(*)::int from review_findings rf
            where rf.inbox_item_id = ${inboxItems.id}
              and rf.state = 'open' and rf.impact = 'blocking'
              and (
                rf.rule_key <> 'possible_duplicate'
                or ${duplicatesBlockNow}
                or (
                  ${exactDuplicatesBlockNow}
                  and exists (
                    select 1
                    from source_match_candidates smc
                    where smc.organization_id = ${inboxItems.organizationId}
                      and smc.id::text = rf.evidence->>'caseId'
                      and smc.state = 'open'
                      and smc.match_type = 'exact'
                      and smc.match_class = 'duplicate'
                      and smc.disposition = 'blocking'
                      and smc.algorithm_version = ${duplicateAlgorithmVersion}
                  )
                )
              )
          )`,
        })
        .from(inboxItems)
        .innerJoin(transactionCandidates, eq(inboxItems.candidateId, transactionCandidates.id))
        .leftJoin(sourceRecords, eq(inboxItems.sourceRecordId, sourceRecords.id))
        .leftJoin(integrationSources, eq(sourceRecords.sourceId, integrationSources.id))
        .leftJoin(user, eq(inboxItems.submittedBy, user.id))
        .where(and(...filters))
        .orderBy(desc(inboxItems.createdAt))
        .limit(data.limit);
    }),
  );

const getInboxSchema = z.object({ id: z.string().uuid() });

export const getInboxItem = createServerFn({ method: "GET" })
  .inputValidator((input: unknown) => getInboxSchema.parse(input))
  .handler(async ({ data }) =>
    withPermissionOrgContext("inbox", "view", async ({ orgId, db }) => {
      const [item] = await db
        .select({
          item: inboxItems,
          candidate: transactionCandidates,
          sourceProvider: integrationSources.provider,
          sourceChannel: integrationSources.channel,
          sourceName: integrationSources.name,
          itemSourceRecordType: sourceRecords.recordType,
          itemSourceEconomicEventClass: sourceRecords.economicEventClass,
          itemSourceDirection: sourceRecords.direction,
          submitterName: user.name,
          partyName: parties.name,
        })
        .from(inboxItems)
        .innerJoin(transactionCandidates, eq(inboxItems.candidateId, transactionCandidates.id))
        .leftJoin(sourceRecords, eq(inboxItems.sourceRecordId, sourceRecords.id))
        .leftJoin(integrationSources, eq(sourceRecords.sourceId, integrationSources.id))
        .leftJoin(user, eq(inboxItems.submittedBy, user.id))
        .leftJoin(parties, eq(transactionCandidates.partyId, parties.id))
        .where(and(eq(inboxItems.id, data.id), eq(inboxItems.organizationId, orgId)))
        .limit(1);
      if (!item) throw new Error("Inbox item not found.");
      const duplicateConfig = await loadDuplicateEngineConfig(db, orgId);
      const duplicatesBlockNow =
        duplicateConfig.enabled &&
        duplicateConfig.mode === "enforce" &&
        duplicateConfig.impact === "blocking";
      const duplicateBlockingScore = String(duplicateConfig.blockingScore ?? 70);
      const duplicateAlgorithmVersion = duplicateConfig.algorithmVersion ?? 1;

      const lines = await db
        .select({
          id: transactionCandidateLines.id,
          accountId: transactionCandidateLines.accountId,
          accountName: accounts.name,
          accountNumber: accounts.accountNumber,
          originalDebit: transactionCandidateLines.originalDebit,
          originalCredit: transactionCandidateLines.originalCredit,
          functionalDebit: transactionCandidateLines.functionalDebit,
          functionalCredit: transactionCandidateLines.functionalCredit,
          originalCurrency: transactionCandidateLines.originalCurrency,
          exchangeRate: transactionCandidateLines.exchangeRate,
          lineDescription: transactionCandidateLines.lineDescription,
          departmentId: transactionCandidateLines.departmentId,
          locationId: transactionCandidateLines.locationId,
          categoryConfidence: transactionCandidateLines.categoryConfidence,
          sortOrder: transactionCandidateLines.sortOrder,
        })
        .from(transactionCandidateLines)
        .leftJoin(accounts, eq(transactionCandidateLines.accountId, accounts.id))
        .where(
          and(
            eq(transactionCandidateLines.organizationId, orgId),
            eq(transactionCandidateLines.candidateId, item.candidate.id),
          ),
        )
        .orderBy(asc(transactionCandidateLines.sortOrder));
      const findings = await db
        .select({
          id: reviewFindings.id,
          ruleKey: reviewFindings.ruleKey,
          impact: reviewFindings.impact,
          state: reviewFindings.state,
          message: reviewFindings.message,
          formulaVersion: reviewFindings.formulaVersion,
          firstSeenAt: reviewFindings.firstSeenAt,
          lastSeenAt: reviewFindings.lastSeenAt,
          resolvedBy: reviewFindings.resolvedBy,
          resolvedAt: reviewFindings.resolvedAt,
          resolutionNote: reviewFindings.resolutionNote,
          evidence: reviewFindings.evidence,
        })
        .from(reviewFindings)
        .where(
          and(
            eq(reviewFindings.organizationId, orgId),
            eq(reviewFindings.inboxItemId, item.item.id),
          ),
        )
        .orderBy(asc(reviewFindings.state), asc(reviewFindings.firstSeenAt));
      const decisions = await db
        .select({
          id: reviewDecisions.id,
          decision: reviewDecisions.decision,
          reason: reviewDecisions.reason,
          actorId: reviewDecisions.actorId,
          actorName: user.name,
          createdAt: reviewDecisions.createdAt,
          journalHeaderId: reviewDecisions.journalHeaderId,
        })
        .from(reviewDecisions)
        .leftJoin(user, eq(reviewDecisions.actorId, user.id))
        .where(eq(reviewDecisions.inboxItemId, item.item.id))
        .orderBy(desc(reviewDecisions.createdAt));
      const candidateSourceRows = await db
        .select({
          sourceRecordId: transactionCandidateSources.sourceRecordId,
          relationship: transactionCandidateSources.relationship,
          isPrimary: transactionCandidateSources.isPrimary,
          recordType: sourceRecords.recordType,
          economicEventClass: sourceRecords.economicEventClass,
          direction: sourceRecords.direction,
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
            eq(transactionCandidateSources.candidateId, item.candidate.id),
          ),
        );
      const sourceRecordIds = [
        ...new Set([
          ...candidateSourceRows.map(({ sourceRecordId }) => sourceRecordId),
          ...(item.candidate.sourceRecordId ? [item.candidate.sourceRecordId] : []),
          ...(item.item.sourceRecordId ? [item.item.sourceRecordId] : []),
        ]),
      ];
      const editableEconomicSource =
        candidateSourceRows.find(
          ({ relationship, isPrimary, recordType }) =>
            relationship === "origin" && isPrimary && recordType !== "email",
        ) ??
        candidateSourceRows.find(
          ({ relationship, recordType }) => relationship === "origin" && recordType !== "email",
        ) ??
        candidateSourceRows.find(({ recordType }) => recordType !== "email") ??
        (item.itemSourceRecordType
          ? {
              recordType: item.itemSourceRecordType,
              economicEventClass: item.itemSourceEconomicEventClass,
              direction: item.itemSourceDirection,
            }
          : null);
      const sourceDocuments =
        sourceRecordIds.length > 0
          ? await db
              .select({
                id: documents.id,
                filename: documents.originalFilename,
                displayTitle: documents.displayTitle,
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
          filename: documents.originalFilename,
          displayTitle: documents.displayTitle,
          documentType: documents.documentType,
        })
        .from(documentAttachments)
        .innerJoin(documents, eq(documentAttachments.documentId, documents.id))
        .where(
          and(
            eq(documentAttachments.organizationId, orgId),
            eq(documents.organizationId, orgId),
            eq(documentAttachments.linkableType, "transaction_candidate"),
            eq(documentAttachments.linkableId, item.candidate.id),
          ),
        );
      const attachedDocuments = [
        ...new Map(
          [...sourceDocuments, ...candidateDocuments].map((document) => [document.id, document]),
        ).values(),
      ];
      const duplicateCases =
        sourceRecordIds.length > 0
          ? await db
              .select({
                id: sourceMatchCandidates.id,
                state: sourceMatchCandidates.state,
                matchType: sourceMatchCandidates.matchType,
                matchClass: sourceMatchCandidates.matchClass,
                disposition: sourceMatchCandidates.disposition,
                score: sourceMatchCandidates.score,
                signals: sourceMatchCandidates.signals,
                algorithmVersion: sourceMatchCandidates.algorithmVersion,
                lockVersion: sourceMatchCandidates.lockVersion,
                resolutionAction: sourceMatchCandidates.resolutionAction,
                resolutionReason: sourceMatchCandidates.resolutionReason,
                resolvedAt: sourceMatchCandidates.resolvedAt,
              })
              .from(sourceMatchCandidates)
              .where(
                and(
                  eq(sourceMatchCandidates.organizationId, orgId),
                  eq(sourceMatchCandidates.disposition, "blocking"),
                  or(
                    eq(sourceMatchCandidates.state, "resolved"),
                    and(
                      eq(sourceMatchCandidates.state, "open"),
                      eq(sourceMatchCandidates.algorithmVersion, duplicateAlgorithmVersion),
                      or(
                        eq(sourceMatchCandidates.matchType, "exact"),
                        duplicatesBlockNow
                          ? and(
                              gte(sourceMatchCandidates.score, duplicateBlockingScore),
                              eq(sourceMatchCandidates.algorithmVersion, duplicateAlgorithmVersion),
                            )
                          : sql`false`,
                      ),
                    ),
                  ),
                  or(
                    inArray(sourceMatchCandidates.leftSourceRecordId, sourceRecordIds),
                    inArray(sourceMatchCandidates.rightSourceRecordId, sourceRecordIds),
                  ),
                ),
              )
              .orderBy(desc(sourceMatchCandidates.createdAt))
          : [];
      const currentOpenDuplicateCaseIds = new Set(
        duplicateCases
          .filter(
            (duplicateCase) =>
              duplicateCase.state === "open" &&
              (duplicateCase.matchType === "exact" || duplicatesBlockNow),
          )
          .map((duplicateCase) => duplicateCase.id),
      );
      const [accountRows, partyOptions, dimensionOptions] = await Promise.all([
        db
          .select({
            id: accounts.id,
            accountNumber: accounts.accountNumber,
            name: accounts.name,
            accountType: accounts.accountType,
            parentId: accounts.parentId,
          })
          .from(accounts)
          .where(and(eq(accounts.organizationId, orgId), eq(accounts.isActive, true)))
          .orderBy(asc(accounts.accountNumber), asc(accounts.name)),
        db
          .select({
            id: parties.id,
            name: parties.name,
            partyType: parties.partyType,
          })
          .from(parties)
          .where(and(eq(parties.organizationId, orgId), eq(parties.isActive, true)))
          .orderBy(asc(parties.name)),
        db
          .select({
            id: dimensions.id,
            name: dimensions.name,
            dimensionType: dimensions.dimensionType,
          })
          .from(dimensions)
          .where(and(eq(dimensions.organizationId, orgId), eq(dimensions.isActive, true)))
          .orderBy(asc(dimensions.dimensionType), asc(dimensions.name)),
      ]);
      const parentAccountIds = new Set(
        accountRows.flatMap(({ parentId }) => (parentId ? [parentId] : [])),
      );

      return {
        item: item.item,
        candidate: item.candidate,
        source:
          item.sourceProvider && item.sourceChannel
            ? {
                provider: item.sourceProvider,
                channel: item.sourceChannel,
                name: item.sourceName,
              }
            : null,
        submitterName: item.submitterName,
        partyName: item.partyName,
        economicEvent: editableEconomicSource
          ? {
              economicEventClass: editableEconomicSource.economicEventClass,
              direction: editableEconomicSource.direction,
              reviewerEditable: isReviewerEditableEconomicEventSource(
                editableEconomicSource.recordType,
              ),
            }
          : null,
        lines,
        findings: findings.map((finding) => {
          const evidence = toSerializableRecord(finding.evidence);
          const caseId = typeof evidence.caseId === "string" ? evidence.caseId : null;
          const hasCurrentBlockingCase =
            caseId !== null
              ? currentOpenDuplicateCaseIds.has(caseId)
              : currentOpenDuplicateCaseIds.size > 0;
          return {
            ...finding,
            impact:
              finding.ruleKey === "possible_duplicate" &&
              finding.state === "open" &&
              !hasCurrentBlockingCase
                ? "warning"
                : finding.impact,
            evidence,
          };
        }),
        decisions,
        documents: attachedDocuments,
        accountOptions: accountRows
          .filter(({ id }) => !parentAccountIds.has(id))
          .map(({ parentId: _parentId, ...account }) => account),
        partyOptions,
        departmentOptions: dimensionOptions.filter(
          ({ dimensionType }) => dimensionType === "department",
        ),
        locationOptions: dimensionOptions.filter(
          ({ dimensionType }) => dimensionType === "location",
        ),
        duplicateCases: duplicateCases.map((duplicateCase) => ({
          ...duplicateCase,
          signals: toSerializableRecord(duplicateCase.signals),
        })),
      };
    }),
  );

const correctionAmountSchema = z
  .string()
  .trim()
  .regex(/^\d+(?:\.\d{1,8})?$/, "Enter a valid positive amount.")
  .nullable()
  .optional();

const updateCandidateSchema = z.object({
  inboxItemId: z.string().uuid(),
  expectedRevision: z.number().int().positive(),
  expectedLockVersion: z.number().int().positive(),
  transactionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  transactionType: z.enum(["pay_in", "pay_out", "journal", "transfer"]),
  economicEventClass: z
    .enum([
      "purchase",
      "sale",
      "bill_accrual",
      "bill_payment",
      "invoice_accrual",
      "invoice_payment",
      "transfer",
      "payroll",
      "other",
    ])
    .optional(),
  memo: z.string().trim().max(1000).nullable().optional(),
  referenceNumber: z.string().trim().max(100).nullable().optional(),
  partyId: z.string().uuid().nullable().optional(),
  originalCurrency: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{3}$/),
  exchangeRate: z
    .string()
    .trim()
    .regex(/^\d+(?:\.\d{1,10})?$/, "Enter a valid positive exchange rate.")
    .nullable()
    .optional(),
  lines: z
    .array(
      z.object({
        accountId: z.string().uuid(),
        debit: correctionAmountSchema,
        credit: correctionAmountSchema,
        lineDescription: z.string().trim().max(500).nullable().optional(),
        departmentId: z.string().uuid().nullable().optional(),
        locationId: z.string().uuid().nullable().optional(),
      }),
    )
    .min(2)
    .max(100),
});

export const updateInboxCandidate = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => updateCandidateSchema.parse(input))
  .handler(async ({ data }) =>
    withMutationPermissionOrgContext(
      "inbox",
      "update",
      { routeKey: "inbox:update-candidate", limit: 60, windowMs: 60_000 },
      (ctx) => correctInboxCandidate(ctx, data as CorrectInboxCandidateInput),
    ),
  );

const approveSchema = z.object({
  inboxItemId: z.string().uuid(),
  expectedRevision: z.number().int().positive(),
  expectedLockVersion: z.number().int().positive(),
  overrideReason: z.string().max(1000).optional(),
});

export const approveInbox = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => approveSchema.parse(input))
  .handler(async ({ data }) => {
    const result = await withMutationPermissionOrgContext(
      "inbox",
      "approve",
      { routeKey: "inbox:approve", limit: 30, windowMs: 60_000 },
      (ctx) => approveInboxItem(ctx, data),
    );
    if (result.approvalOutcome === "blocked") {
      // The matcher creates/reopens its case inside withOrgContext. Raise the
      // familiar UI error only after that transaction has committed.
      throw new Error(result.message);
    }
    return result;
  });

const rejectSchema = z.object({
  inboxItemId: z.string().uuid(),
  expectedLockVersion: z.number().int().positive(),
  reason: z.string().trim().min(1).max(1000),
});

export const rejectInbox = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => rejectSchema.parse(input))
  .handler(async ({ data }) =>
    withMutationPermissionOrgContext(
      "inbox",
      "reject",
      { routeKey: "inbox:reject", limit: 30, windowMs: 60_000 },
      (ctx) => rejectInboxItem(ctx, data),
    ),
  );

const assignSchema = z.object({
  inboxItemId: z.string().uuid(),
  assigneeId: z.string().nullable(),
  expectedLockVersion: z.number().int().positive(),
});

export const assignInbox = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => assignSchema.parse(input))
  .handler(async ({ data }) =>
    withMutationPermissionOrgContext(
      "inbox",
      "assign",
      { routeKey: "inbox:assign", limit: 60, windowMs: 60_000 },
      async ({ orgId, userId, db }) => {
        const [item] = await db
          .select()
          .from(inboxItems)
          .where(and(eq(inboxItems.id, data.inboxItemId), eq(inboxItems.organizationId, orgId)))
          .for("update")
          .limit(1);
        if (!item) throw new Error("Inbox item not found.");
        if (item.lockVersion !== data.expectedLockVersion) {
          throw new Error("This Inbox item changed after you opened it.");
        }
        if (data.assigneeId) {
          const [assignee] = await db
            .select({ id: user.id })
            .from(member)
            .innerJoin(user, eq(member.userId, user.id))
            .where(and(eq(user.id, data.assigneeId), eq(member.organizationId, orgId)))
            .limit(1);
          if (!assignee) throw new Error("Assignee not found.");
        }
        const [updated] = await db
          .update(inboxItems)
          .set({
            assigneeId: data.assigneeId,
            lockVersion: item.lockVersion + 1,
            updatedAt: new Date(),
          })
          .where(eq(inboxItems.id, item.id))
          .returning();
        await db.insert(workflowEvents).values({
          organizationId: orgId,
          inboxItemId: item.id,
          entityType: "inbox_item",
          entityId: item.id,
          action: "assigned",
          actorType: "user",
          actorId: userId,
          data: { assigneeId: data.assigneeId },
        });
        return updated;
      },
    ),
  );

const resolveFindingSchema = z.object({
  findingId: z.string().uuid(),
  expectedLockVersion: z.number().int().positive(),
  resolutionNote: z.string().trim().min(3).max(1000),
});

export const resolveInboxFinding = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => resolveFindingSchema.parse(input))
  .handler(async ({ data }) =>
    withMutationPermissionOrgContext(
      "review",
      "resolve",
      { routeKey: "inbox:resolve-finding", limit: 60, windowMs: 60_000 },
      async ({ orgId, userId, db }) => {
        const [finding] = await db
          .select({
            finding: reviewFindings,
            item: inboxItems,
          })
          .from(reviewFindings)
          .innerJoin(inboxItems, eq(reviewFindings.inboxItemId, inboxItems.id))
          .where(
            and(eq(reviewFindings.id, data.findingId), eq(reviewFindings.organizationId, orgId)),
          )
          .for("update")
          .limit(1);
        if (!finding) throw new Error("Review finding not found.");
        if (finding.finding.ruleKey === "possible_duplicate") {
          throw new Error(
            "Possible duplicates require a structured decision. Compare both transactions and choose consolidate, attach, keep separate, merge, or reject.",
          );
        }
        if (finding.item.lockVersion !== data.expectedLockVersion) {
          throw new Error(
            "This Inbox item changed after you opened it. Refresh and review it again.",
          );
        }
        if (finding.finding.state !== "open") return { alreadyResolved: true };
        await db
          .update(reviewFindings)
          .set({
            state: "resolved",
            resolvedBy: userId,
            resolvedAt: new Date(),
            resolutionNote: data.resolutionNote,
          })
          .where(eq(reviewFindings.id, finding.finding.id));
        await db
          .update(inboxItems)
          .set({
            lockVersion: finding.item.lockVersion + 1,
            updatedAt: new Date(),
          })
          .where(eq(inboxItems.id, finding.item.id));
        await db.insert(workflowEvents).values({
          organizationId: orgId,
          inboxItemId: finding.item.id,
          entityType: "review_finding",
          entityId: finding.finding.id,
          action: "resolved",
          actorType: "user",
          actorId: userId,
          data: {
            ruleKey: finding.finding.ruleKey,
            resolutionNote: data.resolutionNote,
          },
        });
        return { alreadyResolved: false };
      },
    ),
  );

const retryInboundEmailSchema = z.object({ emailId: z.string().min(1) });

/**
 * Re-queue a terminally-failed inbound-email job so the worker reprocesses it.
 * Used by the "Retry processing" action on a `source_processing_failed` finding
 * (e.g. after adding a bank account's statement password).
 */
export const retryInboundEmailProcessing = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => retryInboundEmailSchema.parse(input))
  .handler(async ({ data }) =>
    withMutationPermissionOrgContext(
      "review",
      "resolve",
      { routeKey: "inbox:retry-processing", limit: 20, windowMs: 60_000 },
      async ({ orgId, db }) => {
        const requeued = await requeueFailedInboundEmailJob(db, {
          organizationId: orgId,
          emailId: data.emailId,
        });
        if (!requeued) {
          throw new Error(
            "This email could not be re-queued. It may have already been retried, resolved, or is no longer in a failed state.",
          );
        }
        return { requeued: true };
      },
    ),
  );

const duplicateCaseSchema = z.object({ caseId: z.string().uuid() });

export const getDuplicateCase = createServerFn({ method: "GET" })
  .inputValidator((input: unknown) => duplicateCaseSchema.parse(input))
  .handler(async ({ data }) =>
    withPermissionOrgContext("review", "view", async (ctx) => {
      const detail = await getDuplicateCaseService(ctx, data.caseId);
      return {
        ...detail,
        case: {
          ...detail.case,
          evidence: toSerializableRecord(detail.case.evidence),
          signals: toSerializableRecord(detail.case.signals),
        },
        left: {
          ...detail.left,
          source: {
            ...detail.left.source,
            rawData: toSerializableRecord(detail.left.source.rawData),
          },
        },
        right: {
          ...detail.right,
          source: {
            ...detail.right.source,
            rawData: toSerializableRecord(detail.right.source.rawData),
          },
        },
      };
    }),
  );

const previewDuplicateResolutionSchema = z.object({
  caseId: z.string().uuid(),
  action: z.enum(DUPLICATE_RESOLUTION_ACTIONS),
  canonicalId: z.string().uuid().nullable().optional(),
  reason: z.string().max(1000).nullable().optional(),
});

export const previewDuplicateResolution = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => previewDuplicateResolutionSchema.parse(input))
  .handler(async ({ data }) =>
    withPermissionOrgContext("review", "view", (ctx) =>
      previewDuplicateResolutionService(ctx, data),
    ),
  );

const resolveDuplicateCaseSchema = previewDuplicateResolutionSchema.extend({
  expectedVersion: z.number().int().positive(),
  idempotencyKey: z.string().trim().min(8).max(255),
});

export const resolveDuplicateCase = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => resolveDuplicateCaseSchema.parse(input))
  .handler(async ({ data }) => {
    const guard = {
      routeKey: `inbox:resolve-duplicate:${data.action}`,
      limit: 30,
      windowMs: 60_000,
    };
    if (data.action === "merge_posted" || data.action === "reject_source") {
      return withMutationPermissionOrgContext("journal", "match", guard, (ctx) =>
        resolveDuplicateCaseService(ctx, data),
      );
    }
    return withMutationPermissionOrgContext("review", "resolve", guard, (ctx) =>
      resolveDuplicateCaseService(ctx, data),
    );
  });
