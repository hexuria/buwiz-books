// ============================================================================
// Did people keep what a memory answered? (Inbox v2 §7, undo tracking.)
//
// Each time a memory answers a draft, inbox stage 2 records a
// `memory_applied` workflow event for that candidate revision. The
// application then ends exactly once:
//
//   confirmed   the draft was approved with the memory's answer intact —
//               an accepted hit, which resets consecutive_undos;
//   undone      a person corrected the draft away from the answer before
//               approval, or the posted entry was later reversed or voided;
//   superseded  the system replaced the memory's lines (new facts arrived,
//               or a later classification answered without it). Nobody
//               disagreed, so it counts neither way.
//
// Each ending is an idempotent workflow event keyed by (candidate, applied
// revision), so a retried request can never count twice. Two consecutive
// undos turn a memory off here, in code, with its own workflow event — a
// CHECK constraint would reject the update that records the second undo.
//
// Only the classification counts as disagreement: accounts per side, the
// party the memory set, and the kind of paper. Editing an amount, a date, or
// the memo is not an undo.
// ============================================================================

import { and, eq, inArray, sql } from "drizzle-orm";
import type { DbExecutor } from "@/db";
import { classificationMemories } from "@/db/schema/classification-memories";
import { inboxItems, transactionCandidates, workflowEvents } from "@/db/schema/inbox";
import {
  departsFromApplication,
  memoryApplicationSchema,
  type MemoryApplication,
  type MemorySide,
} from "./answer";
import { recordMemoryUses } from "./store";

/** Consecutive undos at which a memory is turned off. */
export const MEMORY_DISABLE_AFTER_CONSECUTIVE_UNDOS = 2;

export const MEMORY_EVENT_ACTIONS = {
  applied: "memory_applied",
  confirmed: "memory_confirmed",
  undone: "memory_undone",
  superseded: "memory_superseded",
} as const;

type Ending = "confirmed" | "undone" | "superseded";

function eventKey(candidateId: string, what: "applied" | Ending, revision: number): string {
  return `memory:${candidateId}:${what}:${revision}`;
}

export interface MemoryApplicationRecord {
  appliedRevision: number;
  memoryIds: string[];
  application: MemoryApplication;
  state: "open" | Ending;
}

/** What a person (or the ledger) settled a draft as, for comparison. */
export interface SettledAnswer {
  docKind: string | null;
  partyId: string | null;
  lines: ReadonlyArray<{ side: MemorySide; accountId: string | null }>;
}

/** Record that memories answered this candidate revision, and count the hit. */
export async function recordMemoryApplied(
  db: DbExecutor,
  input: {
    orgId: string;
    inboxItemId: string;
    candidateId: string;
    candidateRevision: number;
    matchKind: string;
    memoryIds: readonly string[];
    application: MemoryApplication;
    rejected: unknown[];
  },
): Promise<void> {
  const [created] = await db
    .insert(workflowEvents)
    .values({
      organizationId: input.orgId,
      inboxItemId: input.inboxItemId,
      entityType: "transaction_candidate",
      entityId: input.candidateId,
      action: MEMORY_EVENT_ACTIONS.applied,
      actorType: "system",
      idempotencyKey: eventKey(input.candidateId, "applied", input.candidateRevision),
      data: {
        candidateRevision: input.candidateRevision,
        matchKind: input.matchKind,
        memoryIds: [...input.memoryIds],
        application: { ...input.application },
        rejected: input.rejected,
      },
    })
    .onConflictDoNothing()
    .returning({ id: workflowEvents.id });
  if (created) await recordMemoryUses(db, input.orgId, input.memoryIds);
}

/** The candidate's most recent memory application and how it ended, if it did. */
export async function latestMemoryApplication(
  db: DbExecutor,
  orgId: string,
  candidateId: string,
): Promise<MemoryApplicationRecord | null> {
  const events = await db
    .select({
      action: workflowEvents.action,
      idempotencyKey: workflowEvents.idempotencyKey,
      data: workflowEvents.data,
    })
    .from(workflowEvents)
    .where(
      and(
        eq(workflowEvents.organizationId, orgId),
        eq(workflowEvents.entityType, "transaction_candidate"),
        eq(workflowEvents.entityId, candidateId),
        inArray(workflowEvents.action, Object.values(MEMORY_EVENT_ACTIONS)),
      ),
    );
  let latest: MemoryApplicationRecord | null = null;
  for (const event of events) {
    if (event.action !== MEMORY_EVENT_ACTIONS.applied) continue;
    const revision = Number(event.data.candidateRevision);
    if (!Number.isInteger(revision)) continue;
    if (latest && latest.appliedRevision >= revision) continue;
    const application = memoryApplicationSchema.safeParse(event.data.application);
    const memoryIds = event.data.memoryIds;
    if (!application.success || !Array.isArray(memoryIds)) continue;
    latest = {
      appliedRevision: revision,
      memoryIds: memoryIds.filter((id): id is string => typeof id === "string"),
      application: application.data,
      state: "open",
    };
  }
  if (!latest) return null;
  const keys = new Set(events.map((event) => event.idempotencyKey));
  for (const ending of ["undone", "confirmed", "superseded"] as const) {
    if (keys.has(eventKey(candidateId, ending, latest.appliedRevision))) {
      latest.state = ending;
      break;
    }
  }
  return latest;
}

