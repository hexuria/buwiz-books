import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { MemoryAnswer } from "../../src/lib/inbox/memory/answer";
import {
  MEMORY_LOCK_PROVENANCE,
  MEMORY_LOCK_TASK,
  buildMemoryLock,
  replayMemoryLock,
  type MemoryLockCase,
} from "../../src/lib/inbox/memory/lock";
import { matchKeyDigest } from "../../src/lib/inbox/memory/keys";

/**
 * The memory test lock, in the suite CI runs on every push (deploy.yml runs
 * unit, component and integration — not the recorded evals). Every authored
 * inbox_memory case in the checked-in fixture must replay exactly through the
 * pure apply function; tests/evals/memory-lock.eval.ts replays the same file.
 */

const fixture = JSON.parse(
  readFileSync(join(__dirname, "../evals/fixtures/inbox-memory-locks.json"), "utf8"),
) as { cases: MemoryLockCase[] };

const OFFICE = "1a0c5a52-6f1e-4c43-9a57-3b0f6f0d1001";
const POSTAGE = "1a0c5a52-6f1e-4c43-9a57-3b0f6f0d1002";

describe("checked-in memory locks", () => {
  it("are all authored inbox_memory cases", () => {
    expect(fixture.cases.length).toBeGreaterThan(0);
    for (const testCase of fixture.cases) {
      expect(testCase.task).toBe(MEMORY_LOCK_TASK);
      expect(testCase.provenance).toBe(MEMORY_LOCK_PROVENANCE);
    }
  });

  for (const testCase of fixture.cases) {
    it(`replays exactly: ${testCase.name}`, () => {
      const replay = replayMemoryLock(testCase);
      expect(replay, JSON.stringify(replay)).toMatchObject({ passed: true });
    });
  }
});

describe("the lock bites", () => {
  const base = fixture.cases[0];

  function tampered(mutate: (copy: MemoryLockCase) => void): MemoryLockCase {
    const copy = structuredClone(base);
    mutate(copy);
    return copy;
  }

  it("fails when replay would post to another account", () => {
    const replay = replayMemoryLock(
      tampered((copy) => {
        copy.expected.lines[0].accountId = POSTAGE;
      }),
    );
    expect(replay).toMatchObject({
      passed: false,
      reason: "replay differs from the recorded answer",
    });
  });

  it("fails on a single 1e-8 of difference", () => {
    const replay = replayMemoryLock(
      tampered((copy) => {
        copy.inputRef.paper.total = "84.25000001";
      }),
    );
    expect(replay.passed).toBe(false);
  });

  it("fails when the party or the kind of paper differs", () => {
    expect(
      replayMemoryLock(
        tampered((copy) => {
          copy.expected.partyId = null;
        }),
      ).passed,
    ).toBe(false);
    expect(
      replayMemoryLock(
        tampered((copy) => {
          copy.expected.docKind = "bill_accrual";
        }),
      ).passed,
    ).toBe(false);
  });

  it("fails when the answer no longer replays at all", () => {
    expect(
      replayMemoryLock(
        tampered((copy) => {
          copy.inputRef.paper.direction = "inflow";
        }),
      ),
    ).toMatchObject({ passed: false, reason: "direction_mismatch" });
  });

  it("fails a malformed case rather than skipping it", () => {
    expect(replayMemoryLock({ ...base, task: "inbox_classification" }).passed).toBe(false);
    expect(replayMemoryLock({ ...base, provenance: "curated_from_feedback" }).passed).toBe(false);
    expect(replayMemoryLock(null).passed).toBe(false);
  });
});

describe("buildMemoryLock", () => {
  const answer: MemoryAnswer = {
    docKind: "purchase",
    partyId: null,
    lines: [
      {
        lineMatch: { side: "debit", index: 0 },
        accountId: OFFICE,
        accountType: "expense",
        amount: "12.5",
        currency: "USD",
        taxCode: null,
      },
      {
        lineMatch: { side: "credit", index: 0 },
        accountId: POSTAGE,
        accountType: "liability",
        amount: "12.5",
        currency: "USD",
        taxCode: null,
      },
    ],
  };

  it("records a case that replays, with only a digest of the key", () => {
    const lock = buildMemoryLock({
      memoryId: "memory-1",
      matchKind: "sender_party",
      matchKey: "billing@acme.test|",
      answer,
      paper: { direction: "outflow", total: "12.5", currency: "USD" },
    });
    expect(lock.inputRef.memory.matchKeyDigest).toBe(matchKeyDigest("billing@acme.test|"));
    expect(JSON.stringify(lock)).not.toContain("billing@acme.test");
    expect(
      replayMemoryLock({
        task: MEMORY_LOCK_TASK,
        provenance: MEMORY_LOCK_PROVENANCE,
        inputRef: lock.inputRef,
        expected: lock.expected,
      }),
    ).toMatchObject({ passed: true });
  });

  it("refuses an answer that does not replay onto its own paper", () => {
    expect(() =>
      buildMemoryLock({
        memoryId: "memory-1",
        matchKind: "file_hash",
        matchKey: "a".repeat(64),
        answer,
        paper: { direction: "inflow", total: "12.5", currency: "USD" },
      }),
    ).toThrow(/direction_mismatch/u);
  });
});
