import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Audit PR-17 — every registered handler path reaches a terminal, FENCED
 * processing_jobs update.
 *
 * The audit found three handlers (coa-scaffold, match-assist, reflection)
 * that never wrote completion at all: their jobs stayed "running" until the
 * lease expired, got retried although the work had succeeded, and finally
 * terminalized as FAILED. Completion is now one shared fenced helper —
 * completeProcessingJob — and no handler hand-rolls the update anymore.
 */
describe("job completion wiring", () => {
  const root = join(__dirname, "../..");
  const HANDLERS_DIR = "src/lib/jobs/handlers";

  // business-group-projection owns a more elaborate fenced terminalizer
  // (completed-or-requeued in one decision); it keeps its own UPDATE.
  const OWN_TERMINALIZER = new Set(["business-group-projection.ts"]);

  it("every handler funnels completion through the shared fenced helper", () => {
    const files = readdirSync(join(root, HANDLERS_DIR)).filter((f) => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThanOrEqual(9);
    for (const file of files) {
      const source = readFileSync(join(root, HANDLERS_DIR, file), "utf-8");
      if (OWN_TERMINALIZER.has(file)) {
        // Its update must stay fenced by worker id.
        expect(source).toContain('status: "completed"');
        expect(source).toContain("processingJobs.lockedBy");
        continue;
      }
      expect(source, `${file} must call completeProcessingJob`).toContain("completeProcessingJob(");
      expect(source, `${file} hand-rolls its completion update`).not.toMatch(
        /status:\s*"completed"/,
      );
    }
  });

  it("standalone-document completes INSIDE the intake transaction", () => {
    const source = readFileSync(join(root, HANDLERS_DIR, "standalone-document.ts"), "utf-8");
    const intakeTx = source.slice(
      source.indexOf("intake = await orgTx"),
      source.indexOf("} catch (err)"),
    );
    expect(intakeTx).toContain("intakeStandaloneDocument(");
    expect(intakeTx).toContain("completeProcessingJob(tx, job.id, workerId)");
  });

  it("the match-assist dedupe key distinguishes prefill from suggest-only", () => {
    // Behavior (two flavors enqueue as two rows) is pinned in
    // tests/integration/job-completion.test.ts; the handler's import chain
    // reaches better-auth's Resend constructor, so this side pins the source.
    const source = readFileSync(join(root, HANDLERS_DIR, "match-assist.ts"), "utf-8");
    expect(source).toContain(
      'return `match_assist:${reconciliationId}${prefill ? ":prefill" : ""}`;',
    );
    expect(source).toContain(
      "matchAssistDedupeKey(input.reconciliationId, input.prefill === true)",
    );
  });
});
