// ============================================================================
// Memory rows (Inbox v2 §7): lookup by paper keys, the validation context a
// memory's answer is checked against, and the lookup inbox stage 2 runs.
//
// Every query filters organization_id explicitly AND runs on the caller's
// org-context executor. Background callers pass the org read from the
// candidate row (withOrgContext), request callers the session's.
// ============================================================================

import { and, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import type { DbExecutor } from "@/db";
import { accounts } from "@/db/schema/accounts";
import { classificationMemories } from "@/db/schema/classification-memories";
import { parties } from "@/db/schema/parties";
import { isReviewerEditableEconomicEventSource } from "../economic-event";
import { memoryAnswerFromColumns, type MemoryAnswer, type MemoryDraft } from "./answer";
import { derivePaperKeys, MEMORY_MATCH_KINDS, type PaperKeys } from "./keys";
import { loadPaperKeyInputs } from "./paper-keys";
import {
  selectMemory,
  type MemoryCandidate,
  type MemoryChartAccount,
  type MemoryDecision,
  type MemoryParty,
  type MemoryValidationContext,
} from "./select";

export type ClassificationMemoryRow = typeof classificationMemories.$inferSelect;

export function toMemoryCandidate(row: ClassificationMemoryRow): MemoryCandidate {
  return {
    id: row.id,
    matchKind: row.matchKind,
    matchKey: row.matchKey,
    enabled: row.enabled,
    answer: memoryAnswerFromColumns(row),
  };
}

/** The org's enabled memories whose key is one of the paper's keys. */
export async function loadMemoriesForKeys(
  db: DbExecutor,
  orgId: string,
  keys: PaperKeys,
  options: { lock?: boolean } = {},
): Promise<ClassificationMemoryRow[]> {
  const probes: SQL[] = [];
  for (const kind of MEMORY_MATCH_KINDS) {
    if (keys[kind].length === 0) continue;
    const probe = and(
      eq(classificationMemories.matchKind, kind),
      inArray(classificationMemories.matchKey, keys[kind]),
    );
    if (probe) probes.push(probe);
  }
  if (probes.length === 0) return [];
  const query = db
    .select()
    .from(classificationMemories)
    .where(
      and(
        eq(classificationMemories.organizationId, orgId),
        eq(classificationMemories.enabled, true),
        or(...probes),
      ),
    )
    .orderBy(classificationMemories.id);
  return options.lock ? query.for("update") : query;
}

/** A chart as the memory check needs it: activity, type, subtype, leafness. */
export function chartForMemory(
  chart: ReadonlyArray<{
    id: string;
    accountType: string;
    subtype: string | null;
    parentId: string | null;
    isActive: boolean;
  }>,
): Map<string, MemoryChartAccount> {
  const parentIds = new Set(
    chart.flatMap((account) => (account.parentId ? [account.parentId] : [])),
  );
  return new Map(
    chart.map((account) => [
      account.id,
      {
        id: account.id,
        accountType: account.accountType,
        subtype: account.subtype,
        isActive: account.isActive,
        isLeaf: !parentIds.has(account.id),
      },
    ]),
  );
}

/** The org's chart, for callers that do not already hold it. */
export async function loadChartForMemory(
  db: DbExecutor,
  orgId: string,
): Promise<Map<string, MemoryChartAccount>> {
  return chartForMemory(
    await db
      .select({
        id: accounts.id,
        accountType: accounts.accountType,
        subtype: accounts.subtype,
        parentId: accounts.parentId,
        isActive: accounts.isActive,
      })
      .from(accounts)
      .where(eq(accounts.organizationId, orgId)),
  );
}

/** This org's parties named by these answers. */
export async function loadAnswerParties(
  db: DbExecutor,
  orgId: string,
  answers: ReadonlyArray<MemoryAnswer | null>,
): Promise<Map<string, MemoryParty>> {
  const ids = [...new Set(answers.flatMap((answer) => (answer?.partyId ? [answer.partyId] : [])))];
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: parties.id, partyType: parties.partyType, isActive: parties.isActive })
    .from(parties)
    .where(and(eq(parties.organizationId, orgId), inArray(parties.id, ids)));
  return new Map(
    rows.map((row) => [row.id, { id: row.id, partyType: row.partyType, isActive: row.isActive }]),
  );
}

export interface MemoryLookupInput {
  orgId: string;
  candidateId: string;
  sourceRecordId: string | null;
  /** The party known without a model (already on the draft, or an exact match). */
  partyId: string | null;
  paperEventClass: string | null;
  paperRecordType: string | null;
  /** Null when the draft has no direction a memory could replay onto. */
  draft: MemoryDraft | null;
  chart: Map<string, MemoryChartAccount>;
}

export interface MemoryLookup {
  keys: PaperKeys;
  /** Null when no enabled memory has any of the paper's keys. */
  decision: MemoryDecision | null;
}

/**
 * What the memory layer says about a draft. Reads only; applying the answer
 * and counting the hit belong to the caller's apply transaction.
 */
export async function lookupMemoryForDraft(
  db: DbExecutor,
  input: MemoryLookupInput,
  options: { lock?: boolean } = {},
): Promise<MemoryLookup> {
  const paper = (
    await loadPaperKeyInputs(db, input.orgId, [
      { id: input.candidateId, sourceRecordId: input.sourceRecordId, partyId: input.partyId },
    ])
  ).get(input.candidateId)!;
  const keys = derivePaperKeys(paper);
  if (!input.draft) return { keys, decision: null };
  const rows = await loadMemoriesForKeys(db, input.orgId, keys, options);
  if (rows.length === 0) return { keys, decision: null };
  const memories = rows.map(toMemoryCandidate);
  const validation: MemoryValidationContext = {
    accounts: input.chart,
    parties: await loadAnswerParties(
      db,
      input.orgId,
      memories.map((memory) => memory.answer),
    ),
    paperEventClass: input.paperEventClass,
    paperReviewerEditable: isReviewerEditableEconomicEventSource(input.paperRecordType),
  };
  return { keys, decision: selectMemory({ memories, keys, draft: input.draft, validation }) };
}

/** Count a hit on every memory that answered. */
export async function recordMemoryUses(
  db: DbExecutor,
  orgId: string,
  memoryIds: readonly string[],
): Promise<void> {
  if (memoryIds.length === 0) return;
  await db
    .update(classificationMemories)
    .set({ uses: sql`${classificationMemories.uses} + 1`, updatedAt: new Date() })
    .where(
      and(
        eq(classificationMemories.organizationId, orgId),
        inArray(classificationMemories.id, [...memoryIds]),
      ),
    );
}
