/**
 * Job handler for `process_standalone_document`.
 *
 * Extracted verbatim from the durable Inbox worker route. Runs fact
 * extraction for an uploaded document, performs the standalone-document
 * intake transaction, and completes the job with a lease-fenced update
 * (`status = 'running' AND locked_by = workerId`).
 */
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { documents } from "@/db/schema/documents";
import { processingJobs } from "@/db/schema/inbox";
import { downloadFromR2, isR2Configured } from "@/lib/storage";
import { ensureEmailAttachmentExtraction } from "@/lib/inbox/email-attachment-extraction";
import { intakeStandaloneDocument } from "@/lib/inbox/document-intake";
import type { JobContext, JobHandlerResult, ProcessingJob } from "../registry";

export async function processStandaloneDocumentJob(
  job: ProcessingJob,
  ctx: JobContext,
): Promise<JobHandlerResult> {
  const { workerId } = ctx;
  const payload = job.payload as {
    documentId?: string;
    filename?: string;
    contentType?: string;
    documentType?: string;
    fallbackDate?: string | null;
    fallbackCurrency?: string | null;
    userId?: string;
  };
  if (!payload.documentId || !payload.filename || !payload.contentType || !payload.documentType) {
    throw new Error("Standalone document extraction job payload is incomplete.");
  }
  const [document] = await db
    .select()
    .from(documents)
    .where(
      and(eq(documents.organizationId, job.organizationId), eq(documents.id, payload.documentId)),
    )
    .limit(1);
  if (!document) throw new Error("Standalone document no longer exists.");
  if (!document.r2Key) {
    throw new Error("Standalone document is missing its storage object key.");
  }
  if (!isR2Configured()) throw new Error("Document storage is not configured.");

  const fileBuffer = await downloadFromR2(document.r2Key);
  await ensureEmailAttachmentExtraction(db, {
    organizationId: job.organizationId,
    documentId: document.id,
    fileBuffer,
    mimeType: payload.contentType,
    filename: payload.filename,
    documentType: document.documentType === "other" ? payload.documentType : document.documentType,
    fallbackDate: payload.fallbackDate,
    fallbackCurrency: payload.fallbackCurrency,
  });
  const intake = await db.transaction((tx) =>
    intakeStandaloneDocument(
      {
        db: tx,
        orgId: job.organizationId,
        userId: payload.userId ?? "system",
      },
      {
        documentId: document.id,
        filename: payload.filename!,
        contentType: payload.contentType!,
        documentType: payload.documentType!,
        fallbackDate: payload.fallbackDate ?? undefined,
      },
    ),
  );
  const [completedJob] = await db
    .update(processingJobs)
    .set({
      status: "completed",
      lockedBy: null,
      lockedUntil: null,
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(processingJobs.id, job.id),
        eq(processingJobs.status, "running"),
        eq(processingJobs.lockedBy, workerId),
      ),
    )
    .returning({ id: processingJobs.id });
  if (!completedJob) {
    return { processed: false, reason: "lease_lost", jobId: job.id };
  }
  return {
    processed: true,
    jobId: job.id,
    documentId: document.id,
    candidateId: intake.candidate?.id ?? null,
    inboxItemId: intake.inboxItem?.id ?? null,
    skipped: intake.candidate === null,
  };
}
