// ============================================================================
// "Remember this?" and the memory list (Inbox v2 §7).
//
// Request-scoped: the server functions in src/routes/api/-inbox-memory.ts
// resolve the session and permission and hand this module their org-context
// executor. Every query also filters organization_id explicitly.
//
// Saving a memory:
//   • only a person's correction can be remembered — the draft's current
//     revision must be one a reviewer saved, with no system-written line
//     left on it. A model's unreviewed guess never becomes a rule;
//   • the key is derived from the paper itself (keys.ts), preferring the keys
//     inbox stage 2 recorded when it looked the paper up;
//   • the answer is the draft's current kind of paper, party, and accounts —
//     never bank or payment details, and nothing is written to the party;
//   • memories that would answer more than one party's papers (these words;
//     this sender without a party) are admin-only (agentRule:configure);
//   • every save writes the test lock: an `ai_eval_cases` row (provenance
//     authored, task inbox_memory) whose replay must reproduce the answer.
// ============================================================================

import { and, asc, desc, eq, gte, inArray, ne, sql } from "drizzle-orm";
import { z } from "zod";
import type { DbExecutor } from "@/db";
import { accounts } from "@/db/schema/accounts";
import { aiEvalCases } from "@/db/schema/ai";
import { user } from "@/db/schema/auth";
import { classificationMemories } from "@/db/schema/classification-memories";
import { documents } from "@/db/schema/documents";
import {
  inboxItems,
  sourceRecords,
  transactionCandidateLines,
  transactionCandidates,
  workflowEvents,
} from "@/db/schema/inbox";
import { parties } from "@/db/schema/parties";
import { AuthorizationError } from "@/lib/auth-errors";
import { insertActivityLog } from "@/lib/insert-activity-log";
import { roleHasPermission } from "@/lib/permission-policy";
import { counterpartyRoleFor } from "../classification-plan";
import { parseMoneyToScaled, scaledToMoney } from "../money";
import {
  accountSignature,
  buildMemoryAnswer,
  departsFromApplication,
  isMemoryDocKind,
  MEMORY_DOC_KINDS,
  memoryAnswerFromColumns,
  memoryDirection,
  possibleEntryDirections,
  type AnswerAccount,
  type MemoryAnswer,
  type MemoryDocKind,
} from "./answer";
import { MEMORY_MATCH_KINDS, describeMatchKey, scopeKey, type MemoryMatchKind } from "./keys";
import {
  MEMORY_LOCK_PROVENANCE,
  MEMORY_LOCK_TASK,
  MEMORY_REPLAY_VERSION,
  buildMemoryLock,
} from "./lock";
import { resolvePaperKeys } from "./paper-keys";
import { validateMemoryAnswer, type MemoryRejection } from "./select";
import { chartForMemory, loadAnswerParties } from "./store";
import { MEMORY_DISABLE_AFTER_CONSECUTIVE_UNDOS } from "./tracking";

export interface MemoryServiceContext {
  db: DbExecutor;
  orgId: string;
  userId: string;
  role: string;
}

/** How far back the scope preview looks, and how many papers it reads at most. */
export const MEMORY_PREVIEW_WINDOW_MONTHS = 12;
export const MEMORY_PREVIEW_MAX_PAPERS = 500;

const MEMORY_ADMIN_PERMISSION = { resource: "agentRule", action: "configure" } as const;

const candidateIdSchema = z.string().uuid();

/**
 * The kind of paper a person says this is. Only used when the paper's own kind
 * is unknown (a hand-entered entry is "other"); a classified paper keeps its kind.
 */
const chosenDocKindSchema = z.enum(MEMORY_DOC_KINDS).optional();

export const rememberCorrectionInputSchema = z.object({
  candidateId: candidateIdSchema,
  scope: z.enum(MEMORY_MATCH_KINDS),
  /** The revision the person was looking at; a newer one is not what they meant. */
  expectedRevision: z.number().int().positive().optional(),
  docKind: chosenDocKindSchema,
});

export const previewMemoryScopeInputSchema = z.object({
  candidateId: candidateIdSchema,
  scope: z.enum(MEMORY_MATCH_KINDS),
  docKind: chosenDocKindSchema,
});

const DOC_KIND_UNKNOWN_MESSAGE = "Choose what kind of paper this is before remembering it.";
const DOC_KIND_NOT_FITTING_MESSAGE =
  "That kind of paper does not fit this entry. Choose one of the kinds offered.";

export const memoryIdInputSchema = z.object({ memoryId: z.string().uuid() });

