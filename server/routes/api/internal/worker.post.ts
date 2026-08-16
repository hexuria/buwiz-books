/**
 * Generalized durable job worker endpoint.
 *
 * A scheduler (or the fire-and-forget self-trigger) calls this endpoint with
 * `Authorization: Bearer $INBOX_WORKER_SECRET`. An optional JSON body
 * `{ jobTypes?: string[] }` restricts the claim to specific registered job
 * types. Each call drains up to a small bound of claimable jobs and returns
 * quickly.
 */
import { createError, defineEventHandler, getHeader, readBody } from "h3";
import {
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

  let jobTypes: string[] | undefined;
  try {
    const body = (await readBody(event)) as { jobTypes?: unknown } | null | undefined;
    if (body && Array.isArray(body.jobTypes)) {
      jobTypes = body.jobTypes.filter((jobType): jobType is string => typeof jobType === "string");
    }
  } catch {
    // No body / invalid JSON — drain every registered job type.
  }

  try {
    return await runJobWorker({ jobTypes });
  } catch (error) {
    if (error instanceof ProcessingJobFailedError) {
      throw createError({ statusCode: 500, message: "Inbox worker job failed." });
    }
    throw error;
  }
});