async function endApplication(
  db: DbExecutor,
  input: {
    orgId: string;
    candidateId: string;
    inboxItemId: string | null;
    record: MemoryApplicationRecord;
    ending: Ending;
    reason: string;
    actorType: "user" | "system";
    actorId: string | null;
  },
): Promise<boolean> {
  const [created] = await db
    .insert(workflowEvents)
    .values({
      organizationId: input.orgId,
      inboxItemId: input.inboxItemId,
      entityType: "transaction_candidate",
      entityId: input.candidateId,
      action: MEMORY_EVENT_ACTIONS[input.ending],
      actorType: input.actorType,
      actorId: input.actorId,
      idempotencyKey: eventKey(input.candidateId, input.ending, input.record.appliedRevision),
      data: {
        appliedRevision: input.record.appliedRevision,
        memoryIds: input.record.memoryIds,
        reason: input.reason,
      },
    })
    .onConflictDoNothing()
    .returning({ id: workflowEvents.id });
  return Boolean(created);
}

/** Count an undo on each memory; turn off the ones that reach the limit. */
async function countUndo(
  db: DbExecutor,
  input: { orgId: string; memoryIds: readonly string[]; candidateId: string; reason: string },
): Promise<string[]> {
  if (input.memoryIds.length === 0) return [];
  const counted = await db
    .update(classificationMemories)
    .set({
      undos: sql`${classificationMemories.undos} + 1`,
      consecutiveUndos: sql`${classificationMemories.consecutiveUndos} + 1`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(classificationMemories.organizationId, input.orgId),
        inArray(classificationMemories.id, [...input.memoryIds]),
      ),
    )
    .returning({
      id: classificationMemories.id,
      consecutiveUndos: classificationMemories.consecutiveUndos,
      enabled: classificationMemories.enabled,
    });
  const reachedLimit = counted.filter(
    (row) => row.enabled && row.consecutiveUndos >= MEMORY_DISABLE_AFTER_CONSECUTIVE_UNDOS,
  );
  if (reachedLimit.length === 0) return [];
  await db
    .update(classificationMemories)
    .set({ enabled: false, updatedAt: new Date() })
    .where(
      and(
        eq(classificationMemories.organizationId, input.orgId),
        inArray(
          classificationMemories.id,
          reachedLimit.map((row) => row.id),
        ),
      ),
    );
  await db.insert(workflowEvents).values(
    reachedLimit.map((row) => ({
      organizationId: input.orgId,
      entityType: "classification_memory",
      entityId: row.id,
      action: "memory_auto_disabled",
      actorType: "system",
      data: {
        consecutiveUndos: row.consecutiveUndos,
        limit: MEMORY_DISABLE_AFTER_CONSECUTIVE_UNDOS,
        lastCandidateId: input.candidateId,
        lastReason: input.reason,
      },
    })),
  );
  return reachedLimit.map((row) => row.id);
}

export type MemoryOutcomeNote =
  | { outcome: "none" }
  | { outcome: "kept" | "confirmed" | "superseded"; memoryIds: string[] }
  | { outcome: "undone"; memoryIds: string[]; disabled: string[] };

/**
 * A person saved a correction. If it departs from an answer a memory gave
 * this draft (and that answer is still open), count the undo.
 */
export async function noteCorrectionOfMemoryAnswer(
  db: DbExecutor,
  input: {
    orgId: string;
    candidateId: string;
    inboxItemId: string;
    userId: string;
    settled: SettledAnswer;
  },
): Promise<MemoryOutcomeNote> {
  const record = await latestMemoryApplication(db, input.orgId, input.candidateId);
  if (!record || record.state !== "open") return { outcome: "none" };
  if (!departsFromApplication(record.application, input.settled)) {
    return { outcome: "kept", memoryIds: record.memoryIds };
  }
  const ended = await endApplication(db, {
    orgId: input.orgId,
    candidateId: input.candidateId,
    inboxItemId: input.inboxItemId,
    record,
    ending: "undone",
    reason: "corrected_before_approval",
    actorType: "user",
    actorId: input.userId,
  });
  if (!ended) return { outcome: "none" };
  const disabled = await countUndo(db, {
    orgId: input.orgId,
    memoryIds: record.memoryIds,
    candidateId: input.candidateId,
    reason: "corrected_before_approval",
  });
  return { outcome: "undone", memoryIds: record.memoryIds, disabled };
}