const SCOPE_UNAVAILABLE: Record<MemoryMatchKind, string> = {
  file_hash: "This paper has no stored file to remember it by.",
  sender_party: "This paper has no sender email or printed tax id to remember it by.",
  party: "Choose the vendor or customer first, then remember the answer for them.",
  line_text: "This paper has no description to remember it by.",
};

const REJECTION_MESSAGES: Record<MemoryRejection, string> = {
  answer_malformed: "The saved answer can no longer be read.",
  account_missing: "An account in the answer no longer exists.",
  account_inactive: "An account in the answer is inactive.",
  account_not_leaf: "An account in the answer now has sub-accounts, so it cannot be posted to.",
  account_type_changed: "An account in the answer changed type since it was remembered.",
  account_uncategorized: "An account in the answer is an Uncategorized bucket.",
  party_missing: "The party in the answer no longer exists.",
  party_inactive: "The party in the answer is inactive.",
  party_type_not_allowed: "The party in the answer is the wrong kind for this paper.",
  party_not_expected: "This kind of paper has no counterparty, but the answer names one.",
  doc_kind_not_editable: "The kind of paper in the answer cannot be set on this source.",
  direction_mismatch: "The answer is for money going the other way.",
  currency_differs: "The answer was remembered in another currency.",
  split_currency_differs: "The answer splits amounts in another currency.",
  split_amounts_differ: "The answer splits amounts that do not add up to this paper's total.",
  answer_incomplete: "The saved answer is missing a side of the entry.",
};

/**
 * The answer a memory at this scope stores. "These words" matches any party's
 * paper, so it never pins one: the party stays whatever the paper resolves to.
 */
export function answerForScope(answer: MemoryAnswer, scope: MemoryMatchKind): MemoryAnswer {
  return scope === "line_text" ? { ...answer, partyId: null } : answer;
}

/**
 * Whether a memory at this scope is broad enough to be admin-only: these words
 * always are; a sender memory is unless its answer names the party AND its key
 * carries a printed tax id. A sender key without one ("email|") covers every
 * untaxed paper from that address, which is as broad as a words memory. A key
 * too long to keep verbatim is digested, and is treated as broad.
 */
export function isCrossPartyScope(
  scope: MemoryMatchKind,
  answerPartyId: string | null,
  matchKey?: string | null,
): boolean {
  if (scope === "line_text") return true;
  if (scope !== "sender_party") return false;
  if (answerPartyId === null) return true;
  return !matchKey || matchKey.startsWith("sha256:") || matchKey.endsWith("|");
}

function canSaveCrossParty(role: string): boolean {
  return roleHasPermission(role, MEMORY_ADMIN_PERMISSION.resource, MEMORY_ADMIN_PERMISSION.action);
}

async function loadChart(db: DbExecutor, orgId: string) {
  return db
    .select({
      id: accounts.id,
      accountNumber: accounts.accountNumber,
      name: accounts.name,
      accountType: accounts.accountType,
      subtype: accounts.subtype,
      parentId: accounts.parentId,
      isActive: accounts.isActive,
    })
    .from(accounts)
    .where(eq(accounts.organizationId, orgId));
}

type SubjectResult =
  | {
      ok: false;
      message: string;
      /**
       * Set when the paper's kind is unknown: the kinds a person may choose
       * for it (possibly none, when no kind fits the entry).
       */
      kindOptions?: MemoryDocKind[];
    }
  | {
      ok: true;
      candidate: typeof transactionCandidates.$inferSelect;
      inboxItemId: string | null;
      answer: MemoryAnswer;
      paperTotal: string;
    };

/**
 * The draft a person wants remembered, and the answer it states. Refuses a
 * draft whose current lines are not a person's correction.
 */
