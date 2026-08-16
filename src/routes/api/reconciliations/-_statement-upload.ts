/**
 * Reconciliation API — Statement Upload, OCR, Document Attachment, PDF Generation
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
  reconciliations,
  statementLines,
  reconciliationFlags,
  reconciliationSuggestions,
} from "../../../db/schema/reconciliations";
import { financialAccounts } from "../../../db/schema/financial-accounts";
import {
  effectiveJournalPredicate,
  journalLines,
  journalHeaders,
} from "../../../db/schema/journals";
import { parties } from "../../../db/schema/parties";
import { documents, documentAttachments, documentSuggestions } from "../../../db/schema/documents";
import { processingJobs, sourceRecordDocuments } from "../../../db/schema/inbox";
import { eq, and, asc, gte, lte, inArray } from "drizzle-orm";
import { resolveCandidateAccountIds } from "../../../lib/resolve-candidate-accounts";
import {
  uploadToR2,
  deleteFromR2,
  generateR2Key,
  isR2Configured,
  getPresignedDownloadUrl,
  downloadFromR2,
} from "../../../lib/storage";
import {
  withMutationPermissionOrgContext,
  withPermissionOrgContext,
} from "../../../lib/server-context";
import { insertActivityLog } from "@/lib/insert-activity-log";
import { MAX_STATEMENT_BASE64_SIZE } from "../-ai-statement-ocr";
import type { ValidationResult } from "../../../lib/statement-validator";
import { probePdf } from "../../../lib/pdf-unlock";
import { getStatementPassword, setStatementPassword } from "../../../lib/financial-account-secrets";
import type { DbExecutor } from "@/db";
import { agentRunSteps } from "@/db/schema/ai";
import { getRunStatus, startRun } from "@/lib/ai/agent-run";
import { enqueueStatementOcrJob, STATEMENT_OCR_JOB_TYPE } from "@/lib/jobs/handlers/statement-ocr";
import { triggerWorker } from "@/lib/jobs/trigger";
import {
  generateBankStatementPDF,
  type BankStatementData,
} from "../../../lib/generate-bank-statement-pdf";

import { logger, generateReconciliationStatementSchema } from "./-_shared";

export interface ReconciliationDocumentRemovalResult {
  documentId: string | null;
  deletedDocumentId: string | null;
  objectKeys: string[];
}

/**
 * Replace only this reconciliation's statement link.
 *
 * The reconciliation row lock serializes concurrent attach/generate operations. Existing
 * Vault documents and their evidence links are never mutated or deleted by replacement.
 */
export async function linkReconciliationStatementDocument(
  db: import("@/db").DbExecutor,
  input: {
    organizationId: string;
    reconciliationId: string;
    documentId: string;
  },
): Promise<{ previousDocumentId: string | null }> {
  const [reconciliation] = await db
    .select({
      id: reconciliations.id,
      statementDocumentId: reconciliations.statementDocumentId,
    })
    .from(reconciliations)
    .where(
      and(
        eq(reconciliations.id, input.reconciliationId),
        eq(reconciliations.organizationId, input.organizationId),
      ),
    )
    .for("update")
    .limit(1);
  if (!reconciliation) throw new Error("Reconciliation not found");

  const [document] = await db
    .select({ id: documents.id })
    .from(documents)
    .where(
      and(eq(documents.id, input.documentId), eq(documents.organizationId, input.organizationId)),
    )
    .limit(1);
  if (!document) throw new Error("Document not found");

  await db
    .update(reconciliations)
    .set({ statementDocumentId: input.documentId, updatedAt: new Date() })
    .where(eq(reconciliations.id, input.reconciliationId));

  // A reconciliation owns one statement attachment. Remove only its attachment rows;
  // every other attachment and every source-evidence link remains intact.
  await db
    .delete(documentAttachments)
    .where(
      and(
        eq(documentAttachments.organizationId, input.organizationId),
        eq(documentAttachments.linkableType, "reconciliation"),
        eq(documentAttachments.linkableId, input.reconciliationId),
      ),
    );
  await db.insert(documentAttachments).values({
    organizationId: input.organizationId,
    documentId: input.documentId,
    linkableType: "reconciliation",
    linkableId: input.reconciliationId,
  });

  return { previousDocumentId: reconciliation.statementDocumentId };
}

/**
 * Generated statements always receive their own document row. In particular, this helper
 * never relabels or overwrites a Vault document that a reviewer attached to a reconciliation.
 */
export async function createReconciliationOwnedStatementDocument(
  db: import("@/db").DbExecutor,
  input: {
    organizationId: string;
    reconciliationId: string;
    document: Omit<
      typeof documents.$inferInsert,
      "id" | "organizationId" | "documentType" | "createdAt" | "updatedAt"
    >;
  },
): Promise<typeof documents.$inferSelect> {
  const [document] = await db
    .insert(documents)
    .values({
      ...input.document,
      organizationId: input.organizationId,
      documentType: "statement",
    })
    .returning();

  await linkReconciliationStatementDocument(db, {
    organizationId: input.organizationId,
    reconciliationId: input.reconciliationId,
    documentId: document.id,
  });
  return document;
}

/**
 * Transactional reconciliation unlink/delete primitive.
 *
 * It removes only reconciliation-owned links, preserves source evidence and unrelated
 * attachments, and returns storage keys only after document metadata was safely deleted.
 * The caller performs best-effort object cleanup after the surrounding transaction commits.
 */
