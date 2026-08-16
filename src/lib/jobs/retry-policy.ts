/**
 * Per-job-class retry curves.
 *
 * Every job used to share one curve: `min(60, 2 ** (attempts - 1))` MINUTES
 * with `maxAttempts` defaulting to 8. That sums to 1+2+4+8+16+32+60 = 123
 * minutes before a job is finally marked `failed` — while the clients that
 * poll these jobs give up after 10. A permanently-broken interactive job was
 * therefore structurally incapable of ever reporting its failure to the user;
 * they saw a generic timeout instead of the real error.
 *
 * The fix is not a shorter global curve — batch ingestion genuinely wants to
 * retry across an hour-long provider outage. It is recognising that a job a
 * human is actively waiting on has a different deadline from one that is not.
 *
 * `maxAttempts` is a per-row column with a default, so the interactive
 * ceiling is set at enqueue time and needs no migration.
 */

export interface RetryPolicy {
  /** Attempt ceiling, written to `processing_jobs.max_attempts` at enqueue. */
  maxAttempts: number;
  /**
   * Delay before the next attempt. `attempts` is the post-increment count of
   * the attempt that just failed (the claim bumps it), so the first failure
   * arrives here as 1.
   */
  backoffMs(attempts: number): number;
}

/**
 * A human is watching a spinner. Fail fast and tell them, rather than
 * retrying quietly for two hours past the point they gave up.
 */
const INTERACTIVE: RetryPolicy = {
  maxAttempts: 3,
  backoffMs: (attempts) => (attempts <= 1 ? 5_000 : 20_000),
};

/** Nobody is waiting; ride out provider outages. The historical curve. */
const BACKGROUND: RetryPolicy = {
  maxAttempts: 8,
  backoffMs: (attempts) => Math.min(60, 2 ** Math.max(0, attempts - 1)) * 60_000,
};

/** Jobs an interactive client enqueues and then polls to completion. */
export const INTERACTIVE_JOB_TYPES = [
  "statement_ocr",
  "bbox_scan",
  "match_assist",
  "coa_scaffold",
] as const;

const POLICIES: Record<string, RetryPolicy> = {
  statement_ocr: INTERACTIVE,
  bbox_scan: INTERACTIVE,
  match_assist: INTERACTIVE,
  // Runs during onboarding with someone watching a spinner.
  coa_scaffold: INTERACTIVE,
  process_inbound_email: BACKGROUND,
  process_standalone_document: BACKGROUND,
  ai_reflection: BACKGROUND,
  business_group_projection_refresh: BACKGROUND,
};

export function retryPolicyFor(jobType: string): RetryPolicy {
  return POLICIES[jobType] ?? BACKGROUND;
}

/** Worst-case time from first failure to terminal `failed`, for a job type. */
export function timeToTerminalMs(jobType: string): number {
  const policy = retryPolicyFor(jobType);
  let total = 0;
  for (let attempt = 1; attempt < policy.maxAttempts; attempt += 1) {
    total += policy.backoffMs(attempt);
  }
  return total;
}
