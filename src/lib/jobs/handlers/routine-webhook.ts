/**
 * Job handler for `routine_webhook` (Inbox v2 spec §3).
 *
 * Turns one verified, recorded webhook payload into source evidence and an
 * Inbox item in `needs_information` — "Needs you". Classification arrives in
 * later build steps; until then a human supplies the entry, so the item
 * carries the same blocking `uncategorized` finding inbound email starts with.
 *
 * The organization comes from the job ROW, and the routine and ingestion event
 * are both read inside withOrgContext(job.organizationId) and must belong to
 * it — the payload alone never decides which books a paper lands in.
 * Completion and every write share one transaction, so a crash leaves nothing
 * half-made and a retry starts clean.
 */
import { and, eq, sql } from "drizzle-orm";
import { withOrgContext } from "@/db";
import {
  inboxItems,
  ingestionEvents,
  organizationAccountingSettings,
  reviewFindings,
  sourceRecordVersions,
  sourceRecords,
  transactionCandidateSources,
  transactionCandidates,
  workflowEvents,
} from "@/db/schema/inbox";
import { routines } from "@/db/schema/routines";
import { completeProcessingJob } from "@/lib/inbox/processing-job-lease";
import { createLogger } from "@/lib/logger";
import { orgDateOf } from "@/lib/org-calendar";
import type { JobContext, JobHandlerResult, ProcessingJob } from "../registry";

const logger = createLogger("jobs.routine-webhook");

/** `source_records.record_type` for a generic webhook payload. */
export const ROUTINE_WEBHOOK_RECORD_TYPE = "webhook_payload";

