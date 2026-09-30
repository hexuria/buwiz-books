/**
 * An organization's scorecard pile, read from its stored candidates.
 *
 * Read-only and org-scoped: every query carries the organization predicate,
 * and the caller runs it inside that organization's context (the CLI wraps it
 * in withOrgContext and a READ ONLY transaction). Nothing here writes.
 *
 * The pile is the organization's most recently DECIDED Inbox items — approved
 * or rejected — so every case has a recorded human outcome:
 *
 *   - `outcome.decision` from the item's terminal state;
 *   - `outcome.edits` = how many times a reviewer corrected the entry
 *     (`candidate_corrected` workflow events). An emailed paper that arrived
 *     with no drafted lines counts its first entry as an edit, because the
 *     pipeline proposed nothing for the reviewer to accept.
 *
 * Candidates are replayed in their current (decided) state, with posting
 * amounts in the original currency exactly as the correction path evaluates
 * them. Items whose candidate has fewer than two posting lines — rejected
 * before anyone entered them — cannot be evaluated and are skipped.
 *
 * Labels come from `ai_eval_cases` rows with task `inbox_rules`,
 * `input_ref.candidateId` naming the candidate, and
 * `expected = { problems: string[], blocked?: boolean, locked?: boolean }`.
 * Duplicate, ledger, and payee bank-detail context are not reconstructed
 * here, so an organization's pile replays book rules only.
 */
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { DbExecutor } from "@/db";
import { accounts } from "@/db/schema/accounts";
import { aiEvalCases } from "@/db/schema/ai";
import { documentAttachments, documents } from "@/db/schema/documents";
import {
  inboxItems,
  sourceRecordDocuments,
  transactionCandidateLines,
  transactionCandidateSources,
  transactionCandidates,
  workflowEvents,
} from "@/db/schema/inbox";
import { parties } from "@/db/schema/parties";
import { SCORECARD_EVAL_TASK, type ScorecardCase } from "./scorecard";

export const ORG_PILE_DEFAULT_LIMIT = 200;
export const ORG_PILE_MAX_LIMIT = 5000;

const labelSchema = z.object({
  problems: z.array(z.string().min(1)),
  blocked: z.boolean().optional(),
  locked: z.boolean().optional(),
});

export interface OrgScorecardPile {
  cases: ScorecardCase[];
  /** Decided items that could not be replayed (fewer than two posting lines). */
  skipped: number;
}

