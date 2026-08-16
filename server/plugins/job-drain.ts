/**
 * Starts the in-process job drain (dev) or self-checks the worker wiring
 * (production) once per server process.
 *
 * The startup sweep matters beyond convenience: it is the only path that
 * picks up jobs enqueued BEFORE this process started. Request-triggered
 * nudges cannot do that, and inbound email arrives by webhook with no
 * subsequent user request to piggyback on.
 */
import { resolveDrainMode, recordTriggerMode } from "../../src/lib/jobs/drain-state";
import { startInlineJobDrain } from "../../src/lib/jobs/inline-drain";
import { createLogger } from "../../src/lib/logger";
import { startProjectionNotificationListener } from "../../src/lib/jobs/projection-listener";

const logger = createLogger("jobs.drain-plugin");

async function selfCheckHttpWorker(): Promise<void> {
  const secret = process.env.INBOX_WORKER_SECRET;
  if (!secret) {
    // Loud on purpose: `logger.error` forwards to the error-reporting
    // backend. Without this, a missing secret makes triggerWorker a silent
    // no-op and every queued job sits at `queued` indefinitely.
    logger.error("Job worker is not configured — queued jobs will never run", {
      missing: "INBOX_WORKER_SECRET",
      consequence:
        "Set the secret and configure a scheduler to POST /api/internal/worker, or set JOB_DRAIN_MODE=inline.",
    });
    return;
  }

  const base =
    process.env.INTERNAL_WORKER_URL ??
    process.env.BETTER_AUTH_URL ??
    (process.env.PORT ? `http://127.0.0.1:${process.env.PORT}` : "http://127.0.0.1:3000");
  const url = `${base.replace(/\/$/, "")}/api/internal/worker`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: "{}",
    });
    if (!res.ok) {
      logger.error("Job worker self-check failed", { url, status: res.status });
    }
  } catch (error) {
    logger.error("Job worker self-check could not reach the worker route", {
      url,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export default function jobDrainPlugin() {
  startProjectionNotificationListener();
  const mode = resolveDrainMode();
  recordTriggerMode(mode);

  if (mode === "inline") {
    startInlineJobDrain();
    logger.info("Inline job drain started", { mode });
    return;
  }

  if (process.env.NODE_ENV === "production") {
    // Deliberately not awaited and never fatal: a background-worker
    // misconfiguration must not crash-loop the whole service on Cloud Run.
    void selfCheckHttpWorker();
  }
}