export async function removeReconciliationStatementRecord(
  db: import("@/db").DbExecutor,
  input: {
    organizationId: string;
    reconciliationId: string;
    deleteDocument: boolean;
  },
): Promise<ReconciliationDocumentRemovalResult> {
  const [reconciliation] = await db
    .select({
      id: reconciliations.id,
      statementDocumentId: reconciliations.statementDocumentId,
    })
    .from(reconciliations)
    .where(
      and(
        eq(reconciliations.id, input.reconciliationId),
        eq(reconciliations.organizationId, input.organizationId),
      ),
    )
    .for("update")
    .limit(1);
  if (!reconciliation) throw new Error("Reconciliation not found");

  const documentId = reconciliation.statementDocumentId;
  await db
    .update(reconciliations)
    .set({ statementDocumentId: null, updatedAt: new Date() })
    .where(eq(reconciliations.id, input.reconciliationId));

  // Remove this reconciliation's attachment rows, including stale rows left by legacy
  // replacement flows. Do not touch any attachment owned by another entity.
  await db
    .delete(documentAttachments)
    .where(
      and(
        eq(documentAttachments.organizationId, input.organizationId),
        eq(documentAttachments.linkableType, "reconciliation"),
        eq(documentAttachments.linkableId, input.reconciliationId),
      ),
    );

  if (!documentId) {
    return { documentId, deletedDocumentId: null, objectKeys: [] };
  }

  await db
    .delete(reconciliationFlags)
    .where(eq(reconciliationFlags.reconciliationId, input.reconciliationId));
  await db
    .delete(reconciliationSuggestions)
    .where(eq(reconciliationSuggestions.reconciliationId, input.reconciliationId));
  await db
    .delete(statementLines)
    .where(eq(statementLines.reconciliationId, input.reconciliationId));

  if (!input.deleteDocument) {
    return { documentId, deletedDocumentId: null, objectKeys: [] };
  }

  const [document] = await db
    .select()
    .from(documents)
    .where(and(eq(documents.id, documentId), eq(documents.organizationId, input.organizationId)))
    .for("update")
    .limit(1);
  if (!document) {
    return { documentId, deletedDocumentId: null, objectKeys: [] };
  }

  const [otherReconciliation] = await db
    .select({ id: reconciliations.id })
    .from(reconciliations)
    .where(
      and(
        eq(reconciliations.organizationId, input.organizationId),
        eq(reconciliations.statementDocumentId, documentId),
      ),
    )
    .limit(1);
  const [sourceEvidence] = await db
    .select({ sourceRecordId: sourceRecordDocuments.sourceRecordId })
    .from(sourceRecordDocuments)
    .where(
      and(
        eq(sourceRecordDocuments.organizationId, input.organizationId),
        eq(sourceRecordDocuments.documentId, documentId),
      ),
    )
    .limit(1);
  const [otherAttachment] = await db
    .select({ id: documentAttachments.id })
    .from(documentAttachments)
    .where(
      and(
        eq(documentAttachments.organizationId, input.organizationId),
        eq(documentAttachments.documentId, documentId),
      ),
    )
    .limit(1);
  const [suggestion] = await db
    .select({ id: documentSuggestions.id })
    .from(documentSuggestions)
    .where(eq(documentSuggestions.documentId, documentId))
    .limit(1);

  if (otherReconciliation || sourceEvidence || otherAttachment || suggestion) {
    return { documentId, deletedDocumentId: null, objectKeys: [] };
  }

  const [deleted] = await db
    .delete(documents)
    .where(and(eq(documents.id, documentId), eq(documents.organizationId, input.organizationId)))
    .returning({ id: documents.id });
  if (!deleted) {
    return { documentId, deletedDocumentId: null, objectKeys: [] };
  }

  return {
    documentId,
    deletedDocumentId: deleted.id,
    objectKeys: [
      ...new Set(
        [
          document.r2Key,
          document.thumbnailR2Key,
          document.previewImageR2Key,
          ...(document.previewPageR2Keys ?? []),
        ].filter((key): key is string => Boolean(key)),
      ),
    ],
  };
}

async function cleanupReconciliationDocumentObjects(
  result: ReconciliationDocumentRemovalResult,
  context: { organizationId: string; reconciliationId: string },
): Promise<void> {
  if (!isR2Configured()) return;
  for (const objectKey of result.objectKeys) {
    try {
      await deleteFromR2(objectKey);
    } catch (error) {
      logger.warn("Failed to clean up a removed reconciliation document object", {
        error,
        documentId: result.deletedDocumentId,
        organizationId: context.organizationId,
        reconciliationId: context.reconciliationId,
        objectKey,
      });
    }
  }
}

// ============================================================================
// Password-protected statement PDFs
// ============================================================================

/**
 * Resolve whether a statement PDF can be read, using a supplied or stored
 * password. Runs BEFORE any R2 write so the locked/wrong-password cases have no
 * side effects. For non-PDF or unencrypted PDFs, returns { locked: false }.
 */
type StatementPasswordGate =
  | { status: "password_required" }
  | { status: "wrong_password" }
  | { status: "ok"; locked: boolean; password: string | null };

async function resolveStatementPdfPassword(
  db: DbExecutor,
  opts: {
    fileBuffer: Buffer;
    mimeType: string;
    bankAccountId: string;
    providedPassword?: string;
  },
): Promise<StatementPasswordGate> {
  if (opts.mimeType !== "application/pdf") {
    return { status: "ok", locked: false, password: null };
  }

  const initial = await probePdf(opts.fileBuffer);
  if (initial === "ok") return { status: "ok", locked: false, password: null };
  // "wrong_password" can't occur without a password; initial === "password_required".

  const effective =
    opts.providedPassword?.trim() || (await getStatementPassword(db, opts.bankAccountId));
  if (!effective) return { status: "password_required" };

  const withPassword = await probePdf(opts.fileBuffer, effective);
  if (withPassword === "wrong_password") return { status: "wrong_password" };
  if (withPassword !== "ok") return { status: "password_required" };

  return { status: "ok", locked: true, password: effective };
}

// ============================================================================
// Statement Upload & Processing Pipeline
//
// The upload request no longer runs the pipeline. It does only what needs the
// user's bytes and session — size/permission checks, the password probe, the
// R2 write, the document row, the reconciliation link — then opens an agent run,
// enqueues `statement_ocr`, and returns. Extraction, the validation gate, line
// insertion, matching and suggestions all happen in the worker
// (src/lib/jobs/handlers/statement-ocr.ts), so no model call ever sits inside
// an open Postgres transaction again.
// ============================================================================

