// ============================================================================
// Which memory answers a paper (Inbox v2 §7). Pure.
//
// Lookup order is specificity: file_hash > sender_party > party > line_text.
// Within the most specific kind that has a usable memory:
//
//   • every usable memory replays to the same answer  → hit;
//   • two usable memories replay to different answers → conflict: nothing is
//     applied, no less specific memory is consulted, and no model guesses in
//     their place — the paper goes to a person (the memory_conflict finding).
//
// "Usable" is the same server-side check a model's pick has to pass: every
// account is an active leaf of this organization whose type is still the
// type it had when the memory was saved; the party is an active party of this
// organization of a type the paper's role allows; the answer replays onto
// this draft. A memory that fails is treated as a miss for this paper and
// reported (rejected) — it never degrades to a partial answer.
// ============================================================================

import { PARTY_TYPES_FOR_ENTITY } from "@/lib/party-match/normalize";
import { counterpartyRoleFor } from "../classification-plan";
import {
  applicationKey,
  applyMemoryAnswer,
  type MemoryAnswer,
  type MemoryApplication,
  type MemoryApplyFailure,
  type MemoryDraft,
} from "./answer";
import { MEMORY_MATCH_KINDS, type MemoryMatchKind, type PaperKeys } from "./keys";

export interface MemoryChartAccount {
  id: string;
  accountType: string;
  subtype: string | null;
  isActive: boolean;
  isLeaf: boolean;
}

export interface MemoryParty {
  id: string;
  partyType: string;
  isActive: boolean;
}

export interface MemoryValidationContext {
  /** This organization's chart, by id. An id from anywhere else is simply absent. */
  accounts: ReadonlyMap<string, MemoryChartAccount>;
  /** This organization's parties named by the candidate memories, by id. */
  parties: ReadonlyMap<string, MemoryParty>;
  /** The paper's current economic event class. */
  paperEventClass: string | null;
  /** Whether a person may change this paper's kind (OCR-derived sources only). */
  paperReviewerEditable: boolean;
}

export type MemoryRejection =
  | "answer_malformed"
  | "account_missing"
  | "account_inactive"
  | "account_not_leaf"
  | "account_type_changed"
  | "account_uncategorized"
  | "party_missing"
  | "party_inactive"
  | "party_type_not_allowed"
  | "party_not_expected"
  | "doc_kind_not_editable"
  | MemoryApplyFailure;

/** Is this answer still something the books will accept, for this paper? */
export function validateMemoryAnswer(
  answer: MemoryAnswer,
  context: MemoryValidationContext,
): { ok: true } | { ok: false; reason: MemoryRejection } {
  for (const line of answer.lines) {
    const account = context.accounts.get(line.accountId);
    if (!account) return { ok: false, reason: "account_missing" };
    if (!account.isActive) return { ok: false, reason: "account_inactive" };
    if (!account.isLeaf) return { ok: false, reason: "account_not_leaf" };
    if (account.accountType !== line.accountType) {
      return { ok: false, reason: "account_type_changed" };
    }
    if (account.subtype?.startsWith("uncategorized_")) {
      return { ok: false, reason: "account_uncategorized" };
    }
  }
  const role = counterpartyRoleFor(answer.docKind);
  if (answer.partyId !== null) {
    if (role === null) return { ok: false, reason: "party_not_expected" };
    const party = context.parties.get(answer.partyId);
    if (!party) return { ok: false, reason: "party_missing" };
    if (!party.isActive) return { ok: false, reason: "party_inactive" };
    if (!PARTY_TYPES_FOR_ENTITY[role].includes(party.partyType)) {
      return { ok: false, reason: "party_type_not_allowed" };
    }
  }
  if (answer.docKind !== context.paperEventClass && !context.paperReviewerEditable) {
    return { ok: false, reason: "doc_kind_not_editable" };
  }
  return { ok: true };
}

export interface MemoryCandidate {
  id: string;
  matchKind: MemoryMatchKind;
  matchKey: string;
  enabled: boolean;
  /** Null when the stored answer does not parse. */
  answer: MemoryAnswer | null;
}

export interface RejectedMemory {
  memoryId: string;
  matchKind: MemoryMatchKind;
  reason: MemoryRejection;
}

export interface MemoryAnswerGroup {
  memoryIds: string[];
  application: MemoryApplication;
}

export type MemoryDecision =
  | { kind: "miss"; rejected: RejectedMemory[] }
  | {
      kind: "hit";
      matchKind: MemoryMatchKind;
      /** Every usable memory of this kind; they all replay to `application`. */
      memoryIds: string[];
      application: MemoryApplication;
      rejected: RejectedMemory[];
    }
  | {
      kind: "conflict";
      matchKind: MemoryMatchKind;
      memoryIds: string[];
      /** One entry per distinct answer. */
      answers: MemoryAnswerGroup[];
      rejected: RejectedMemory[];
    };

/**
 * Whether two decisions would write the same draft: same outcome, same
 * memories, same answers. Inbox stage 2 decides before its apply transaction
 * and re-decides inside it; anything that moved in between is not applied.
 */
export function sameMemoryDecision(
  left: MemoryDecision | null,
  right: MemoryDecision | null,
): boolean {
  if (!left || !right || left.kind !== right.kind) return false;
  if (left.kind === "miss" || right.kind === "miss") return left.kind === right.kind;
  if (left.matchKind !== right.matchKind) return false;
  if (left.memoryIds.join(",") !== right.memoryIds.join(",")) return false;
  const answers = (decision: MemoryDecision) =>
    decision.kind === "hit"
      ? [applicationKey(decision.application)]
      : decision.kind === "conflict"
        ? decision.answers.map((group) => applicationKey(group.application)).sort()
        : [];
  return answers(left).join("\n") === answers(right).join("\n");
}

/** Decide what the memory layer says about one paper. */
export function selectMemory(input: {
  memories: readonly MemoryCandidate[];
  keys: PaperKeys;
  draft: MemoryDraft;
  validation: MemoryValidationContext;
}): MemoryDecision {
  const rejected: RejectedMemory[] = [];
  for (const kind of MEMORY_MATCH_KINDS) {
    const keys = new Set(input.keys[kind]);
    const matched = input.memories
      .filter((memory) => memory.enabled && memory.matchKind === kind && keys.has(memory.matchKey))
      .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
    const groups = new Map<string, MemoryAnswerGroup>();
    for (const memory of matched) {
      if (!memory.answer) {
        rejected.push({ memoryId: memory.id, matchKind: kind, reason: "answer_malformed" });
        continue;
      }
      const valid = validateMemoryAnswer(memory.answer, input.validation);
      if (!valid.ok) {
        rejected.push({ memoryId: memory.id, matchKind: kind, reason: valid.reason });
        continue;
      }
      const applied = applyMemoryAnswer(memory.answer, input.draft);
      if (!applied.ok) {
        rejected.push({ memoryId: memory.id, matchKind: kind, reason: applied.reason });
        continue;
      }
      const key = applicationKey(applied.application);
      const group = groups.get(key);
      if (group) group.memoryIds.push(memory.id);
      else groups.set(key, { memoryIds: [memory.id], application: applied.application });
    }
    if (groups.size === 0) continue;
    const answers = [...groups.values()];
    const memoryIds = answers.flatMap((group) => group.memoryIds).sort();
    if (answers.length === 1) {
      return {
        kind: "hit",
        matchKind: kind,
        memoryIds,
        application: answers[0].application,
        rejected,
      };
    }
    return { kind: "conflict", matchKind: kind, memoryIds, answers, rejected };
  }
  return { kind: "miss", rejected };
}