async function loadRememberSubject(
  db: DbExecutor,
  orgId: string,
  candidateId: string,
  options: { lock: boolean; docKind?: MemoryDocKind },
): Promise<SubjectResult> {
  const query = db
    .select()
    .from(transactionCandidates)
    .where(
      and(
        eq(transactionCandidates.organizationId, orgId),
        eq(transactionCandidates.id, candidateId),
      ),
    )
    .limit(1);
  const [candidate] = options.lock ? await query.for("update") : await query;
  if (!candidate) return { ok: false, message: "Inbox draft not found." };
  if (candidate.status !== "current" && candidate.status !== "posted") {
    return {
      ok: false,
      message: "This draft was replaced or rejected; there is nothing to remember.",
    };
  }
  const [item] = await db
    .select({ id: inboxItems.id })
    .from(inboxItems)
    .where(and(eq(inboxItems.organizationId, orgId), eq(inboxItems.candidateId, candidate.id)))
    .limit(1);
  const lines = await db
    .select()
    .from(transactionCandidateLines)
    .where(
      and(
        eq(transactionCandidateLines.organizationId, orgId),
        eq(transactionCandidateLines.candidateId, candidate.id),
      ),
    )
    .orderBy(asc(transactionCandidateLines.sortOrder));
  const [corrected] = await db
    .select({ id: workflowEvents.id })
    .from(workflowEvents)
    .where(
      and(
        eq(workflowEvents.organizationId, orgId),
        eq(workflowEvents.entityType, "transaction_candidate"),
        eq(workflowEvents.entityId, candidate.id),
        eq(workflowEvents.action, "candidate_corrected"),
        eq(workflowEvents.actorType, "user"),
      ),
    )
    .limit(1);
  const systemWritten = lines.some((line) => {
    const source = line.predictionEvidence?.source;
    return (
      source === "inbox_classification" || source === "memory" || source === "document_extraction"
    );
  });
  if (!corrected || systemWritten) {
    return {
      ok: false,
      message: "Correct the draft first — Remember this saves a person's correction.",
    };
  }
  const [source] = candidate.sourceRecordId
    ? await db
        .select({ economicEventClass: sourceRecords.economicEventClass })
        .from(sourceRecords)
        .where(
          and(
            eq(sourceRecords.organizationId, orgId),
            eq(sourceRecords.id, candidate.sourceRecordId),
          ),
        )
        .limit(1)
    : [];
  if (!source) return { ok: false, message: "This draft has no source paper to remember." };

  const chart = chartForMemory(await loadChart(db, orgId));
  const answerAccounts = new Map<string, AnswerAccount>(chart);

  /** The answer for one kind of paper, or why it cannot be one. */
  const answerAs = async (
    docKind: string | null,
  ): Promise<{ ok: true; answer: MemoryAnswer } | { ok: false; message: string }> => {
    const built = buildMemoryAnswer({
      docKind,
      // A kind of paper with no counterparty (a transfer) never carries one.
      partyId: counterpartyRoleFor(docKind) ? candidate.partyId : null,
      lines,
      accounts: answerAccounts,
    });
    if (!built.ok) return { ok: false, message: built.message };
    const valid = validateMemoryAnswer(built.answer, {
      accounts: chart,
      parties: await loadAnswerParties(db, orgId, [built.answer]),
      paperEventClass: built.answer.docKind,
      paperReviewerEditable: true,
    });
    if (!valid.ok) return { ok: false, message: REJECTION_MESSAGES[valid.reason] };
    return { ok: true, answer: built.answer };
  };

  let answer: MemoryAnswer;
  if (isMemoryDocKind(source.economicEventClass)) {
    // A classified paper keeps its own kind; a chosen one is only for unknown kinds.
    if (options.docKind && options.docKind !== source.economicEventClass) {
      return {
        ok: false,
        message: "This paper's kind is already known; it cannot be changed here.",
      };
    }
    const result = await answerAs(source.economicEventClass);
    if (!result.ok) return result;
    answer = result.answer;
  } else {
    // A hand-entered entry has no kind of its own: offer the kinds whose
    // direction the entry's accounts allow and that make a valid answer.
    const directions = new Set(
      possibleEntryDirections(
        lines.flatMap((line) => {
          const account = line.accountId ? answerAccounts.get(line.accountId) : undefined;
          const side =
            line.originalDebit != null && line.originalDebit !== ""
              ? ("debit" as const)
              : ("credit" as const);
          return account ? [{ side, accountType: account.accountType }] : [];
        }),
      ),
    );
    const kindOptions: MemoryDocKind[] = [];
    for (const kind of MEMORY_DOC_KINDS) {
      const direction = memoryDirection(kind);
      if (!direction || !directions.has(direction)) continue;
      if ((await answerAs(kind)).ok) kindOptions.push(kind);
    }
    if (!options.docKind) {
      return { ok: false, message: DOC_KIND_UNKNOWN_MESSAGE, kindOptions };
    }
    if (!kindOptions.includes(options.docKind)) {
      return { ok: false, message: DOC_KIND_NOT_FITTING_MESSAGE, kindOptions };
    }
    const result = await answerAs(options.docKind);
    if (!result.ok) return { ...result, kindOptions };
    answer = result.answer;
  }
  const built = { answer };
  const paperTotal = scaledToMoney(
    built.answer.lines
      .filter((line) => line.lineMatch.side === "debit")
      .reduce((sum, line) => sum + parseMoneyToScaled(line.amount), 0n),
  );
  return { ok: true, candidate, inboxItemId: item?.id ?? null, answer: built.answer, paperTotal };
}