interface QueuedStatementPipeline {
  status: "queued";
  runId: string;
  jobId: string | null;
  documentId: string;
  imageBase64?: string;
  previewWarning?: string;
}

/** Render the first page of a statement to a PNG preview for the SVG viewer. */
async function generateStatementPreview(
  db: DbExecutor,
  input: {
    documentId: string;
    r2Key: string;
    previewKey: string;
    fileBuffer: Buffer;
    mimeType: string;
    password: string | null;
  },
): Promise<{ previewImageR2Key: string | null; imageBase64?: string }> {
  if (input.mimeType.startsWith("image/")) {
    await db
      .update(documents)
      .set({ previewImageR2Key: input.r2Key, updatedAt: new Date() })
      .where(eq(documents.id, input.documentId));
    return {
      previewImageR2Key: input.r2Key,
      imageBase64: input.fileBuffer.toString("base64"),
    };
  }
  if (input.mimeType !== "application/pdf") return { previewImageR2Key: null };

  const { pdf } = await import("pdf-to-img");
  const pagesIter = await pdf(
    input.fileBuffer,
    input.password ? { scale: 2.0, password: input.password } : { scale: 2.0 },
  );
  for await (const page of pagesIter) {
    const pngBuffer = Buffer.from(page);
    await uploadToR2(input.previewKey, pngBuffer, "image/png");
    await db
      .update(documents)
      .set({ previewImageR2Key: input.previewKey, updatedAt: new Date() })
      .where(eq(documents.id, input.documentId));
    return { previewImageR2Key: input.previewKey, imageBase64: pngBuffer.toString("base64") };
  }
  return { previewImageR2Key: null };
}

/**
 * Upload a bank statement and queue its extraction pipeline.
 * Returns as soon as the document is durable — poll getStatementPipelineStatus.
 */
export const uploadBankStatement = createServerFn({ method: "POST" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    const outcome = await withMutationPermissionOrgContext(
      "reconciliation",
      "create",
      { routeKey: "reconciliation:upload-statement", limit: 10, windowMs: 60_000 },
      async ({ orgId, userId, db }) => {
        const { reconciliationId, base64Content, mimeType, fileName, password, savePassword } =
          rawData as {
            reconciliationId: string;
            base64Content: string;
            mimeType: string;
            fileName: string;
            password?: string;
            savePassword?: boolean;
          };

        if (!reconciliationId || !base64Content || !mimeType) {
          throw new Error("reconciliationId, base64Content, and mimeType are required");
        }
        if (base64Content.length > MAX_STATEMENT_BASE64_SIZE) {
          throw new Error("Statement file exceeds the maximum allowed size (20 MB).");
        }

        // ── 1. Fetch reconciliation + bank account context ───────────────────
        const [recon] = await db
          .select({
            id: reconciliations.id,
            bankAccountId: reconciliations.bankAccountId,
            status: reconciliations.status,
          })
          .from(reconciliations)
          .where(
            and(
              eq(reconciliations.id, reconciliationId),
              eq(reconciliations.organizationId, orgId),
            ),
          );

        if (!recon) throw new Error("Reconciliation not found");
        if (recon.status === "finalized")
          throw new Error("Cannot upload to a finalized reconciliation");

        // ── 2. Resolve password protection BEFORE any write (no side effects) ─
        const fileBuffer = Buffer.from(base64Content, "base64");
        const gate = await resolveStatementPdfPassword(db, {
          fileBuffer,
          mimeType,
          bankAccountId: recon.bankAccountId,
          providedPassword: password,
        });
        if (gate.status !== "ok") return gate;

        // ── 3. Upload file & create the document record ──────────────────────
        const safeFileName = (fileName || `statement_${Date.now()}`).replace(
          /[^a-zA-Z0-9._-]/g,
          "_",
        );
        const r2Key = generateR2Key(orgId, safeFileName);

        await uploadToR2(r2Key, fileBuffer, mimeType);

        // Everything past the R2 write is wrapped so a failure cleans up the
        // uploaded object + document row instead of orphaning them.
        let documentId: string | undefined;
        let previewImageR2Key: string | null = null;
        try {
          const [doc] = await db
            .insert(documents)
            .values({
              organizationId: orgId,
              uploadedById: userId,
              originalFilename: fileName || "bank_statement",
              fileSizeBytes: fileBuffer.length,
              mimeType: mimeType,
              fileType: (mimeType.split("/")[1] || "other") as
                | "pdf"
                | "xlsx"
                | "xls"
                | "csv"
                | "jpg"
                | "jpeg"
                | "png"
                | "gif"
                | "webp"
                | "zip"
                | "docx"
                | "doc"
                | "other",
              documentType: "statement",
              storagePath: r2Key,
              r2Key: r2Key,
              r2Bucket: process.env.R2_BUCKET || "mvg",
              metadata: {},
            })
            .returning();

          documentId = doc.id;

          // ── 4. Preview image (PNG) for the SVG viewer ──────────────────────
          const preview = await generateStatementPreview(db, {
            documentId,
            r2Key,
            previewKey: `reconciliations/${reconciliationId}/${documentId}/preview.png`,
            fileBuffer,
            mimeType,
            password: gate.locked ? (gate.password ?? null) : null,
          });
          previewImageR2Key = preview.previewImageR2Key;

          // ── 5. Link the document to the reconciliation ─────────────────────
          await linkReconciliationStatementDocument(db, {
            organizationId: orgId,
            reconciliationId,
            documentId,
          });

          // Persist the working password for future auto-unlocks, if requested.
          if (savePassword && gate.locked && gate.password) {
            await setStatementPassword(db, orgId, recon.bankAccountId, gate.password);
          }

          // ── 6. Open the run and enqueue the pipeline ───────────────────────
          const runId = await startRun(db, {
            orgId,
            kind: "statement_pipeline",
            configSnapshot: { reconciliationId, documentId, trigger: "upload" },
          });
          const jobId = await enqueueStatementOcrJob(db, {
            organizationId: orgId,
            reconciliationId,
            documentId,
            runId,
          });

          return {
            status: "queued" as const,
            runId,
            jobId,
            documentId,
            imageBase64: preview.imageBase64,
          } satisfies QueuedStatementPipeline;
        } catch (err) {
          // Clean up the orphaned R2 object(s) + document row on any failure
          // after the upload, then rethrow for the caller's error handling.
          await deleteFromR2(r2Key).catch(() => {});
          if (previewImageR2Key && previewImageR2Key !== r2Key) {
            await deleteFromR2(previewImageR2Key).catch(() => {});
          }
          if (documentId) {
            await db
              .delete(documents)
              .where(eq(documents.id, documentId))
              .catch(() => {});
          }
          throw err;
        }
      },
    );

    // The transaction has committed — only now is there a job for the worker
    // to claim. A dropped trigger only costs a scheduler tick.
    if ("runId" in outcome) triggerWorker([STATEMENT_OCR_JOB_TYPE]);
    return outcome;
  },
);

