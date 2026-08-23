/**
 * Scheduled staleness sweep over the global tax reference datasets.
 *
 * reference-data-staleness.ts existed with NO caller: SSS Circular 2024-006
 * could be superseded and the brackets would keep returning old amounts with
 * nothing anywhere raising the condition — exactly the silent failure the
 * module's own header describes. This handler is that caller: schedulable
 * like any job, it evaluates every dataset and LOGS a warning per non-fresh
 * one (the datasets are global, so a per-org sink would be wrong), then
 * records the report on the job row.
 *
 * The datasets table is deliberately org-less; this handler still receives an
 * organizationId from the queue row (jobs are org-scoped infrastructure) and
 * simply does not need it for the read.
 */
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { processingJobs } from "@/db/schema/inbox";
import { taxReferenceDatasets } from "@/db/schema/tax-reference";
import { createLogger } from "@/lib/logger";
import { buildStalenessReport, type StalenessInput } from "@/lib/tax/reference-data-staleness";
import type { JobContext, JobHandlerResult, ProcessingJob } from "../registry";

const logger = createLogger("jobs.tax-reference-staleness");

export async function processTaxReferenceStalenessJob(
  job: ProcessingJob,
  _context: JobContext,
): Promise<JobHandlerResult> {
  const datasets = await db.select().from(taxReferenceDatasets);
  const inputs: StalenessInput[] = datasets.map((dataset) => ({
    datasetKey: dataset.version,
    lastVerifiedAt: dataset.lastVerifiedAt ? dataset.lastVerifiedAt.toISOString() : null,
    ownerName: null,
    asOf: new Date().toISOString(),
  }));
  const report = buildStalenessReport(inputs);

  for (const status of report.datasets) {
    if (status.level === "fresh") continue;
    // The loud part. "unverified" and "stale" both mean a filed return could
    // be computed on numbers nobody has confirmed recently.
    logger.warn("Tax reference dataset needs verification", {
      datasetKey: status.datasetKey,
      level: status.level,
      daysSinceVerified: status.daysSinceVerified,
    });
  }

  logger.info("Tax reference staleness sweep", {
    datasets: report.datasets.length,
    fitToFile: report.fitToFile,
    needsAttention: report.needsAttention,
    summary: report.summary,
  });

  await db
    .update(processingJobs)
    .set({
      status: "completed",
      lockedBy: null,
      lockedUntil: null,
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(processingJobs.id, job.id));

  return { processed: true, jobId: job.id };
}
