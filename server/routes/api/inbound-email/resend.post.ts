/**
 * Nitro route: POST /api/inbound-email/resend
 *
 * Verifies Resend/Svix signatures, resolves the receiving address to one tenant,
 * preserves the provider event idempotently, and creates an Inbox source item
 * before any asynchronous attachment/OCR work begins.
 */
import { createError, defineEventHandler, getHeader, readRawBody } from "h3";
import { Resend } from "resend";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../../../src/db";
import {
  inboxItems,
  ingestionEvents,
  integrationSources,
  organizationAccountingSettings,
  processingJobs,
  reviewFindings,
  sourceRecordVersions,
  sourceRecords,
  transactionCandidateSources,
  transactionCandidates,
  workflowEvents,
} from "../../../../src/db/schema/inbox";
import { requeueFailedInboundEmailJob } from "../../../../src/lib/inbox/inbound-email-job";
import { triggerWorker } from "../../../../src/lib/jobs/trigger";
import { createLogger } from "../../../../src/lib/logger";

const logger = createLogger("api.inbound-email.resend");

export default defineEventHandler(async (event) => {
  const apiKey = process.env.RESEND_API_KEY;
  const webhookSecret = process.env.RESEND_WEBHOOK_SECRET;
  if (!apiKey || !webhookSecret) {
    throw createError({
      statusCode: 500,
      message: "Inbound email is not configured.",
    });
  }
  const rawBody = await readRawBody(event);
  const id = getHeader(event, "svix-id");
  const timestamp = getHeader(event, "svix-timestamp");
  const signature = getHeader(event, "svix-signature");
  if (!rawBody || !id || !timestamp || !signature) {
    throw createError({
      statusCode: 400,
      message: "Missing webhook body or signature.",
    });
  }

  const resend = new Resend(apiKey);
  let payload;
  try {
    payload = resend.webhooks.verify({
      payload: rawBody,
      headers: { id, timestamp, signature },
      webhookSecret,
    });
  } catch (error) {
    logger.warn("Inbound email signature verification failed", {
      error: String(error),
    });
    throw createError({
      statusCode: 400,
      message: "Invalid webhook signature.",
    });
  }
  if (payload.type !== "email.received") return { received: true, ignored: true };

  const recipients = payload.data.to.map((address) => address.trim().toLowerCase());
  // Checkpoint C9: an email addressed to inboxes of SEVERAL organizations is
  // delivered to every matched org. The old .limit(1) silently picked
  // whichever settings row the planner returned first and dropped the rest —
  // the other tenant's books simply never saw their document.
  const matchedSettings = await db
    .select({
      organizationId: organizationAccountingSettings.organizationId,
      inboundEmailAddress: organizationAccountingSettings.inboundEmailAddress,
      baseCurrency: organizationAccountingSettings.baseCurrency,
    })
    .from(organizationAccountingSettings)
    .where(
      inArray(
        sql<string>`lower(${organizationAccountingSettings.inboundEmailAddress})`,
        recipients,
      ),
    );
  if (matchedSettings.length === 0) {
    logger.warn("Inbound email recipient is not assigned to an organization", {
      recipients,
    });
    return { received: true, ignored: true };
  }

  const deliveries: Array<Record<string, unknown> & { organizationId: string }> = [];
  for (const settings of matchedSettings) {
    const outcome = await db.transaction(async (tx) => {
      const [source] = await tx
        .insert(integrationSources)
        .values({
          organizationId: settings.organizationId,
          provider: "resend",
          channel: "email",
          externalSourceId: "resend:email",
          name: "Inbound email",
        })
        .onConflictDoUpdate({
          target: [
            integrationSources.organizationId,
            integrationSources.provider,
            integrationSources.externalSourceId,
          ],
          targetWhere: sql`${integrationSources.externalSourceId} is not null`,
          set: { updatedAt: new Date() },
        })
        .returning();

      const [ingestionEvent] = await tx
        .insert(ingestionEvents)
        .values({
          organizationId: settings.organizationId,
          sourceId: source.id,
          channel: "email",
          provider: "resend",
          providerEventId: id,
          externalObjectId: payload.data.email_id,
          externalVersion: "1",
          payload: JSON.parse(rawBody) as Record<string, unknown>,
          headers: { "svix-id": id, "svix-timestamp": timestamp },
          status: "received",
          occurredAt: new Date(payload.created_at),
        })
        .onConflictDoNothing()
        .returning();
      if (!ingestionEvent) {
        const [existingEvent] = await tx
          .select({ id: ingestionEvents.id })
          .from(ingestionEvents)
          .where(
            and(
              eq(ingestionEvents.organizationId, settings.organizationId),
              eq(ingestionEvents.provider, "resend"),
              eq(ingestionEvents.providerEventId, id),
            ),
          )
          .limit(1);
        if (existingEvent) {
          await tx
            .insert(workflowEvents)
            .values({
              organizationId: settings.organizationId,
              entityType: "ingestion_event",
              entityId: existingEvent.id,
              action: "exact_replay_suppressed",
              actorType: "system",
              idempotencyKey: `exact-replay:ingestion:${existingEvent.id}`,
              data: { replayType: "provider_identity", provider: "resend" },
            })
            .onConflictDoNothing();
        }
        const requeued = await requeueFailedInboundEmailJob(tx, {
          organizationId: settings.organizationId,
          emailId: payload.data.email_id,
        });
        return {
          received: true,
          duplicate: true,
          requeued: Boolean(requeued),
          inboxItemId: (requeued?.payload as { inboxItemId?: string } | undefined)?.inboxItemId,
        };
      }

      await tx.execute(sql`
      SELECT pg_advisory_xact_lock(
        hashtextextended(
          ${"provider-record:" + settings.organizationId + ":" + source.id + ":" + payload.data.email_id},
          0::bigint
        )
      )
    `);
      const [existingEmail] = await tx
        .select({
          sourceRecordId: sourceRecords.id,
          inboxItemId: inboxItems.id,
        })
        .from(sourceRecords)
        .leftJoin(inboxItems, eq(inboxItems.sourceRecordId, sourceRecords.id))
        .where(
          and(
            eq(sourceRecords.organizationId, settings.organizationId),
            eq(sourceRecords.sourceId, source.id),
            eq(sourceRecords.externalId, payload.data.email_id),
          ),
        )
        .orderBy(
          sql`case when ${sourceRecords.recordState} <> 'superseded' then 0 else 1 end`,
          sql`${sourceRecords.updatedAt} desc`,
        )
        .limit(1);
      if (existingEmail) {
        await tx
          .update(ingestionEvents)
          .set({ status: "duplicate", processedAt: new Date() })
          .where(eq(ingestionEvents.id, ingestionEvent.id));
        await tx
          .insert(workflowEvents)
          .values({
            organizationId: settings.organizationId,
            entityType: "source_record",
            entityId: existingEmail.sourceRecordId,
            action: "exact_replay_suppressed",
            actorType: "system",
            idempotencyKey: `exact-replay:email-source:${existingEmail.sourceRecordId}:${ingestionEvent.id}`,
            data: { replayType: "provider_identity", provider: "resend" },
          })
          .onConflictDoNothing();
        const requeued = await requeueFailedInboundEmailJob(tx, {
          organizationId: settings.organizationId,
          emailId: payload.data.email_id,
        });
        return {
          received: true,
          duplicate: true,
          requeued: Boolean(requeued),
          inboxItemId: existingEmail.inboxItemId ?? undefined,
        };
      }

      const sourceRawData = {
        from: payload.data.from,
        to: payload.data.to,
        subject: payload.data.subject,
        messageId: payload.data.message_id,
        attachments: payload.data.attachments,
      };
      const [sourceRecord] = await tx
        .insert(sourceRecords)
        .values({
          organizationId: settings.organizationId,
          sourceId: source.id,
          ingestionEventId: ingestionEvent.id,
          recordType: "email",
          externalId: payload.data.email_id,
          externalVersion: "1",
          providerStatus: "received",
          description: payload.data.subject || "Inbound accounting email",
          rawData: sourceRawData,
        })
        .returning();
      await tx.insert(sourceRecordVersions).values({
        organizationId: settings.organizationId,
        sourceRecordId: sourceRecord.id,
        ingestionEventId: ingestionEvent.id,
        externalVersion: "1",
        providerStatus: "received",
        rawData: sourceRawData,
        occurredAt: new Date(payload.created_at),
      });
      const [candidate] = await tx
        .insert(transactionCandidates)
        .values({
          organizationId: settings.organizationId,
          sourceRecordId: sourceRecord.id,
          candidateType: "email_transaction",
          transactionDate: payload.data.created_at.slice(0, 10),
          transactionType: "journal",
          memo: payload.data.subject || `Email from ${payload.data.from}`,
          originalCurrency: settings.baseCurrency,
          functionalCurrency: settings.baseCurrency,
          exchangeRate: "1",
        })
        .returning();
      await tx.insert(transactionCandidateSources).values({
        organizationId: settings.organizationId,
        candidateId: candidate.id,
        sourceRecordId: sourceRecord.id,
        relationship: "origin",
        isPrimary: true,
      });
      const [inboxItem] = await tx
        .insert(inboxItems)
        .values({
          organizationId: settings.organizationId,
          candidateId: candidate.id,
          sourceRecordId: sourceRecord.id,
          itemType: "classify_source_record",
          state: "processing",
          title: (payload.data.subject || `Email from ${payload.data.from}`).slice(0, 255),
        })
        .returning();
      await tx.insert(reviewFindings).values({
        organizationId: settings.organizationId,
        inboxItemId: inboxItem.id,
        candidateId: candidate.id,
        ruleKey: "uncategorized",
        impact: "blocking",
        subjectType: "transaction_candidate",
        subjectId: candidate.id,
        fingerprint: `${candidate.id}:1:uncategorized`,
        message: "The inbound email still needs transaction details and accounting categories.",
        evidence: { source: "resend", emailId: payload.data.email_id },
      });
      await tx.insert(processingJobs).values({
        organizationId: settings.organizationId,
        ingestionEventId: ingestionEvent.id,
        jobType: "process_inbound_email",
        dedupeKey: `resend-email:${payload.data.email_id}`,
        payload: {
          emailId: payload.data.email_id,
          sourceRecordId: sourceRecord.id,
          inboxItemId: inboxItem.id,
        },
      });
      await tx.insert(workflowEvents).values({
        organizationId: settings.organizationId,
        inboxItemId: inboxItem.id,
        entityType: "inbox_item",
        entityId: inboxItem.id,
        action: "received",
        actorType: "system",
        idempotencyKey: `resend:${payload.data.email_id}:received`,
        data: {
          from: payload.data.from,
          attachmentCount: payload.data.attachments.length,
        },
      });
      logger.info("Inbound email queued for processing", {
        organizationId: settings.organizationId,
        emailId: payload.data.email_id,
        inboxItemId: inboxItem.id,
      });
      return { received: true, inboxItemId: inboxItem.id };
    });
    deliveries.push({ organizationId: settings.organizationId, ...outcome });
  }

  // Kick the worker only after the enqueue transactions committed. Without
  // this the webhook was entirely scheduler-dependent — unlike every other
  // enqueue path, it never asked for the job to be run.
  triggerWorker(["process_inbound_email"]);
  // Legacy single-delivery fields stay on the response (first delivery);
  // deliveries carries the full fan-out.
  return { ...deliveries[0], received: true, deliveries };
});