// ============================================================================
// AI OCR — Re-run the pipeline on the already-attached document
// ============================================================================

/**
 * Re-extract the currently attached statement document.
 * Identical pipeline to upload (including the validation gate) — only the
 * password probe and preview refresh happen in the request.
 */
export const runStatementOcr = createServerFn({ method: "POST" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    const outcome = await withMutationPermissionOrgContext(
      "reconciliation",
      "create",
      { routeKey: "reconciliation:run-statement-ocr", limit: 10, windowMs: 60_000 },
      async ({ orgId, db }) => {
        const { reconciliationId, password, savePassword } = rawData as {
          reconciliationId: string;
          password?: string;
          savePassword?: boolean;
        };
        if (!reconciliationId) throw new Error("reconciliationId is required");

        const [recon] = await db
          .select({
            id: reconciliations.id,
            bankAccountId: reconciliations.bankAccountId,
            status: reconciliations.status,
            statementDocumentId: reconciliations.statementDocumentId,
          })
          .from(reconciliations)
          .where(
            and(
              eq(reconciliations.id, reconciliationId),
              eq(reconciliations.organizationId, orgId),
            ),
          );

        if (!recon) throw new Error("Reconciliation not found");
        if (recon.status === "finalized")
          throw new Error("Cannot run OCR on a finalized reconciliation");
        if (!recon.statementDocumentId) throw new Error("No statement document attached");

        const [docRow] = await db
          .select({ r2Key: documents.r2Key, mimeType: documents.mimeType })
          .from(documents)
          .where(eq(documents.id, recon.statementDocumentId))
          .limit(1);
        if (!docRow?.r2Key) throw new Error("Statement document has no R2 key");

        // The password gate needs the bytes, and only a session can prompt for
        // a password — so it stays here rather than moving into the worker.
        const fileBuffer = await downloadFromR2(docRow.r2Key);
        const mimeType = docRow.mimeType || "application/pdf";
        const gate = await resolveStatementPdfPassword(db, {
          fileBuffer,
          mimeType,
          bankAccountId: recon.bankAccountId,
          providedPassword: password,
        });
        if (gate.status !== "ok") return gate;

        if (savePassword && gate.locked && gate.password) {
          await setStatementPassword(db, orgId, recon.bankAccountId, gate.password);
        }

        // Refresh the preview so a document attached without one renders.
        let previewWarning: string | undefined;
        let imageBase64: string | undefined;
        try {
          const preview = await generateStatementPreview(db, {
            documentId: recon.statementDocumentId,
            r2Key: docRow.r2Key,
            previewKey: `reconciliations/${reconciliationId}/${recon.statementDocumentId}/preview.png`,
            fileBuffer,
            mimeType,
            password: gate.locked ? (gate.password ?? null) : null,
          });
          imageBase64 = preview.imageBase64;
        } catch (err) {
          logger.error("Failed to generate OCR preview image", {
            error: err,
            reconciliationId,
            documentId: recon.statementDocumentId,
          });
          previewWarning =
            "The statement was queued for scanning, but its preview image could not be generated.";
        }

        const runId = await startRun(db, {
          orgId,
          kind: "statement_pipeline",
          configSnapshot: {
            reconciliationId,
            documentId: recon.statementDocumentId,
            trigger: "rerun",
          },
        });
        const jobId = await enqueueStatementOcrJob(db, {
          organizationId: orgId,
          reconciliationId,
          documentId: recon.statementDocumentId,
          runId,
        });

        return {
          status: "queued" as const,
          runId,
          jobId,
          documentId: recon.statementDocumentId,
          imageBase64,
          previewWarning,
        } satisfies QueuedStatementPipeline;
      },
    );

    if ("runId" in outcome) triggerWorker([STATEMENT_OCR_JOB_TYPE]);
    return outcome;
  },
);

// ============================================================================
// Pipeline status + human override
// ============================================================================

const statementPipelineStatusSchema = z.object({
  runId: z.string().uuid(),
  /**
   * Optional, so pre-existing clients keep working. Supplying it attaches
   * the underlying job's retry state — the run row alone cannot distinguish
   * "still queued" from "failed twice, next attempt in 20s".
   */
  jobId: z.string().uuid().optional(),
});

/** Retry state of the processing_jobs row behind a run. */
export interface StatementPipelineJobState {
  status: "queued" | "retrying" | "running" | "completed" | "failed";
  attempt: number;
  maxAttempts: number;
  nextRunAt: string | null;
  lastError: string | null;
}

export interface StatementPipelineStatus {
  runId: string;
  status: string;
  blockedReason: Record<string, unknown> | null;
  /** The validation verdict, whenever the run recorded one. */
  validation: ValidationResult | null;
  steps: Array<{ step: string; status: string; error: Record<string, unknown> | null }>;
  counts: {
    insertedLines: number | null;
    autoMatched: number | null;
    suggestions: number | null;
  };
  /** Present only when the caller passed a jobId. */
  job?: StatementPipelineJobState;
}

