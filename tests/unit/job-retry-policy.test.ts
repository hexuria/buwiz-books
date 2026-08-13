/**
 * The retry curve is only correct RELATIVE to the client that waits on it.
 *
 * Every job used to share one curve — `min(60, 2 ** (attempts - 1))` minutes,
 * eight attempts, 123 minutes to terminal — while the statement pipeline's
 * client poller gives up after ten. A permanently-broken interactive job was
 * therefore structurally incapable of reporting its own failure: the user only
 * ever saw a generic timeout.
 *
 * So these are invariant tests, not table tests. The load-bearing assertion is
 * that an interactive job reaches `failed` well INSIDE the poll window, and it
 * is written against the poller's own constant so the two cannot drift apart.
 */
import { describe, expect, it } from "vitest";
import { INTERACTIVE_JOB_TYPES, retryPolicyFor, timeToTerminalMs } from "@/lib/jobs/retry-policy";
// Imported, not copied: the server's retry budget and the client's patience
// are the two halves of this invariant, so the test must fail if either moves.
import { PIPELINE_POLL_TIMEOUT_MS } from "@/lib/jobs/polling-policy";

const BACKGROUND_JOB_TYPES = [
  "process_inbound_email",
  "process_standalone_document",
  "ai_reflection",
];

describe("interactive job retry policy", () => {
  it("covers exactly the job types an interactive client polls", () => {
    expect([...INTERACTIVE_JOB_TYPES]).toEqual([
      "statement_ocr",
      "bbox_scan",
      "match_assist",
      // Runs during onboarding, polled by getCoaScaffoldStatus.
      "coa_scaffold",
    ]);
  });

  it.each([...INTERACTIVE_JOB_TYPES])("caps %s at three attempts", (jobType) => {
    expect(retryPolicyFor(jobType).maxAttempts).toBe(3);
  });

  it.each([...INTERACTIVE_JOB_TYPES])("gives %s a seconds-scale backoff", (jobType) => {
    const policy = retryPolicyFor(jobType);
    // `attempts` arrives post-increment: the first failure is 1.
    expect(policy.backoffMs(1)).toBe(5_000);
    expect(policy.backoffMs(2)).toBe(20_000);
  });

  it.each([...INTERACTIVE_JOB_TYPES])(
    "drives %s to terminal well inside the client poll window",
    (jobType) => {
      const terminal = timeToTerminalMs(jobType);
      expect(terminal).toBe(25_000);
      // "Comfortably" below, not merely below: retry sleeps are only part of
      // the wall clock — each attempt also does real work before it fails.
      expect(terminal * 4).toBeLessThan(PIPELINE_POLL_TIMEOUT_MS);
    },
  );

  it("reads the poller's timeout as ten minutes", () => {
    // Sanity check on the source-read above; if this changes, the ratio
    // assertion above is what actually guards the invariant.
    expect(PIPELINE_POLL_TIMEOUT_MS).toBe(600_000);
  });
});

describe("background job retry policy", () => {
  it.each(BACKGROUND_JOB_TYPES)("keeps %s on the eight-attempt curve", (jobType) => {
    expect(retryPolicyFor(jobType).maxAttempts).toBe(8);
  });

  it.each(BACKGROUND_JOB_TYPES)("keeps %s on the doubling minute curve", (jobType) => {
    const policy = retryPolicyFor(jobType);
    const minutes = [1, 2, 3, 4, 5, 6, 7, 8].map((attempts) => policy.backoffMs(attempts) / 60_000);
    // Doubling, clamped at an hour: a batch job rides out a provider outage.
    expect(minutes).toEqual([1, 2, 4, 8, 16, 32, 60, 60]);
  });

  it("still takes longer to terminalize than any client would wait", () => {
    // 1 + 2 + 4 + 8 + 16 + 32 + 60 = 123 minutes. This is fine precisely
    // because nobody is watching — and is exactly why interactive types
    // needed a curve of their own.
    expect(timeToTerminalMs("process_inbound_email")).toBe(123 * 60_000);
    expect(timeToTerminalMs("process_inbound_email")).toBeGreaterThan(PIPELINE_POLL_TIMEOUT_MS);
  });

  it("falls back to the background curve for an unregistered job type", () => {
    const policy = retryPolicyFor("some_future_job_type");
    expect(policy.maxAttempts).toBe(8);
    expect(policy.backoffMs(1)).toBe(60_000);
    expect(timeToTerminalMs("some_future_job_type")).toBe(
      timeToTerminalMs("process_standalone_document"),
    );
  });

  it("never returns a negative or NaN delay for a degenerate attempt count", () => {
    for (const jobType of [...INTERACTIVE_JOB_TYPES, ...BACKGROUND_JOB_TYPES]) {
      const delay = retryPolicyFor(jobType).backoffMs(0);
      expect(Number.isFinite(delay)).toBe(true);
      expect(delay).toBeGreaterThan(0);
    }
  });
});
