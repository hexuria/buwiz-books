/**
 * Starts the in-process job drain (dev) or self-checks the worker wiring
 * (production) once per server process.
 *
 * The startup sweep matters beyond convenience: it is the only path that
 * picks up jobs enqueued BEFORE this process started. Request-triggered
 * nudges cannot do that, and inbound email arrives by webhook with no
 * subsequent user request to piggyback on.
 *
 * Production with the HTTP drain and no INBOX_WORKER_SECRET refuses to start
 * (Inbox v2 spec §3). Logging it was not enough: the service came up healthy,
 * accepted every webhook and upload, and queued work that could never run.
 */
import {
  resolveDrainMode,
  recordTriggerMode,
  type DrainMode,
} from "../../src/lib/jobs/drain-state";
import { startInlineJobDrain } from "../../src/lib/jobs/inline-drain";
import { createLogger } from "../../src/lib/logger";
import { startProjectionNotificationListener } from "../../src/lib/jobs/projection-listener";

const logger = createLogger("jobs.drain-plugin");

/**
 * Thrown at startup, never caught: a production process whose queued jobs can
 * never run must not report itself healthy.
 */
export function assertProductionWorkerConfigured(mode: DrainMode): void {
  if (process.env.NODE_ENV !== "production" || mode !== "off") return;
  if (process.env.INBOX_WORKER_SECRET) return;
  throw new Error(
    "Job worker is not configured: INBOX_WORKER_SECRET is not set, so queued jobs would never run. " +
      "Set the secret and configure a scheduler to POST /api/internal/worker, or set JOB_DRAIN_MODE=inline.",
  );
}

async function selfCheckHttpWorker(secret: string): Promise<void> {
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
  const mode = resolveDrainMode();
  assertProductionWorkerConfigured(mode);
  startProjectionNotificationListener();
  recordTriggerMode(mode);

  if (mode === "inline") {
    startInlineJobDrain();
    logger.info("Inline job drain started", { mode });
    return;
  }

  const secret = process.env.INBOX_WORKER_SECRET;
  if (process.env.NODE_ENV === "production" && secret) {
    // Deliberately not awaited and never fatal: a transient self-check
    // failure (the route not listening yet) must not crash-loop the service.
    // A MISSING secret is different and already threw above.
    void selfCheckHttpWorker(secret);
  }
}