/** Poll target for the client while the statement pipeline runs. */
export const getStatementPipelineStatus = createServerFn({ method: "GET" })
  .inputValidator((data: z.input<typeof statementPipelineStatusSchema>) =>
    statementPipelineStatusSchema.parse(data),
  )
  .handler(async ({ data: rawData }: { data: unknown }) => {
    return withPermissionOrgContext("reconciliation", "view", async ({ orgId, db }) => {
      const { runId, jobId } = statementPipelineStatusSchema.parse(rawData);
      const run = await getRunStatus(db, orgId, runId);
      if (!run) throw new Error("Statement pipeline run not found");

      // Org-scoped primary-key lookup. Deriving this from the run instead
      // would mean scanning processing_jobs on payload->>'runId' every two
      // seconds with no index to support it.
      let job: StatementPipelineJobState | undefined;
      if (jobId) {
        const [row] = await db
          .select({
            status: processingJobs.status,
            attempts: processingJobs.attempts,
            maxAttempts: processingJobs.maxAttempts,
            runAt: processingJobs.runAt,
            lastError: processingJobs.lastError,
          })
          .from(processingJobs)
          .where(and(eq(processingJobs.id, jobId), eq(processingJobs.organizationId, orgId)))
          .limit(1);
        if (row) {
          const retrying = row.status === "queued" && row.attempts > 0;
          job = {
            status: retrying ? "retrying" : (row.status as StatementPipelineJobState["status"]),
            attempt: row.attempts,
            maxAttempts: row.maxAttempts,
            nextRunAt: retrying && row.runAt ? row.runAt.toISOString() : null,
            lastError: row.lastError ?? null,
          };
        }
      }

      const steps = await db
        .select({ step: agentRunSteps.step, outputRef: agentRunSteps.outputRef })
        .from(agentRunSteps)
        .where(and(eq(agentRunSteps.runId, runId), eq(agentRunSteps.organizationId, orgId)));
      const outputs = new Map(steps.map((row) => [row.step, row.outputRef ?? {}]));
      const count = (step: string, key: string): number | null => {
        const value = outputs.get(step)?.[key];
        return typeof value === "number" ? value : null;
      };

      const reason = run.blockedReason as { kind?: string; validation?: ValidationResult } | null;
      return {
        runId: run.runId,
        status: run.status,
        blockedReason: run.blockedReason,
        validation:
          reason?.kind?.startsWith("validation") && reason.validation ? reason.validation : null,
        steps: run.steps,
        counts: {
          insertedLines: count("insert_lines", "insertedLines"),
          autoMatched: count("auto_match", "autoMatched"),
          suggestions: count("persist_suggestions", "suggestions"),
        },
        ...(job ? { job } : {}),
      } satisfies StatementPipelineStatus;
    }) as any;
  });

const resumeStatementPipelineSchema = z.object({
  runId: z.string().uuid(),
  reconciliationId: z.string().uuid(),
  documentId: z.string().uuid(),
});

/**
 * Human override for a validation-blocked run.
 *
 * The blocked run stays terminal — it is the record that a person was shown
 * these failures. A NEW run is opened with `force`, and the override itself is
 * written to the activity log.
 */
export const resumeStatementPipeline = createServerFn({ method: "POST" })
  .inputValidator((data: z.input<typeof resumeStatementPipelineSchema>) =>
    resumeStatementPipelineSchema.parse(data),
  )
  .handler(async ({ data: rawData }: { data: unknown }) => {
    const outcome = await withMutationPermissionOrgContext(
      "reconciliation",
      "create",
      { routeKey: "reconciliation:resume-statement-pipeline", limit: 10, windowMs: 60_000 },
      async ({ orgId, userId, db }) => {
        const { runId, reconciliationId, documentId } =
          resumeStatementPipelineSchema.parse(rawData);

        const blocked = await getRunStatus(db, orgId, runId);
        if (!blocked) throw new Error("Statement pipeline run not found");
        const reason = blocked.blockedReason as { kind?: string } | null;
        if (blocked.status !== "blocked" || reason?.kind !== "validation") {
          throw new Error("Only a validation-blocked statement run can be overridden");
        }

        await insertActivityLog(
          {
            orgId,
            entityType: "reconciliation",
            entityId: reconciliationId,
            action: "statement_validation_overridden",
            actorId: userId,
            changes: {
              blockedRunId: runId,
              documentId,
              description: "Proceeded with a statement that failed validation",
            },
          },
          db,
        );

        const newRunId = await startRun(db, {
          orgId,
          kind: "statement_pipeline",
          configSnapshot: {
            reconciliationId,
            documentId,
            trigger: "validation_override",
            overriddenRunId: runId,
          },
        });
        const jobId = await enqueueStatementOcrJob(db, {
          organizationId: orgId,
          reconciliationId,
          documentId,
          runId: newRunId,
          force: true,
        });

        return { status: "queued" as const, runId: newRunId, jobId, documentId };
      },
    );

    triggerWorker([STATEMENT_OCR_JOB_TYPE]);
    return outcome;
  });

// ============================================================================
// Attach Existing Document
// ============================================================================

/**
 * Attach an existing document from /documents to a reconciliation.
 * Does NOT run AI OCR — that's a separate step via runStatementOcr.
 */
