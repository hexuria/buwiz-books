// ============================================================================
// Worker self-trigger — get queued jobs running without waiting on a tick.
//
// Two delivery modes:
//   inline  — nudge the in-process drain (dev/e2e; no secret needed)
//   off     — fire-and-forget POST to the internal worker route, with an
//             external scheduler as the backstop
//
// This used to return silently when INBOX_WORKER_SECRET was unset, and to
// discard any non-2xx response. Between them, a completely unconfigured
// worker looked identical to a working one: nothing logged, nothing failed,
// and every enqueued job simply stayed `queued`. Both holes are closed here.
// ============================================================================

import { createLogger } from "../logger";
import {
  getInlineNudge,
  recordTriggerAttempt,
  recordTriggerFailure,
  recordTriggerMode,
  recordTriggerSuccess,
  recordTriggerUnconfigured,
  resolveDrainMode,
} from "./drain-state";

const logger = createLogger("jobs.trigger");

/** Log the misconfiguration once per process, not once per enqueue. */
let warnedUnconfigured = false;

function workerUrl(): string {
  const base =
    process.env.INTERNAL_WORKER_URL ??
    process.env.BETTER_AUTH_URL ??
    (process.env.PORT ? `http://127.0.0.1:${process.env.PORT}` : "http://127.0.0.1:3000");
  return `${base.replace(/\/$/, "")}/api/internal/worker`;
}

/**
 * Kick the worker to drain queued jobs (optionally only specific types).
 * Never throws and never blocks the caller beyond connection dispatch.
 */
export function triggerWorker(jobTypes?: string[]): void {
  const mode = resolveDrainMode();
  recordTriggerMode(mode);

  if (mode === "inline") {
    const nudge = getInlineNudge();
    if (nudge) {
      nudge(jobTypes);
      return;
    }
    // The Nitro plugin normally starts the drain, but a lazy start keeps the
    // dev loop working if plugin scanning ever misbehaves under the
    // TanStack Start + Nitro combination.
    void import("./inline-drain")
      .then(({ startInlineJobDrain }) => {
        startInlineJobDrain();
        getInlineNudge()?.(jobTypes);
      })
      .catch((error: unknown) => {
        logger.error("Could not start the inline job drain", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return;
  }

  const secret = process.env.INBOX_WORKER_SECRET;
  if (!secret) {
    recordTriggerUnconfigured("INBOX_WORKER_SECRET is not set");
    if (!warnedUnconfigured) {
      warnedUnconfigured = true;
      logger.error("Cannot trigger the job worker — queued jobs will not run", {
        missing: "INBOX_WORKER_SECRET",
        consequence:
          "Jobs stay queued unless an external scheduler POSTs /api/internal/worker with this secret.",
      });
    }
    return;
  }

  const url = workerUrl();
  recordTriggerAttempt();
  void fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${secret}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(jobTypes && jobTypes.length > 0 ? { jobTypes } : {}),
  })
    .then((res) => {
      if (res.ok) {
        recordTriggerSuccess();
        return;
      }
      // A 401 (wrong secret) or the route's own 500 (not configured)
      // RESOLVES — so this used to be discarded entirely, which is exactly
      // why a misconfigured worker was invisible even with the URL right.
      const detail = `worker responded ${res.status}`;
      recordTriggerFailure(detail);
      logger.error("Worker self-trigger rejected", { url, status: res.status });
    })
    .catch((err: unknown) => {
      const detail = err instanceof Error ? err.message : String(err);
      recordTriggerFailure(detail);
      logger.warn("Worker self-trigger failed (scheduler backstop will drain)", { error: detail });
    });
}