export async function processRoutineWebhookJob(
  job: ProcessingJob,
  ctx: JobContext,
): Promise<JobHandlerResult> {
  const { routineId, ingestionEventId } = job;
  if (!routineId || !ingestionEventId) {
    throw new Error("Routine webhook job is missing its routine or ingestion event.");
  }

  const outcome = await withOrgContext(job.organizationId, "system", "admin", async (tx) => {
    const [routine] = await tx
      .select()
      .from(routines)
      .where(and(eq(routines.organizationId, job.organizationId), eq(routines.id, routineId)))
      .limit(1);
    if (!routine) throw new Error("The routine behind this webhook job was not found.");
    const [event] = await tx
      .select()
      .from(ingestionEvents)
      .where(
        and(
          eq(ingestionEvents.organizationId, job.organizationId),
          eq(ingestionEvents.id, ingestionEventId),
          eq(ingestionEvents.routineId, routine.id),
        ),
      )
      .limit(1);
    if (!event) throw new Error("The webhook ingestion event for this job was not found.");

    if (!(await completeProcessingJob(tx, job.id, ctx.workerId))) return null;

    await tx.execute(sql`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${"routine-webhook:" + job.organizationId + ":" + event.id}, 0::bigint)
      )
    `);
    const [existing] = await tx
      .select({ sourceRecordId: sourceRecords.id, inboxItemId: inboxItems.id })
      .from(sourceRecords)
      .leftJoin(inboxItems, eq(inboxItems.sourceRecordId, sourceRecords.id))
      .where(
        and(
          eq(sourceRecords.organizationId, job.organizationId),
          eq(sourceRecords.ingestionEventId, event.id),
          eq(sourceRecords.recordType, ROUTINE_WEBHOOK_RECORD_TYPE),
        ),
      )
      .limit(1);
    if (existing) {
      // Already materialized (a manual re-enqueue): converge, don't duplicate.
      await tx
        .update(ingestionEvents)
        .set({ status: "processed", processedAt: new Date() })
        .where(
          and(
            eq(ingestionEvents.organizationId, job.organizationId),
            eq(ingestionEvents.id, event.id),
          ),
        );
      return { inboxItemId: existing.inboxItemId, deduplicated: true };
    }

    const [settings] = await tx
      .select({
        baseCurrency: organizationAccountingSettings.baseCurrency,
        timezone: organizationAccountingSettings.timezone,
      })
      .from(organizationAccountingSettings)
      .where(eq(organizationAccountingSettings.organizationId, job.organizationId))
      .limit(1);
    const baseCurrency = settings?.baseCurrency ?? "USD";
    // The paper's day on the organization's own calendar, not the UTC day.
    const transactionDate = orgDateOf(
      event.occurredAt ?? event.receivedAt,
      settings?.timezone ?? "UTC",
    );
    const eventId = event.providerEventId ?? event.id;
    const description = `Webhook event ${eventId} from ${routine.name}`;
    const rawData = {
      routineId: routine.id,
      eventId,
      payloadHash: event.payloadHash,
      payload: event.payload ?? {},
    };

    const [sourceRecord] = await tx
      .insert(sourceRecords)
      .values({
        organizationId: job.organizationId,
        sourceId: event.sourceId,
        ingestionEventId: event.id,
        recordType: ROUTINE_WEBHOOK_RECORD_TYPE,
        externalId: eventId,
        externalVersion: "1",
        providerStatus: "needs_information",
        transactionDate,
        description,
        rawData,
      })
      .returning();
    await tx.insert(sourceRecordVersions).values({
      organizationId: job.organizationId,
      sourceRecordId: sourceRecord.id,
      ingestionEventId: event.id,
      externalVersion: "1",
      payloadHash: event.payloadHash,
      providerStatus: "needs_information",
      rawData,
      occurredAt: event.occurredAt,
    });
    const [candidate] = await tx
      .insert(transactionCandidates)
      .values({
        organizationId: job.organizationId,
        sourceRecordId: sourceRecord.id,
        candidateType: "webhook_transaction",
        transactionDate,
        transactionType: "journal",
        memo: description,
        originalCurrency: baseCurrency,
        functionalCurrency: baseCurrency,
        exchangeRate: "1",
      })
      .returning();
    await tx.insert(transactionCandidateSources).values({
      organizationId: job.organizationId,
      candidateId: candidate.id,
      sourceRecordId: sourceRecord.id,
      relationship: "origin",
      isPrimary: true,
    });
    const [inboxItem] = await tx
      .insert(inboxItems)
      .values({
        organizationId: job.organizationId,
        candidateId: candidate.id,
        sourceRecordId: sourceRecord.id,
        itemType: "classify_source_record",
        state: "needs_information",
        title: `${routine.name}: event ${eventId}`.slice(0, 255),
      })
      .returning();
    await tx.insert(reviewFindings).values({
      organizationId: job.organizationId,
      inboxItemId: inboxItem.id,
      candidateId: candidate.id,
      ruleKey: "uncategorized",
      impact: "blocking",
      subjectType: "transaction_candidate",
      subjectId: candidate.id,
      fingerprint: `${candidate.id}:1:uncategorized`,
      message: "The webhook payload still needs transaction details and accounting categories.",
      evidence: { source: "routine_webhook", routineId: routine.id, eventId },
    });
    await tx
      .insert(workflowEvents)
      .values({
        organizationId: job.organizationId,
        inboxItemId: inboxItem.id,
        entityType: "inbox_item",
        entityId: inboxItem.id,
        action: "received",
        actorType: "system",
        idempotencyKey: `routine-webhook:${event.id}:received`,
        data: { routineId: routine.id, eventId, ingestionEventId: event.id },
      })
      .onConflictDoNothing();
    await tx
      .update(ingestionEvents)
      .set({ status: "processed", processedAt: new Date() })
      .where(
        and(
          eq(ingestionEvents.organizationId, job.organizationId),
          eq(ingestionEvents.id, event.id),
        ),
      );
    return { inboxItemId: inboxItem.id, deduplicated: false };
  });

  if (!outcome) {
    logger.warn("Routine webhook lease expired before completion; successor owns the job", {
      jobId: job.id,
      workerId: ctx.workerId,
    });
    return { processed: false, reason: "lease_lost", jobId: job.id };
  }
  return { processed: true, jobId: job.id, ...outcome };
}