export const attachExistingDocument = createServerFn({ method: "POST" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "reconciliation",
      "create",
      { routeKey: "reconciliation:attach-document", limit: 20, windowMs: 60_000 },
      async ({ orgId, db }) => {
        const { reconciliationId, documentId } = rawData as {
          reconciliationId: string;
          documentId: string;
        };
        if (!reconciliationId || !documentId) {
          throw new Error("reconciliationId and documentId are required");
        }

        // Validate reconciliation
        const [recon] = await db
          .select({
            id: reconciliations.id,
            status: reconciliations.status,
            statementDocumentId: reconciliations.statementDocumentId,
          })
          .from(reconciliations)
          .where(
            and(
              eq(reconciliations.id, reconciliationId),
              eq(reconciliations.organizationId, orgId),
            ),
          );

        if (!recon) throw new Error("Reconciliation not found");
        if (recon.status === "finalized")
          throw new Error("Cannot attach to a finalized reconciliation");

        // Validate document exists and belongs to org
        const [doc] = await db
          .select({
            id: documents.id,
            r2Key: documents.r2Key,
            mimeType: documents.mimeType,
            previewImageR2Key: documents.previewImageR2Key,
            originalFilename: documents.originalFilename,
          })
          .from(documents)
          .where(and(eq(documents.id, documentId), eq(documents.organizationId, orgId)));

        if (!doc) throw new Error("Document not found");

        await linkReconciliationStatementDocument(db, {
          organizationId: orgId,
          reconciliationId,
          documentId,
        });

        // Generate preview URL
        let previewImageUrl: string | undefined;
        if (doc.previewImageR2Key && isR2Configured()) {
          previewImageUrl = await getPresignedDownloadUrl(doc.previewImageR2Key);
        }

        let documentUrl: string | undefined;
        if (doc.r2Key && isR2Configured()) {
          documentUrl = await getPresignedDownloadUrl(doc.r2Key);
        }

        return {
          documentId: doc.id,
          filename: doc.originalFilename,
          previewImageUrl,
          documentUrl,
        };
      },
    );
  },
);

// ============================================================================
// Remove Statement Document
// ============================================================================

/**
 * Remove the linked statement document from a reconciliation.
 * Clears statementDocumentId and optionally deletes the document + statement lines.
 */
export const removeStatementDocument = createServerFn({ method: "POST" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    const outcome = await withMutationPermissionOrgContext(
      "reconciliation",
      "create",
      { routeKey: "reconciliation:remove-statement-document", limit: 20, windowMs: 60_000 },
      async ({ orgId, userId, db }) => {
        const { reconciliationId, deleteDocument: shouldDelete } = rawData as {
          reconciliationId: string;
          deleteDocument?: boolean;
        };

        if (!reconciliationId) throw new Error("reconciliationId is required");

        const removal = await removeReconciliationStatementRecord(db, {
          organizationId: orgId,
          reconciliationId,
          deleteDocument: Boolean(shouldDelete),
        });

        await insertActivityLog(
          {
            orgId,
            entityType: "reconciliation",
            entityId: reconciliationId,
            action: "statement_removed",
            actorId: userId,
            changes: { description: "Removed attached bank statement" },
          },
          db,
        );

        return { orgId, reconciliationId, removal };
      },
    );

    // Storage cleanup is intentionally outside withOrgContext: its database transaction
    // has committed, so a rollback can never leave metadata pointing at a deleted object.
    await cleanupReconciliationDocumentObjects(outcome.removal, {
      organizationId: outcome.orgId,
      reconciliationId: outcome.reconciliationId,
    });
    return { success: true };
  },
);

// ============================================================================
// Generate Bank Statement PDF
// ============================================================================

/**
 * Generate a bank statement PDF for a reconciliation.
 * 1) Builds realistic PDF from ledger transactions
 * 2) Converts PDF → PNG via pdf-to-img (same as bills)
 * 3) Creates/upserts statement_lines rows from ledger
 * 4) Returns PNG image + deterministic bounding boxes for SVG overlay
 */