async function keyForScope(
  db: DbExecutor,
  orgId: string,
  candidate: { id: string; sourceRecordId: string | null; partyId: string | null },
  scope: MemoryMatchKind,
): Promise<string | null> {
  const keys = await resolvePaperKeys(db, orgId, [candidate]);
  const paperKeys = keys.get(candidate.id);
  return paperKeys ? scopeKey(paperKeys, scope) : null;
}

/** A person-readable label for a key: a filename, a party's name, the words. */
export async function labelMatchKey(
  db: DbExecutor,
  orgId: string,
  kind: MemoryMatchKind,
  key: string,
): Promise<string> {
  if (kind === "party") {
    const [party] = await db
      .select({ name: parties.name })
      .from(parties)
      .where(and(eq(parties.organizationId, orgId), eq(parties.id, key)))
      .limit(1);
    return party?.name ?? "A party that no longer exists";
  }
  if (kind === "file_hash") {
    const [document] = await db
      .select({ name: documents.originalFilename })
      .from(documents)
      .where(and(eq(documents.organizationId, orgId), eq(documents.contentHash, key)))
      .limit(1);
    return document ? `File ${document.name}` : describeMatchKey(kind, key);
  }
  return describeMatchKey(kind, key);
}

export interface RememberCorrectionResult {
  memoryId: string;
  matchKind: MemoryMatchKind;
  keyLabel: string;
  replaced: boolean;
  evalCaseId: string;
}

