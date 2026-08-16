/**
 * Durable Inbox worker endpoint.
 *
 * A scheduler calls this endpoint with `Authorization: Bearer $INBOX_WORKER_SECRET`.
 * Each call claims one queued job, processes it idempotently, and returns quickly.
 *
 * Thin alias over the shared job runner, pinned to the Inbox job types and a
 * single job per call so the existing external scheduler configuration keeps
 * working unchanged. New job types belong to /api/internal/worker.
 */
import { createError, defineEventHandler, getHeader } from "h3";
import {
  INBOX_JOB_TYPES,
  ProcessingJobFailedError,
  isWorkerRequestAuthorized,
  runJobWorker,
} from "../../../../src/lib/jobs/registry";

export default defineEventHandler(async (event) => {
  const workerSecret = process.env.INBOX_WORKER_SECRET;
  if (!workerSecret) {
    throw createError({
      statusCode: 500,
      message: "Inbox worker is not configured.",
    });
  }
  if (!isWorkerRequestAuthorized(getHeader(event, "authorization"), workerSecret)) {
    throw createError({ statusCode: 401, message: "Unauthorized." });
  }

  try {
    return await runJobWorker({ jobTypes: INBOX_JOB_TYPES, maxJobs: 1 });
  } catch (error) {
    if (error instanceof ProcessingJobFailedError) {
      throw createError({ statusCode: 500, message: "Inbox worker job failed." });
    }
    throw error;
  }
});
