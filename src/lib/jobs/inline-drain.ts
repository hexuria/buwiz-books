/**
 * In-process job drain.
 *
 * Production drains the queue by having a scheduler POST the worker route.
 * There is no scheduler in local dev, which meant every enqueued job sat at
 * `queued` forever and any enqueue-then-poll UI hung until its client
 * timeout. This loop is what makes `bun run dev` work end to end.
 *
 * Two entry points, deliberately:
 *   - a periodic tick, which sweeps jobs queued before this process started
 *     (leftover dev jobs, and inbound email, which arrives by webhook with no
 *     user request to piggyback on);
 *   - a nudge from `triggerWorker`, so interactive flows start immediately
 *     instead of waiting up to one interval.
 */
import { MAX_JOBS_PER_REQUEST, ProcessingJobFailedError, runJobWorker } from "./registry";
import { setInlineNudge } from "./drain-state";
import { createLogger } from "../logger";

const logger = createLogger("jobs.inline-drain");

const DEFAULT_INTERVAL_MS = 2_000;

export interface InlineDrainOptions {
  intervalMs?: number;
  maxJobs?: number;
  /** Injectable for tests, so the loop can be exercised without a database. */
  runner?: typeof runJobWorker;
}

export interface InlineDrainHandle {
  stop(): void;
  /** Run one drain pass. Exported so tests drive the loop deterministically. */
  tick(): Promise<void>;
}

let active: InlineDrainHandle | null = null;

/**
 * Start the drain loop. Idempotent: a second call returns the running handle
 * rather than stacking a second interval.
 */
export function startInlineJobDrain(options: InlineDrainOptions = {}): InlineDrainHandle {
  if (active) return active;

  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const maxJobs = options.maxJobs ?? MAX_JOBS_PER_REQUEST;
  const runner = options.runner ?? runJobWorker;

  let inFlight = false;
  // A persistent fault (an unmigrated dev database, say) would otherwise
  // print a full stack every interval forever. Log the first occurrence and
  // then only every Nth repeat of the SAME message.
  let lastErrorMessage: string | null = null;
  let repeatCount = 0;
  // A nudge arriving mid-tick sets a single flag rather than queueing N
  // passes — otherwise a burst of enqueues would stack a tick per enqueue.
  let rerunRequested = false;
  let stopped = false;
  let pendingTypes: Set<string> | null = new Set();

  async function drainOnce(jobTypes?: string[]): Promise<void> {
    // runJobWorker already bounds itself to maxJobs, but a full batch means
    // there may be more waiting; keep going until the queue reports empty.
    for (;;) {
      const result = await runner({ jobTypes, maxJobs });
      if (!result.processed) return;
      const drained = typeof result.drained === "number" ? result.drained : 1;
      if (drained < maxJobs) return;
      if (stopped) return;
    }
  }

  async function tick(): Promise<void> {
    if (stopped || inFlight) {
      rerunRequested = true;
      return;
    }
    inFlight = true;
    try {
      do {
        rerunRequested = false;
        const types = pendingTypes && pendingTypes.size > 0 ? [...pendingTypes] : undefined;
        pendingTypes = new Set();
        try {
          await drainOnce(types);
        } catch (error) {
          // runJobWorker throws ProcessingJobFailedError BY DESIGN after it
          // has already recorded the backoff requeue (registry.ts). Letting
          // it escape a setInterval callback kills the loop — and on Bun an
          // unhandled rejection can take the process down.
          if (error instanceof ProcessingJobFailedError) {
            logger.warn("Job failed during inline drain (requeued with backoff)", {
              jobId: error.jobId,
            });
          } else {
            const message = error instanceof Error ? error.message : String(error);
            if (message === lastErrorMessage) {
              repeatCount += 1;
              if (repeatCount % 30 === 0) {
                logger.error("Inline job drain still failing", { error: message, repeatCount });
              }
            } else {
              lastErrorMessage = message;
              repeatCount = 0;
              logger.error("Inline job drain pass failed", { error: message });
            }
          }
        }
      } while (rerunRequested && !stopped);
    } finally {
      inFlight = false;
    }
  }

  const timer = setInterval(() => void tick(), intervalMs);
  // Do not hold the event loop open: `bun run dev` must still exit on Ctrl-C
  // and vitest must not hang waiting on this timer.
  timer.unref?.();

  setInlineNudge((jobTypes) => {
    if (stopped) return;
    if (jobTypes && jobTypes.length > 0 && pendingTypes) {
      for (const jobType of jobTypes) pendingTypes.add(jobType);
    } else {
      // An untyped nudge means "drain everything" — a type filter would
      // wrongly narrow the pass.
      pendingTypes = null;
    }
    void tick();
  });

  active = {
    stop() {
      stopped = true;
      clearInterval(timer);
      setInlineNudge(null);
      active = null;
    },
    tick,
  };
  return active;
}

export function getActiveInlineDrain(): InlineDrainHandle | null {
  return active;
}
