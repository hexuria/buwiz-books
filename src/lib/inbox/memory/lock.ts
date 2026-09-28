// ============================================================================
// The memory test lock (Inbox v2 §7). Pure.
//
// Every saved memory writes an `ai_eval_cases` row — task `inbox_memory`,
// provenance `authored` — pairing the remembered answer with the paper it was
// saved from and the exact draft replay must produce. Replay goes through
// applyMemoryAnswer, the same function inbox stage 2 applies, with no
// database and no model: a change to replay that would give a remembered
// paper a different answer fails the lock (tests/evals/memory-lock.eval.ts,
// tests/unit/inbox-memory-lock.test.ts) before it reaches anyone's books.
//
// A case repeats no match key — only its digest — and no bank details (an
// answer has none). Ids and amounts are all it carries.
// ============================================================================

import { z } from "zod";
import {
  applicationKey,
  applyMemoryAnswer,
  memoryAnswerSchema,
  memoryApplicationSchema,
  memoryDraftSchema,
  type MemoryAnswer,
  type MemoryApplication,
  type MemoryDraft,
} from "./answer";
import { MEMORY_MATCH_KINDS, matchKeyDigest, type MemoryMatchKind } from "./keys";

export const MEMORY_LOCK_TASK = "inbox_memory";
export const MEMORY_LOCK_PROVENANCE = "authored";
/** Bump with the replay contract; recorded on each case as prompt_version_at_capture. */
export const MEMORY_REPLAY_VERSION = "inbox_memory@1";

export const memoryLockInputSchema = z.object({
  version: z.literal(1),
  memory: z.object({
    id: z.string().min(1),
    matchKind: z.enum(MEMORY_MATCH_KINDS),
    matchKeyDigest: z.string().regex(/^[0-9a-f]{64}$/u),
    answer: memoryAnswerSchema,
  }),
  paper: memoryDraftSchema,
});

export type MemoryLockInput = z.infer<typeof memoryLockInputSchema>;

export const memoryLockCaseSchema = z.object({
  name: z.string().optional(),
  task: z.literal(MEMORY_LOCK_TASK),
  provenance: z.literal(MEMORY_LOCK_PROVENANCE),
  inputRef: memoryLockInputSchema,
  expected: memoryApplicationSchema,
});

export type MemoryLockCase = z.infer<typeof memoryLockCaseSchema>;

/**
 * The lock for a memory saved from `paper`. Throws when the answer does not
 * replay onto the very paper it came from — such a memory would be broken
 * from the moment it was saved, and must not be saved at all.
 */
export function buildMemoryLock(input: {
  memoryId: string;
  matchKind: MemoryMatchKind;
  matchKey: string;
  answer: MemoryAnswer;
  paper: MemoryDraft;
}): { inputRef: MemoryLockInput; expected: MemoryApplication } {
  const applied = applyMemoryAnswer(input.answer, input.paper);
  if (!applied.ok) {
    throw new Error(`This answer does not replay onto its own paper (${applied.reason}).`);
  }
  return {
    inputRef: {
      version: 1,
      memory: {
        id: input.memoryId,
        matchKind: input.matchKind,
        matchKeyDigest: matchKeyDigest(input.matchKey),
        answer: input.answer,
      },
      paper: input.paper,
    },
    expected: applied.application,
  };
}

export type MemoryLockReplay =
  | { passed: true; expected: MemoryApplication; actual: MemoryApplication }
  | {
      passed: false;
      reason: string;
      expected?: MemoryApplication;
      actual?: MemoryApplication;
    };

/**
 * Replay one recorded case. Any shape problem, any replay failure, and any
 * difference from the recorded answer — an account, a side, a party, a kind,
 * or a single 1e-8 of an amount — fails it.
 */
export function replayMemoryLock(raw: unknown): MemoryLockReplay {
  const parsed = memoryLockCaseSchema.safeParse(raw);
  if (!parsed.success) {
    return { passed: false, reason: `malformed case: ${parsed.error.issues[0]?.message ?? ""}` };
  }
  const { inputRef, expected } = parsed.data;
  const applied = applyMemoryAnswer(inputRef.memory.answer, inputRef.paper);
  if (!applied.ok) return { passed: false, reason: applied.reason, expected };
  if (applicationKey(applied.application) !== applicationKey(expected)) {
    return {
      passed: false,
      reason: "replay differs from the recorded answer",
      expected,
      actual: applied.application,
    };
  }
  return { passed: true, expected, actual: applied.application };
}