export const generateBankStatementPdf = createServerFn({ method: "POST" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "reconciliation",
      "create",
      { routeKey: "reconciliation:generate-statement-pdf", limit: 15, windowMs: 60_000 },
      async ({ orgId, userId, db }) => {
        const parsed = z.object({ reconciliationId: z.string().uuid() }).parse(rawData);

        // Fetch reconciliation + bank account info
        const [recon] = await db
          .select({
            id: reconciliations.id,
            bankAccountId: reconciliations.bankAccountId,
            ledgerAccountId: financialAccounts.ledgerAccountId,
            bankAccountName: financialAccounts.accountName,
            bankAccountLastFour: financialAccounts.lastFour,
            institutionName: financialAccounts.institutionName,
            accountType: financialAccounts.accountType,
            periodStart: reconciliations.periodStart,
            periodEnd: reconciliations.periodEnd,
            statementBeginningBalance: reconciliations.statementBeginningBalance,
            statementEndingBalance: reconciliations.statementEndingBalance,
            statementDocumentId: reconciliations.statementDocumentId,
          })
          .from(reconciliations)
          .innerJoin(financialAccounts, eq(reconciliations.bankAccountId, financialAccounts.id))
          .where(
            and(
              eq(reconciliations.id, parsed.reconciliationId),
              eq(reconciliations.organizationId, orgId),
            ),
          )
          .limit(1);

        if (!recon) throw new Error("Reconciliation not found");

        // Get org name for the entity header
        const { organization } = await import("../../../db/schema/auth");
        const [org] = await db
          .select({ name: organization.name })
          .from(organization)
          .where(eq(organization.id, orgId))
          .limit(1);
        const entityName = org?.name ?? "Organization";

        // Build candidate account IDs (same approach as getReconciliation)
        const candidateIds = recon.ledgerAccountId
          ? await resolveCandidateAccountIds(db, recon.ledgerAccountId)
          : [];

        // Get ledger transactions using candidate COA accounts
        const ledgerTxns =
          candidateIds.length > 0
            ? await db
                .select({
                  id: journalLines.id,
                  transactionDate: journalHeaders.transactionDate,
                  description: journalLines.lineDescription,
                  headerMemo: journalHeaders.memo,
                  debit: journalLines.debit,
                  credit: journalLines.credit,
                  partyName: parties.name,
                })
                .from(journalLines)
                .innerJoin(journalHeaders, eq(journalLines.journalHeaderId, journalHeaders.id))
                .leftJoin(parties, eq(journalHeaders.partyId, parties.id))
                .where(
                  and(
                    inArray(journalLines.accountId, candidateIds),
                    eq(journalHeaders.organizationId, orgId),
                    eq(journalHeaders.status, "posted"),
                    effectiveJournalPredicate(),
                    gte(journalHeaders.transactionDate, recon.periodStart),
                    lte(journalHeaders.transactionDate, recon.periodEnd),
                  ),
                )
                .orderBy(asc(journalHeaders.transactionDate))
            : [];

        const openingBal = Number.parseFloat(recon.statementBeginningBalance ?? "0");
        let runningBal = openingBal;

        const transactions = ledgerTxns.map((txn) => {
          const debitAmt = txn.debit ? Number.parseFloat(txn.debit) : 0;
          const creditAmt = txn.credit ? Number.parseFloat(txn.credit) : 0;
          const amount = debitAmt - creditAmt;
          runningBal += amount;

          return {
            id: txn.id,
            date: txn.transactionDate,
            description: txn.partyName ?? txn.description ?? "Transaction",
            detail: txn.headerMemo ?? undefined,
            amount,
            runningBalance: runningBal,
          };
        });

        const acctType = recon.accountType === "credit_card" ? "Credit Card" : "Checking";

        const { blob, boundingBoxes } = generateBankStatementPDF({
          bankName: recon.institutionName ?? "Digital Banking",
          accountName: recon.bankAccountName ?? "Account",
          accountNumber: recon.bankAccountLastFour,
          accountType: acctType,
          entityName,
          periodStart: recon.periodStart,
          periodEnd: recon.periodEnd,
          openingBalance: openingBal,
          closingBalance: Number.parseFloat(recon.statementEndingBalance ?? "0"),
          transactions,
        });

        // ── Convert PDF → PNG via pdf-to-img ──
        const pdfArrayBuffer = await blob.arrayBuffer();
        const pdfBuffer = Buffer.from(pdfArrayBuffer);
        let pngBase64 = "";
        try {
          const { pdf } = await import("pdf-to-img");
          const pagesIter = await pdf(pdfBuffer, { scale: 2.0 });
          for await (const page of pagesIter) {
            pngBase64 = Buffer.from(page).toString("base64");
            break; // First page only
          }
        } catch (err) {
          logger.error("Failed to convert generated bank statement PDF preview", {
            error: err,
            reconciliationId: parsed.reconciliationId,
          });
          // Fallback: return PDF as base64 so the viewer can at least show something
          const uint8 = new Uint8Array(pdfArrayBuffer);
          let binary = "";
          for (const byte of uint8) {
            binary += String.fromCharCode(byte);
          }
          return {
            imageBase64: btoa(binary),
            imageMimeType: "application/pdf" as const,
            boundingBoxes: [],
            statementLineIds: [],
            transactionCount: transactions.length,
          };
        }

        // ── Persist PDF + preview PNG to R2 and documents table ──
        const pngBuffer = pngBase64 ? Buffer.from(pngBase64, "base64") : null;
        const statementFilename = `Bank Statement - ${recon.bankAccountName ?? "Account"} ${recon.periodStart} to ${recon.periodEnd}.pdf`;
        const pdfR2Key = generateR2Key(orgId, statementFilename);
        const previewR2Key = generateR2Key(
          orgId,
          statementFilename.replace(/\.pdf$/i, "-preview.png"),
        );

        // Upload files to R2
        if (isR2Configured()) {
          await uploadToR2(pdfR2Key, pdfBuffer, "application/pdf");
          if (pngBuffer) {
            await uploadToR2(previewR2Key, pngBuffer, "image/png");
          }
        }

        // Never overwrite/relabel an attached Vault document. The generated artifact gets
        // a new row and generation-unique object keys, then replaces only this recon's link.
        await createReconciliationOwnedStatementDocument(db, {
          organizationId: orgId,
          reconciliationId: parsed.reconciliationId,
          document: {
            uploadedById: userId,
            originalFilename: statementFilename,
            fileSizeBytes: pdfBuffer.length,
            mimeType: "application/pdf",
            fileType: "pdf",
            storagePath: pdfR2Key,
            r2Key: pdfR2Key,
            r2Bucket: process.env.R2_BUCKET || "mvg",
            previewImageR2Key: pngBuffer ? previewR2Key : null,
            ocrBoundingBoxes: boundingBoxes.map((b) => ({
              fieldId: b.id,
              label: b.label,
              text: b.text,
              bbox: b.bbox,
              page: b.page,
            })),
            metadata: {},
          },
        });

        // ── Clear existing statement lines/flags/suggestions ──
        await db
          .delete(reconciliationFlags)
          .where(eq(reconciliationFlags.reconciliationId, parsed.reconciliationId));
        await db
          .delete(reconciliationSuggestions)
          .where(eq(reconciliationSuggestions.reconciliationId, parsed.reconciliationId));
        await db
          .delete(statementLines)
          .where(eq(statementLines.reconciliationId, parsed.reconciliationId));

        // ── Insert exact statement lines mapped securely to ledger transactions ──
        let sortIndex = 0;
        for (const t of transactions) {
          const box = boundingBoxes.find((b) => b.fieldType === "transaction" && b.id === t.id);

          await db.insert(statementLines).values({
            reconciliationId: parsed.reconciliationId,
            transactionDate: t.date,
            description: t.description,
            amount: String(t.amount),
            sortOrder: sortIndex++,
            source: "ocr",
            ocrConfidence: "1.0",
            ocrBbox: box?.bbox ?? null,
            ocrPage: box?.page ?? null,
            // Native auto-match: we created this perfectly from the ledger!
            matchedJournalLineId: t.id,
            matchStatus: "matched",
            matchConfidence: "100",
          });
        }

        return {
          imageBase64: pngBase64,
          imageMimeType: "image/png" as const,
          transactionCount: transactions.length,
        };
      },
    );
  },
);

// ============================================================================
// Generate Missing Statement PDF
// ============================================================================

/**
 * Generate a missing bank statement PDF from reconciliation data
 */
