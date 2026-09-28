// ============================================================================
// Memory test lock (recorded mode — NO network, NO database).
//
// Every `authored` inbox_memory case in the checked-in fixture replays through
// applyMemoryAnswer, the function inbox stage 2 applies a memory with. The
// replayed draft must equal the recorded one exactly — account, side, party,
// kind of paper, and every amount to 1e-8 — or the lock fails. Memories are
// answered with no model at all, so live mode has nothing to add here.
//
// CI runs this with the recorded evals (deploy.yml), next to the rule
// scorecard gate. tests/unit/inbox-memory-lock.test.ts covers the lock's own
// behavior: that replay catches drift, and what a lock is built from.
// ============================================================================
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MEMORY_LOCK_PROVENANCE,
  MEMORY_LOCK_TASK,
  replayMemoryLock,
} from "../../src/lib/inbox/memory/lock";

const MODE = process.env.AI_EVALS_MODE ?? "recorded";

const fixture = JSON.parse(
  readFileSync(join(__dirname, "fixtures/inbox-memory-locks.json"), "utf8"),
) as { cases: Array<{ name?: string; task?: string; provenance?: string }> };

const lockCases = fixture.cases.filter(
  (testCase) =>
    testCase.task === MEMORY_LOCK_TASK && testCase.provenance === MEMORY_LOCK_PROVENANCE,
);

describe(`memory test lock (mode: ${MODE})`, () => {
  it("has authored inbox_memory cases to replay", () => {
    expect(lockCases.length).toBeGreaterThan(0);
    // Nothing in the fixture escapes the lock by carrying another label.
    expect(lockCases).toHaveLength(fixture.cases.length);
  });

  for (const [index, testCase] of lockCases.entries()) {
    it(`replays exactly: ${testCase.name ?? `case ${index + 1}`}`, () => {
      const replay = replayMemoryLock(testCase);
      if (!replay.passed) {
        throw new Error(
          `${replay.reason}\nexpected=${JSON.stringify(replay.expected)}\nactual=${JSON.stringify(replay.actual)}`,
        );
      }
      expect(replay.actual).toEqual(replay.expected);
    });
  }
});