export async function rememberCorrection(
  ctx: MemoryServiceContext,
  input: z.infer<typeof rememberCorrectionInputSchema>,
): Promise<RememberCorrectionResult> {
  const { db, orgId, userId } = ctx;
  const subject = await loadRememberSubject(db, orgId, input.candidateId, {
    lock: true,
    docKind: input.docKind,
  });
  if (!subject.ok) throw new Error(subject.message);
  const { candidate } = subject;
  const answer = answerForScope(subject.answer, input.scope);
  if (input.expectedRevision !== undefined && candidate.revision !== input.expectedRevision) {
    throw new Error("This draft changed after you opened it. Refresh and review it again.");
  }
  const matchKey = await keyForScope(db, orgId, candidate, input.scope);
  if (!matchKey) throw new Error(SCOPE_UNAVAILABLE[input.scope]);
  if (isCrossPartyScope(input.scope, answer.partyId, matchKey) && !canSaveCrossParty(ctx.role)) {
    throw new AuthorizationError(MEMORY_ADMIN_PERMISSION.resource, MEMORY_ADMIN_PERMISSION.action);
  }

  const [previous] = await db
    .select()
    .from(classificationMemories)
    .where(
      and(
        eq(classificationMemories.organizationId, orgId),
        eq(classificationMemories.matchKind, input.scope),
        eq(classificationMemories.matchKey, matchKey),
      ),
    )
    .limit(1)
    .for("update");
  // A memory that is off — turned off by an admin, or by its own undo streak —
  // stays off until someone who manages memories turns it back on. Saving
  // over it is not a way around that.
  if (previous && !previous.enabled && !canSaveCrossParty(ctx.role)) {
    throw new Error(
      "This memory is turned off. An owner or admin can turn it back on in Settings → Review Rules.",
    );
  }
  const sameAnswer =
    previous !== undefined &&
    previous.answerDocKind === answer.docKind &&
    previous.answerPartyId === answer.partyId &&
    accountSignature(
      (previous.answerLines ?? []).map((line) => ({
        side: line.lineMatch.side,
        accountId: line.accountId,
      })),
    ) ===
      accountSignature(
        answer.lines.map((line) => ({ side: line.lineMatch.side, accountId: line.accountId })),
      );

  let memory: typeof classificationMemories.$inferSelect;
  if (previous && sameAnswer) {
    // The same answer again: its uses and undo counts are the memory's own
    // history, not this click's. A memory that was off is only reachable here
    // by someone who manages memories, and their save turns it back on, exactly
    // as the Settings switch would.
    [memory] = await db
      .update(classificationMemories)
      .set({
        updatedAt: new Date(),
        ...(previous.enabled ? {} : { enabled: true, consecutiveUndos: 0 }),
      })
      .where(eq(classificationMemories.id, previous.id))
      .returning();
  } else {
    if (previous) {
      // A different answer is a different memory: a new id, so the old
      // answer's open applications (and their undos or approvals) can never be
      // counted against this one. The old answer stays in the event below.
      // The old memory's lock row stays, as it does on delete: an audit record.
      await db.delete(classificationMemories).where(eq(classificationMemories.id, previous.id));
    }
    [memory] = await db
      .insert(classificationMemories)
      .values({
        organizationId: orgId,
        matchKind: input.scope,
        matchKey,
        answerDocKind: answer.docKind,
        answerPartyId: answer.partyId,
        answerLines: answer.lines,
        createdBy: userId,
        sourceFeedbackId: null,
        uses: 0,
        undos: 0,
        consecutiveUndos: 0,
        enabled: true,
      })
      .returning();
  }

  // The test lock: replaying this answer onto this very paper must always
  // reproduce it. buildMemoryLock throws before anything commits if not.
  const direction = memoryDirection(answer.docKind)!;
  const lock = buildMemoryLock({
    memoryId: memory.id,
    matchKind: input.scope,
    matchKey,
    answer,
    paper: {
      direction,
      total: subject.paperTotal,
      currency: candidate.originalCurrency.trim().toUpperCase(),
    },
  });
  // One current lock per memory: a re-save replaces it rather than appending.
  await deleteMemoryLocks(db, orgId, memory.id);
  const [evalCase] = await db
    .insert(aiEvalCases)
    .values({
      organizationId: orgId,
      task: MEMORY_LOCK_TASK,
      inputRef: lock.inputRef,
      expected: { ...lock.expected },
      provenance: MEMORY_LOCK_PROVENANCE,
      // Ids, amounts and a digest of the key only. Nothing went through
      // redact.ts, and the column means exactly that, so it says false.
      piiRedacted: false,
      promptVersionAtCapture: MEMORY_REPLAY_VERSION,
    })
    .returning({ id: aiEvalCases.id });

  const keyLabel = await labelMatchKey(db, orgId, input.scope, matchKey);
  await db.insert(workflowEvents).values({
    organizationId: orgId,
    inboxItemId: subject.inboxItemId,
    entityType: "classification_memory",
    entityId: memory.id,
    action: previous ? "memory_replaced" : "memory_created",
    actorType: "user",
    actorId: userId,
    data: {
      candidateId: candidate.id,
      candidateRevision: candidate.revision,
      matchKind: input.scope,
      evalCaseId: evalCase.id,
      previousAnswer: previous
        ? {
            docKind: previous.answerDocKind,
            partyId: previous.answerPartyId,
            lines: previous.answerLines,
            uses: previous.uses,
            undos: previous.undos,
            enabled: previous.enabled,
          }
        : null,
    },
  });
  await insertActivityLog(
    {
      orgId,
      entityType: "classification_memory",
      entityId: memory.id,
      action: previous ? "memory_replaced" : "memory_created",
      actorId: userId,
      changes: {
        candidateId: candidate.id,
        matchKind: input.scope,
        docKind: answer.docKind,
        partyId: answer.partyId,
        accounts: answer.lines.map((line) => ({
          side: line.lineMatch.side,
          accountId: line.accountId,
        })),
      },
    },
    db,
  );
  return {
    memoryId: memory.id,
    matchKind: input.scope,
    keyLabel,
    replaced: Boolean(previous),
    evalCaseId: evalCase.id,
  };
}

/** The lock rows ("Remember this?" test cases) a memory wrote. */
async function deleteMemoryLocks(db: DbExecutor, orgId: string, memoryId: string): Promise<void> {
  await db
    .delete(aiEvalCases)
    .where(
      and(
        eq(aiEvalCases.organizationId, orgId),
        eq(aiEvalCases.task, MEMORY_LOCK_TASK),
        sql`${aiEvalCases.inputRef} -> 'memory' ->> 'id' = ${memoryId}`,
      ),
    );
}

export type MemoryScopePreview =
  | {
      available: false;
      scope: MemoryMatchKind;
      reason: string;
      /** Present when the paper's kind is unknown: the kinds the person may choose. */
      kindOptions?: MemoryDocKind[];
    }
  | {
      available: true;
      scope: MemoryMatchKind;
      keyLabel: string;
      /** Could answer more than one party's papers: needs agentRule:configure. */
      requiresAdmin: boolean;
      /** Whether this caller may save it. */
      allowed: boolean;
      /** The memory saved for this key is off, and only an owner or admin may save over it. */
      turnedOffNeedsAdmin: boolean;
      /** Past papers (not this one) with the same key, in the window. */
      matched: number;
      /** Of those, papers whose settled answer differs from this one. */
      changed: number;
      /** Papers read; `capped` when the window held more than the preview reads. */
      examined: number;
      capped: boolean;
      windowMonths: number;
      existingMemory: { id: string; enabled: boolean } | null;
    };