export async function loadOrgScorecardPile(
  db: DbExecutor,
  orgId: string,
  options: { limit?: number } = {},
): Promise<OrgScorecardPile> {
  const limit = Math.min(Math.max(options.limit ?? ORG_PILE_DEFAULT_LIMIT, 1), ORG_PILE_MAX_LIMIT);
  const items = await db
    .select({
      itemId: inboxItems.id,
      state: inboxItems.state,
      candidate: transactionCandidates,
    })
    .from(inboxItems)
    .innerJoin(
      transactionCandidates,
      and(
        eq(transactionCandidates.id, inboxItems.candidateId),
        eq(transactionCandidates.organizationId, orgId),
      ),
    )
    .where(
      and(
        eq(inboxItems.organizationId, orgId),
        inArray(inboxItems.state, ["approved", "rejected"]),
      ),
    )
    .orderBy(desc(inboxItems.updatedAt), desc(inboxItems.id))
    .limit(limit);
  if (items.length === 0) return { cases: [], skipped: 0 };

  const candidateIds = items.map((item) => item.candidate.id);
  const lines = await db
    .select()
    .from(transactionCandidateLines)
    .where(
      and(
        eq(transactionCandidateLines.organizationId, orgId),
        inArray(transactionCandidateLines.candidateId, candidateIds),
      ),
    )
    .orderBy(asc(transactionCandidateLines.sortOrder), asc(transactionCandidateLines.id));
  const linesByCandidate = new Map<string, (typeof lines)[number][]>();
  for (const line of lines) {
    linesByCandidate.set(line.candidateId, [
      ...(linesByCandidate.get(line.candidateId) ?? []),
      line,
    ]);
  }

  const orgAccounts = await db
    .select({
      id: accounts.id,
      accountType: accounts.accountType,
      subtype: accounts.subtype,
      parentId: accounts.parentId,
    })
    .from(accounts)
    .where(eq(accounts.organizationId, orgId));
  const childCounts = new Map<string, number>();
  for (const account of orgAccounts) {
    if (account.parentId) {
      childCounts.set(account.parentId, (childCounts.get(account.parentId) ?? 0) + 1);
    }
  }
  const accountById = new Map(orgAccounts.map((account) => [account.id, account]));

  const partyIds = [
    ...new Set(items.flatMap((item) => (item.candidate.partyId ? [item.candidate.partyId] : []))),
  ];
  const partyRows =
    partyIds.length > 0
      ? await db
          .select({ id: parties.id, partyType: parties.partyType })
          .from(parties)
          .where(and(eq(parties.organizationId, orgId), inArray(parties.id, partyIds)))
      : [];
  const partyById = new Map(partyRows.map((party) => [party.id, party]));

  // Documents: the candidate's own attachments plus its source records' evidence.
  const sourceDocuments = await db
    .select({
      candidateId: transactionCandidateSources.candidateId,
      id: documents.id,
      documentType: documents.documentType,
    })
    .from(transactionCandidateSources)
    .innerJoin(
      sourceRecordDocuments,
      and(
        eq(sourceRecordDocuments.sourceRecordId, transactionCandidateSources.sourceRecordId),
        eq(sourceRecordDocuments.organizationId, orgId),
      ),
    )
    .innerJoin(
      documents,
      and(eq(documents.id, sourceRecordDocuments.documentId), eq(documents.organizationId, orgId)),
    )
    .where(
      and(
        eq(transactionCandidateSources.organizationId, orgId),
        inArray(transactionCandidateSources.candidateId, candidateIds),
      ),
    );
  const attachedDocuments = await db
    .select({
      candidateId: documentAttachments.linkableId,
      id: documents.id,
      documentType: documents.documentType,
    })
    .from(documentAttachments)
    .innerJoin(
      documents,
      and(eq(documents.id, documentAttachments.documentId), eq(documents.organizationId, orgId)),
    )
    .where(
      and(
        eq(documentAttachments.organizationId, orgId),
        eq(documentAttachments.linkableType, "transaction_candidate"),
        inArray(documentAttachments.linkableId, candidateIds),
      ),
    );
  const documentsByCandidate = new Map<string, Map<string, string>>();
  for (const row of [...sourceDocuments, ...attachedDocuments]) {
    const byId = documentsByCandidate.get(row.candidateId) ?? new Map<string, string>();
    byId.set(row.id, row.documentType);
    documentsByCandidate.set(row.candidateId, byId);
  }

  const corrections = await db
    .select({
      candidateId: workflowEvents.entityId,
      count: sql<number>`count(*)::int`,
    })
    .from(workflowEvents)
    .where(
      and(
        eq(workflowEvents.organizationId, orgId),
        eq(workflowEvents.entityType, "transaction_candidate"),
        eq(workflowEvents.action, "candidate_corrected"),
        inArray(workflowEvents.entityId, candidateIds),
      ),
    )
    .groupBy(workflowEvents.entityId);
  const editsByCandidate = new Map(corrections.map((row) => [row.candidateId, row.count]));

  const labelRows = await db
    .select({
      candidateId: sql<string>`${aiEvalCases.inputRef} ->> 'candidateId'`,
      expected: aiEvalCases.expected,
    })
    .from(aiEvalCases)
    .where(
      and(
        eq(aiEvalCases.organizationId, orgId),
        eq(aiEvalCases.task, SCORECARD_EVAL_TASK),
        inArray(sql<string>`${aiEvalCases.inputRef} ->> 'candidateId'`, candidateIds),
      ),
    )
    .orderBy(desc(aiEvalCases.createdAt), desc(aiEvalCases.id));
  // The newest label for a candidate wins.
  const labelByCandidate = new Map<string, z.infer<typeof labelSchema>>();
  for (const row of labelRows) {
    if (labelByCandidate.has(row.candidateId)) continue;
    const parsed = labelSchema.safeParse(row.expected);
    if (parsed.success) labelByCandidate.set(row.candidateId, parsed.data);
  }

  const cases: ScorecardCase[] = [];
  let skipped = 0;
  for (const item of items) {
    const { candidate } = item;
    const candidateLines = linesByCandidate.get(candidate.id) ?? [];
    if (candidateLines.length < 2) {
      skipped += 1;
      continue;
    }
    const caseAccounts: ScorecardCase["accounts"] = {};
    for (const line of candidateLines) {
      const account = line.accountId ? accountById.get(line.accountId) : undefined;
      if (!account) continue;
      caseAccounts[account.id] = {
        accountType: account.accountType,
        subtype: account.subtype,
        childCount: childCounts.get(account.id) ?? 0,
      };
    }
    const party = candidate.partyId ? partyById.get(candidate.partyId) : undefined;
    const label = labelByCandidate.get(candidate.id);
    cases.push({
      id: `candidate:${candidate.id}`,
      category: null,
      locked: label?.locked ?? false,
      candidate: {
        transactionDate: candidate.transactionDate,
        transactionType: candidate.transactionType as ScorecardCase["candidate"]["transactionType"],
        originalCurrency: candidate.originalCurrency,
        functionalCurrency: candidate.functionalCurrency,
        exchangeRate: candidate.exchangeRate,
        memo: candidate.memo,
        referenceNumber: candidate.referenceNumber,
      },
      lines: candidateLines.map((line) => ({
        accountId: line.accountId,
        debit: line.originalDebit,
        credit: line.originalCredit,
        departmentId: line.departmentId,
        locationId: line.locationId,
        categoryConfidence: line.categoryConfidence,
        lineDescription: line.lineDescription,
      })),
      accounts: caseAccounts,
      party: party ? { id: party.id, partyType: party.partyType } : null,
      documents: [...(documentsByCandidate.get(candidate.id) ?? new Map()).entries()]
        .map(([id, documentType]) => ({ id, documentType }))
        .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)),
      duplicate: null,
      ledgerHistory: null,
      paymentDetails: null,
      expected: label ? { problems: label.problems, blocked: label.blocked } : null,
      outcome: {
        decision: item.state === "approved" ? "approved" : "rejected",
        edits: editsByCandidate.get(candidate.id) ?? 0,
      },
      // Decided papers replay as decided, not as Jev proposed them; a lane's
      // real agreement is its labels (Settings → Jev approval), not a replay.
      jev: null,
    });
  }
  return { cases, skipped };
}