export const generateReconciliationStatement = createServerFn({ method: "POST" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "reconciliation",
      "create",
      { routeKey: "reconciliation:generate-missing-statement", limit: 15, windowMs: 60_000 },
      async ({ orgId, userId, db }) => {
        const parsed = generateReconciliationStatementSchema.parse(rawData);

        const { organization } = await import("../../../db/schema/auth");

        // 1. Fetch reconciliation + bank account + organization details
        const [reconData] = await db
          .select({
            recon: reconciliations,
            bank: financialAccounts,
            org: organization,
          })
          .from(reconciliations)
          .innerJoin(financialAccounts, eq(reconciliations.bankAccountId, financialAccounts.id))
          .innerJoin(organization, eq(reconciliations.organizationId, organization.id))
          .where(
            and(
              eq(reconciliations.id, parsed.reconciliationId),
              eq(reconciliations.organizationId, orgId),
            ),
          )
          .limit(1);

        if (!reconData) throw new Error("Reconciliation not found");

        // 2. Fetch statement lines
        const lines = await db
          .select()
          .from(statementLines)
          .where(eq(statementLines.reconciliationId, parsed.reconciliationId))
          .orderBy(asc(statementLines.transactionDate));

        // 3. Map to BankStatementData
        const txns = lines.map((l) => ({
          id: l.id,
          date: l.transactionDate,
          description: l.description,
          amount: Number(l.amount),
          runningBalance: 0, // Calculated below
        }));

        let balance = Number(reconData.recon.statementBeginningBalance || 0);
        txns.forEach((t) => {
          balance += t.amount;
          t.runningBalance = balance;
        });

        const pdfData: BankStatementData = {
          bankName: reconData.bank.institutionName || "Unknown Bank",
          accountName: reconData.bank.accountName,
          accountNumber: reconData.bank.lastFour ? `****${reconData.bank.lastFour}` : null,
          accountType: reconData.bank.accountType || "Checking",
          entityName: reconData.org.name,
          entityAddress: "123 Business Rd, Tech City, CA 94000", // Placeholder
          periodStart: reconData.recon.periodStart,
          periodEnd: reconData.recon.periodEnd,
          openingBalance: Number(reconData.recon.statementBeginningBalance || 0),
          closingBalance: Number(reconData.recon.statementEndingBalance || 0),
          transactions: txns,
        };

        // 4. Generate PDF
        const { blob, boundingBoxes } = generateBankStatementPDF(pdfData);

        const arrayBuffer = await blob.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        // 5. Upload PDF to R2
        const sanitizedAccountName = reconData.bank.accountName
          .substring(0, 10)
          .replace(/[^a-z0-9]/gi, "_");
        const filename = `statement_${sanitizedAccountName}_${reconData.recon.periodStart}_generated.pdf`;
        const r2Key = generateR2Key(orgId, filename);

        await uploadToR2(r2Key, buffer, "application/pdf");

        // 5b. Convert PDF → PNG and upload preview image to R2
        let previewR2Key: string | null = null;
        try {
          const { pdf: pdfToImg } = await import("pdf-to-img");
          const pagesIter = await pdfToImg(buffer, { scale: 2.0 });
          for await (const page of pagesIter) {
            const pngBuffer = Buffer.from(page);
            previewR2Key = generateR2Key(orgId, filename.replace(".pdf", "_preview.png"));
            await uploadToR2(previewR2Key, pngBuffer, "image/png");
            break; // First page only
          }
        } catch (err) {
          logger.error("Failed to generate missing-statement preview", {
            error: err,
            reconciliationId: parsed.reconciliationId,
            filename,
          });
        }

        // 6. Generated artifacts always receive a fresh reconciliation-owned document.
        const doc = await createReconciliationOwnedStatementDocument(db, {
          organizationId: orgId,
          reconciliationId: parsed.reconciliationId,
          document: {
            uploadedById: userId,
            originalFilename: filename,
            fileSizeBytes: buffer.length,
            mimeType: "application/pdf",
            fileType: "pdf",
            storagePath: r2Key,
            r2Key: r2Key,
            r2Bucket: process.env.R2_BUCKET || "mvg",
            previewImageR2Key: previewR2Key,
            ocrBoundingBoxes: boundingBoxes.map((b) => ({
              fieldId: b.id,
              label: b.label,
              text: b.text,
              bbox: b.bbox,
              page: b.page,
            })),
            metadata: {},
          },
        });

        // 7. Update statement lines with ocrBbox from bounding boxes
        for (const box of boundingBoxes) {
          if (box.fieldType === "transaction") {
            const matchingLine = lines.find((l) => l.id === box.id);
            if (matchingLine) {
              await db
                .update(statementLines)
                .set({ ocrBbox: box.bbox, ocrPage: box.page })
                .where(eq(statementLines.id, matchingLine.id));
            }
          }
        }

        // 8. Log activity
        await insertActivityLog(
          {
            orgId,
            entityType: "reconciliation",
            entityId: parsed.reconciliationId,
            action: "statement_generated",
            actorId: userId,
            changes: { description: "Generated missing bank statement PDF" },
          },
          db,
        );

        return { success: true, document: doc } as any;
      },
    );
  },
);

// ============================================================================
// Remove Reconciliation Statement
// ============================================================================

export const removeReconciliationStatement = createServerFn({ method: "POST" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    const outcome = await withMutationPermissionOrgContext(
      "reconciliation",
      "create",
      { routeKey: "reconciliation:remove-statement", limit: 20, windowMs: 60_000 },
      async ({ orgId, userId, db }) => {
        const { reconciliationId } = rawData as { reconciliationId: string };
        if (!reconciliationId) throw new Error("reconciliationId is required");

        const removal = await removeReconciliationStatementRecord(db, {
          organizationId: orgId,
          reconciliationId,
          deleteDocument: true,
        });

        await insertActivityLog(
          {
            orgId,
            entityType: "reconciliation",
            entityId: reconciliationId,
            action: "statement_removed",
            actorId: userId,
            changes: {
              documentId: removal.documentId,
              description: "Removed attached statement",
            },
          },
          db,
        );

        return { orgId, reconciliationId, removal };
      },
    );

    await cleanupReconciliationDocumentObjects(outcome.removal, {
      organizationId: outcome.orgId,
      reconciliationId: outcome.reconciliationId,
    });
    return { success: true };
  },
);