/**
 * How many recent papers this scope would have matched, and on how many of
 * them it would have changed the answer. Org-scoped, bounded to the last
 * MEMORY_PREVIEW_WINDOW_MONTHS and the newest MEMORY_PREVIEW_MAX_PAPERS papers.
 */
export async function previewMemoryScope(
  ctx: Omit<MemoryServiceContext, "userId">,
  input: z.infer<typeof previewMemoryScopeInputSchema>,
  now: Date = new Date(),
): Promise<MemoryScopePreview> {
  const { db, orgId } = ctx;
  const subject = await loadRememberSubject(db, orgId, input.candidateId, {
    lock: false,
    docKind: input.docKind,
  });
  if (!subject.ok) {
    return {
      available: false,
      scope: input.scope,
      reason: subject.message,
      ...(subject.kindOptions ? { kindOptions: subject.kindOptions } : {}),
    };
  }
  const { candidate } = subject;
  const answer = answerForScope(subject.answer, input.scope);
  const matchKey = await keyForScope(db, orgId, candidate, input.scope);
  if (!matchKey) {
    return { available: false, scope: input.scope, reason: SCOPE_UNAVAILABLE[input.scope] };
  }
  const requiresAdmin = isCrossPartyScope(input.scope, answer.partyId, matchKey);

  const since = new Date(now);
  since.setUTCMonth(since.getUTCMonth() - MEMORY_PREVIEW_WINDOW_MONTHS);
  const recent = await db
    .select({
      id: transactionCandidates.id,
      sourceRecordId: transactionCandidates.sourceRecordId,
      partyId: transactionCandidates.partyId,
    })
    .from(transactionCandidates)
    .where(
      and(
        eq(transactionCandidates.organizationId, orgId),
        ne(transactionCandidates.id, candidate.id),
        inArray(transactionCandidates.status, ["current", "posted"]),
        gte(transactionCandidates.createdAt, since),
      ),
    )
    .orderBy(desc(transactionCandidates.createdAt), desc(transactionCandidates.id))
    .limit(MEMORY_PREVIEW_MAX_PAPERS + 1);
  const capped = recent.length > MEMORY_PREVIEW_MAX_PAPERS;
  const papers = recent.slice(0, MEMORY_PREVIEW_MAX_PAPERS);
  const keys = await resolvePaperKeys(db, orgId, papers);
  const matched = papers.filter((paper) => keys.get(paper.id)?.[input.scope].includes(matchKey));

  let changed = 0;
  if (matched.length > 0) {
    const matchedIds = matched.map((paper) => paper.id);
    const lines = await db
      .select({
        candidateId: transactionCandidateLines.candidateId,
        accountId: transactionCandidateLines.accountId,
        originalDebit: transactionCandidateLines.originalDebit,
      })
      .from(transactionCandidateLines)
      .where(
        and(
          eq(transactionCandidateLines.organizationId, orgId),
          inArray(transactionCandidateLines.candidateId, matchedIds),
        ),
      );
    const sourceIds = matched.flatMap((paper) =>
      paper.sourceRecordId ? [paper.sourceRecordId] : [],
    );
    const classes =
      sourceIds.length > 0
        ? await db
            .select({ id: sourceRecords.id, economicEventClass: sourceRecords.economicEventClass })
            .from(sourceRecords)
            .where(
              and(eq(sourceRecords.organizationId, orgId), inArray(sourceRecords.id, sourceIds)),
            )
        : [];
    const classById = new Map(classes.map((row) => [row.id, row.economicEventClass]));
    const application = {
      docKind: answer.docKind,
      partyId: answer.partyId,
      lines: answer.lines.map((line) => ({
        side: line.lineMatch.side,
        accountId: line.accountId,
        amount: line.amount,
      })),
    };
    for (const paper of matched) {
      const settled = {
        docKind: paper.sourceRecordId ? (classById.get(paper.sourceRecordId) ?? null) : null,
        partyId: paper.partyId,
        lines: lines
          .filter((line) => line.candidateId === paper.id)
          .map((line) => ({
            side: line.originalDebit !== null ? ("debit" as const) : ("credit" as const),
            accountId: line.accountId,
          })),
      };
      if (departsFromApplication(application, settled)) changed += 1;
    }
  }

  const [existing] = await db
    .select({ id: classificationMemories.id, enabled: classificationMemories.enabled })
    .from(classificationMemories)
    .where(
      and(
        eq(classificationMemories.organizationId, orgId),
        eq(classificationMemories.matchKind, input.scope),
        eq(classificationMemories.matchKey, matchKey),
      ),
    )
    .limit(1);

  return {
    available: true,
    scope: input.scope,
    keyLabel: await labelMatchKey(db, orgId, input.scope, matchKey),
    requiresAdmin,
    allowed: canSaveCrossParty(ctx.role) || (!requiresAdmin && !(existing && !existing.enabled)),
    turnedOffNeedsAdmin: Boolean(existing && !existing.enabled && !canSaveCrossParty(ctx.role)),
    matched: matched.length,
    changed,
    examined: papers.length,
    capped,
    windowMonths: MEMORY_PREVIEW_WINDOW_MONTHS,
    existingMemory: existing ?? null,
  };
}

