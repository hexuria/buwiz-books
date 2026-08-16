import { and, desc, eq, or, sql } from "drizzle-orm";
import type { DbExecutor } from "@/db";
import {
  inboxItems,
  processingJobs,
  reviewFindings,
  sourceRecords,
  transactionCandidates,
  workflowEvents,
} from "@/db/schema/inbox";

export async function requeueFailedInboundEmailJob(
  db: DbExecutor,
  input: {
    organizationId: string;
    emailId: string;
  },
) {
  const dedupeKey = `resend-email:${input.emailId}`;
  const [failed] = await db
    .select()
    .from(processingJobs)
    .where(
      and(
        eq(processingJobs.organizationId, input.organizationId),
        eq(processingJobs.dedupeKey, dedupeKey),
        or(
          eq(processingJobs.status, "failed"),
          and(
            eq(processingJobs.status, "queued"),
            sql`${processingJobs.attempts} >= ${processingJobs.maxAttempts}`,
          ),
        ),
      ),
    )
    .orderBy(desc(processingJobs.updatedAt))
    .for("update")
    .limit(1);
  if (!failed) return null;

  const payload = failed.payload as {
    sourceRecordId?: string;
    inboxItemId?: string;
  };
  if (!payload.inboxItemId || !payload.sourceRecordId) return null;

  const [unresolvedFailure] = await db
    .select({
      inboxItemId: inboxItems.id,
      sourceRecordId: sourceRecords.id,
    })
    .from(inboxItems)
    .innerJoin(transactionCandidates, eq(inboxItems.candidateId, transactionCandidates.id))
    .innerJoin(
      reviewFindings,
      and(
        eq(reviewFindings.inboxItemId, inboxItems.id),
        eq(reviewFindings.candidateId, transactionCandidates.id),
      ),
    )
    .innerJoin(
      sourceRecords,
      and(
        eq(sourceRecords.id, payload.sourceRecordId),
        eq(sourceRecords.organizationId, inboxItems.organizationId),
      ),
    )
    .where(
      and(
        eq(inboxItems.organizationId, input.organizationId),
        eq(inboxItems.id, payload.inboxItemId),
        eq(inboxItems.state, "needs_information"),
        eq(transactionCandidates.status, "current"),
        eq(reviewFindings.organizationId, input.organizationId),
        eq(reviewFindings.ruleKey, "source_processing_failed"),
        eq(reviewFindings.state, "open"),
        eq(reviewFindings.subjectId, failed.id),
      ),
    )
    .for("update", { of: [inboxItems, transactionCandidates, reviewFindings, sourceRecords] })
    .limit(1);
  if (!unresolvedFailure) return null;

  const now = new Date();
  const [requeued] = await db
    .update(processingJobs)
    .set({
      status: "queued",
      attempts: 0,
      runAt: now,
      lockedBy: null,
      lockedUntil: null,
      lastError: null,
      completedAt: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(processingJobs.id, failed.id),
        eq(processingJobs.organizationId, input.organizationId),
        or(
          eq(processingJobs.status, "failed"),
          and(
            eq(processingJobs.status, "queued"),
            sql`${processingJobs.attempts} >= ${processingJobs.maxAttempts}`,
          ),
        ),
      ),
    )
    .returning();
  if (!requeued) return null;

  await db
    .update(inboxItems)
    .set({
      state: "processing",
      lockVersion: sql`${inboxItems.lockVersion} + 1`,
      updatedAt: now,
    })
    .where(
      and(
        eq(inboxItems.organizationId, input.organizationId),
        eq(inboxItems.id, unresolvedFailure.inboxItemId),
        eq(inboxItems.state, "needs_information"),
      ),
    );
  await db
    .update(sourceRecords)
    .set({ providerStatus: "processing", updatedAt: now })
    .where(
      and(
        eq(sourceRecords.organizationId, input.organizationId),
        eq(sourceRecords.id, unresolvedFailure.sourceRecordId),
      ),
    );
  await db
    .insert(workflowEvents)
    .values({
      organizationId: input.organizationId,
      inboxItemId: payload.inboxItemId,
      entityType: "processing_job",
      entityId: requeued.id,
      action: "failed_job_requeued",
      actorType: "system",
      idempotencyKey: `inbox-job:${requeued.id}:requeued:${failed.updatedAt.toISOString()}`,
      data: {
        source: "resend",
        emailId: input.emailId,
        previousAttempts: failed.attempts,
        previousError: failed.lastError,
      },
    })
    .onConflictDoNothing();
  return requeued;
}