/**
 * A draft was approved. An open memory answer approved as-is is an accepted
 * hit (consecutive_undos resets); one approved with a different answer is
 * an undo.
 */
export async function noteApprovalOfMemoryAnswer(
  db: DbExecutor,
  input: {
    orgId: string;
    candidateId: string;
    inboxItemId: string;
    actorType: "user" | "system";
    actorId: string | null;
    settled: SettledAnswer;
  },
): Promise<MemoryOutcomeNote> {
  const record = await latestMemoryApplication(db, input.orgId, input.candidateId);
  if (!record || record.state !== "open") return { outcome: "none" };
  if (departsFromApplication(record.application, input.settled)) {
    const ended = await endApplication(db, {
      orgId: input.orgId,
      candidateId: input.candidateId,
      inboxItemId: input.inboxItemId,
      record,
      ending: "undone",
      reason: "approved_with_a_different_answer",
      actorType: input.actorType,
      actorId: input.actorId,
    });
    if (!ended) return { outcome: "none" };
    const disabled = await countUndo(db, {
      orgId: input.orgId,
      memoryIds: record.memoryIds,
      candidateId: input.candidateId,
      reason: "approved_with_a_different_answer",
    });
    return { outcome: "undone", memoryIds: record.memoryIds, disabled };
  }
  const ended = await endApplication(db, {
    orgId: input.orgId,
    candidateId: input.candidateId,
    inboxItemId: input.inboxItemId,
    record,
    ending: "confirmed",
    reason: "approved_unchanged",
    actorType: input.actorType,
    actorId: input.actorId,
  });
  if (!ended) return { outcome: "none" };
  await db
    .update(classificationMemories)
    .set({ consecutiveUndos: 0, updatedAt: new Date() })
    .where(
      and(
        eq(classificationMemories.organizationId, input.orgId),
        inArray(classificationMemories.id, record.memoryIds),
      ),
    );
  return { outcome: "confirmed", memoryIds: record.memoryIds };
}

/** The system replaced a memory's lines; the open application ends without a verdict. */
export async function supersedeMemoryApplication(
  db: DbExecutor,
  input: { orgId: string; candidateId: string; inboxItemId: string | null; reason: string },
): Promise<MemoryOutcomeNote> {
  const record = await latestMemoryApplication(db, input.orgId, input.candidateId);
  if (!record || record.state !== "open") return { outcome: "none" };
  const ended = await endApplication(db, {
    ...input,
    record,
    ending: "superseded",
    actorType: "system",
    actorId: null,
  });
  return ended ? { outcome: "superseded", memoryIds: record.memoryIds } : { outcome: "none" };
}

/**
 * Posted entries were reversed or voided. Any that a memory answered, and
 * that were approved with its answer, count as undone — unless the reversal
 * came with a replacement booked to the same accounts (an amount or date
 * fix), which says nothing against the memory's classification.
 */
export async function noteReversedMemoryEntries(
  db: DbExecutor,
  input: {
    orgId: string;
    journalHeaderIds: readonly string[];
    reason: string;
    actorId: string;
    /** The corrected entry an amend-by-reversal posted in the original's place, if any. */
    replacementLines?: ReadonlyArray<{ side: MemorySide; accountId: string }>;
  },
): Promise<void> {
  if (input.journalHeaderIds.length === 0) return;
  const posted = await db
    .select({ candidateId: transactionCandidates.id, inboxItemId: inboxItems.id })
    .from(transactionCandidates)
    .leftJoin(
      inboxItems,
      and(
        eq(inboxItems.candidateId, transactionCandidates.id),
        eq(inboxItems.organizationId, input.orgId),
      ),
    )
    .where(
      and(
        eq(transactionCandidates.organizationId, input.orgId),
        inArray(transactionCandidates.postedJournalHeaderId, [...input.journalHeaderIds]),
      ),
    );
  for (const { candidateId, inboxItemId } of posted) {
    const record = await latestMemoryApplication(db, input.orgId, candidateId);
    if (!record || record.state !== "confirmed") continue;
    if (
      input.replacementLines &&
      !departsFromApplication(record.application, {
        docKind: record.application.docKind,
        partyId: record.application.partyId,
        lines: input.replacementLines,
      })
    ) {
      continue;
    }
    const ended = await endApplication(db, {
      orgId: input.orgId,
      candidateId,
      inboxItemId,
      record,
      ending: "undone",
      reason: input.reason,
      actorType: "user",
      actorId: input.actorId,
    });
    if (!ended) continue;
    await countUndo(db, {
      orgId: input.orgId,
      memoryIds: record.memoryIds,
      candidateId,
      reason: input.reason,
    });
  }
}