export interface MemoryListItem {
  id: string;
  matchKind: MemoryMatchKind;
  keyLabel: string;
  enabled: boolean;
  /** Turned off by two consecutive undos rather than by a person. */
  autoDisabled: boolean;
  uses: number;
  undos: number;
  consecutiveUndos: number;
  answer: {
    docKind: string;
    party: { id: string; name: string } | null;
    lines: Array<{ side: "debit" | "credit"; accountId: string; accountLabel: string }>;
  } | null;
  /** Why this memory would be skipped on a paper today, if it would. */
  problem: string | null;
  createdBy: { id: string; name: string | null };
  createdAt: string;
  updatedAt: string;
}

/** Every memory of the organization, newest first, with what it would do today. */
export async function listMemories(db: DbExecutor, orgId: string): Promise<MemoryListItem[]> {
  const rows = await db
    .select()
    .from(classificationMemories)
    .where(eq(classificationMemories.organizationId, orgId))
    .orderBy(desc(classificationMemories.createdAt), desc(classificationMemories.id));
  if (rows.length === 0) return [];
  const chartRows = await loadChart(db, orgId);
  const chart = chartForMemory(chartRows);
  const accountLabel = new Map(
    chartRows.map((account) => [
      account.id,
      account.accountNumber ? `${account.accountNumber} · ${account.name}` : account.name,
    ]),
  );
  const answers = rows.map((row) => memoryAnswerFromColumns(row));
  const partyIds = [
    ...new Set([
      ...answers.flatMap((answer) => (answer?.partyId ? [answer.partyId] : [])),
      ...rows.flatMap((row) => (row.matchKind === "party" ? [row.matchKey] : [])),
    ]),
  ];
  const partyRows =
    partyIds.length > 0
      ? await db
          .select({
            id: parties.id,
            name: parties.name,
            partyType: parties.partyType,
            isActive: parties.isActive,
          })
          .from(parties)
          .where(and(eq(parties.organizationId, orgId), inArray(parties.id, partyIds)))
      : [];
  const partyById = new Map(partyRows.map((party) => [party.id, party]));
  const hashes = rows.flatMap((row) => (row.matchKind === "file_hash" ? [row.matchKey] : []));
  const files =
    hashes.length > 0
      ? await db
          .select({ hash: documents.contentHash, name: documents.originalFilename })
          .from(documents)
          .where(and(eq(documents.organizationId, orgId), inArray(documents.contentHash, hashes)))
      : [];
  const fileByHash = new Map(files.map((file) => [file.hash, file.name]));
  const creatorIds = [...new Set(rows.map((row) => row.createdBy))];
  const creators = await db
    .select({ id: user.id, name: user.name })
    .from(user)
    .where(inArray(user.id, creatorIds));
  const creatorName = new Map(creators.map((creator) => [creator.id, creator.name]));

  return rows.map((row, index) => {
    const answer = answers[index];
    let problem: string | null = null;
    if (!answer) {
      problem = REJECTION_MESSAGES.answer_malformed;
    } else {
      const valid = validateMemoryAnswer(answer, {
        accounts: chart,
        parties: new Map(
          partyRows.map((party) => [
            party.id,
            { id: party.id, partyType: party.partyType, isActive: party.isActive },
          ]),
        ),
        paperEventClass: answer.docKind,
        paperReviewerEditable: true,
      });
      if (!valid.ok) problem = REJECTION_MESSAGES[valid.reason];
    }
    const keyLabel =
      row.matchKind === "party"
        ? (partyById.get(row.matchKey)?.name ?? "A party that no longer exists")
        : row.matchKind === "file_hash" && fileByHash.has(row.matchKey)
          ? `File ${fileByHash.get(row.matchKey)}`
          : describeMatchKey(row.matchKind, row.matchKey);
    return {
      id: row.id,
      matchKind: row.matchKind,
      keyLabel,
      enabled: row.enabled,
      autoDisabled: !row.enabled && row.consecutiveUndos >= MEMORY_DISABLE_AFTER_CONSECUTIVE_UNDOS,
      uses: row.uses,
      undos: row.undos,
      consecutiveUndos: row.consecutiveUndos,
      answer: answer
        ? {
            docKind: answer.docKind,
            party: answer.partyId
              ? {
                  id: answer.partyId,
                  name: partyById.get(answer.partyId)?.name ?? "A party that no longer exists",
                }
              : null,
            lines: answer.lines.map((line) => ({
              side: line.lineMatch.side,
              accountId: line.accountId,
              accountLabel: accountLabel.get(line.accountId) ?? "An account that no longer exists",
            })),
          }
        : null,
      problem,
      createdBy: { id: row.createdBy, name: creatorName.get(row.createdBy) ?? null },
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  });
}

async function lockMemory(db: DbExecutor, orgId: string, memoryId: string) {
  const [memory] = await db
    .select()
    .from(classificationMemories)
    .where(
      and(
        eq(classificationMemories.organizationId, orgId),
        eq(classificationMemories.id, memoryId),
      ),
    )
    .for("update")
    .limit(1);
  if (!memory) throw new Error("Memory not found.");
  return memory;
}

/**
 * Turn a memory on or off. Turning one back on clears its consecutive-undo
 * count: a person has decided to give it another chance.
 */
export async function setMemoryEnabled(
  ctx: MemoryServiceContext,
  input: { memoryId: string; enabled: boolean },
): Promise<{ id: string; enabled: boolean }> {
  const memory = await lockMemory(ctx.db, ctx.orgId, input.memoryId);
  if (memory.enabled === input.enabled) return { id: memory.id, enabled: memory.enabled };
  await ctx.db
    .update(classificationMemories)
    .set({
      enabled: input.enabled,
      ...(input.enabled ? { consecutiveUndos: 0 } : {}),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(classificationMemories.organizationId, ctx.orgId),
        eq(classificationMemories.id, memory.id),
      ),
    );
  const action = input.enabled ? "memory_enabled" : "memory_disabled";
  await ctx.db.insert(workflowEvents).values({
    organizationId: ctx.orgId,
    entityType: "classification_memory",
    entityId: memory.id,
    action,
    actorType: "user",
    actorId: ctx.userId,
    data: { consecutiveUndosBefore: memory.consecutiveUndos },
  });
  await insertActivityLog(
    {
      orgId: ctx.orgId,
      entityType: "classification_memory",
      entityId: memory.id,
      action,
      actorId: ctx.userId,
    },
    ctx.db,
  );
  return { id: memory.id, enabled: input.enabled };
}

/**
 * Delete a memory. Its test-lock row stays: the replay it records is still a
 * true statement about the replay function, and the audit trail keeps it.
 */
export async function deleteMemory(
  ctx: MemoryServiceContext,
  input: { memoryId: string },
): Promise<{ id: string; deleted: true }> {
  const memory = await lockMemory(ctx.db, ctx.orgId, input.memoryId);
  await ctx.db
    .delete(classificationMemories)
    .where(
      and(
        eq(classificationMemories.organizationId, ctx.orgId),
        eq(classificationMemories.id, memory.id),
      ),
    );
  await ctx.db.insert(workflowEvents).values({
    organizationId: ctx.orgId,
    entityType: "classification_memory",
    entityId: memory.id,
    action: "memory_deleted",
    actorType: "user",
    actorId: ctx.userId,
    data: {
      matchKind: memory.matchKind,
      docKind: memory.answerDocKind,
      partyId: memory.answerPartyId,
      uses: memory.uses,
      undos: memory.undos,
    },
  });
  await insertActivityLog(
    {
      orgId: ctx.orgId,
      entityType: "classification_memory",
      entityId: memory.id,
      action: "memory_deleted",
      actorId: ctx.userId,
    },
    ctx.db,
  );
  return { id: memory.id, deleted: true };
}
