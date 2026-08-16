// ============================================================================
// Ingest triage — ONE cheap classification per uploaded document, run
// fire-and-forget from the upload path in its own org context (never inside
// the request transaction). The result is cached on documents.metadata.triage
// for downstream reuse, and a confident, non-"other" kind becomes a
// document_type proposal (confirm-first — never a direct write).
// ============================================================================

import { and, eq } from "drizzle-orm";
import { withOrgContext } from "../../db";
import { documents } from "../../db/schema/documents";
import { aiComplete } from "./facade";
import type { IngestTriageOutput } from "../ai/schemas/ingest-triage";
import { normalizeConfidence } from "./confidence";
import { createProposal, listProposals } from "./proposals";
import { createLogger } from "../logger";

const logger = createLogger("ai.ingest-triage");

export const INGEST_TRIAGE_VERSION = 1;
const PROPOSAL_CONFIDENCE_THRESHOLD = 0.7;

const TEXT_EXTRACTABLE_MIME_PREFIXES = ["text/"];
const TEXT_EXTRACTABLE_MIMES = new Set(["application/json", "application/xml", "text/csv"]);

export function isTextExtractable(mimeType: string): boolean {
  return (
    TEXT_EXTRACTABLE_MIME_PREFIXES.some((p) => mimeType.startsWith(p)) ||
    TEXT_EXTRACTABLE_MIMES.has(mimeType)
  );
}

export interface RunIngestTriageInput {
  orgId: string;
  userId?: string;
  documentId: string;
  filename: string;
  mimeType: string;
  /** Raw file bytes (used only for text-extractable types, first ~1KB). */
  fileBase64?: string;
}

/**
 * Classify an uploaded document. Safe to fire-and-forget: all failures are
 * logged and swallowed; nothing here can fail an upload.
 */
export async function runIngestTriage(input: RunIngestTriageInput): Promise<void> {
  try {
    const shouldRun = await withOrgContext(input.orgId, "system", "admin", async (tx) => {
      const [doc] = await tx
        .select({
          id: documents.id,
          documentType: documents.documentType,
          metadata: documents.metadata,
        })
        .from(documents)
        .where(and(eq(documents.id, input.documentId), eq(documents.organizationId, input.orgId)))
        .limit(1);
      if (!doc) return false;
      // Already typed by a human/flow, or already triaged — nothing to do.
      if (doc.documentType && doc.documentType !== "other") return false;
      if (doc.metadata?.triage?.version === INGEST_TRIAGE_VERSION) return false;
      return true;
    });
    if (!shouldRun) return;

    let textPreview: string | undefined;
    if (input.fileBase64 && isTextExtractable(input.mimeType)) {
      try {
        textPreview = Buffer.from(input.fileBase64, "base64").toString("utf8").slice(0, 1024);
      } catch {
        // Not decodable as text — classify on filename + mime alone.
      }
    }

    // Model call OUTSIDE any transaction.
    const result = await aiComplete<IngestTriageOutput>({
      task: "ingest_triage",
      input: { filename: input.filename, mimeType: input.mimeType, textPreview },
      ctx: { orgId: input.orgId, userId: input.userId },
    });
    if (!result.ok) {
      logger.warn("Ingest triage output failed validation", {
        documentId: input.documentId,
        orgId: input.orgId,
        issues: result.issues,
      });
      return;
    }

    const confidence01 = normalizeConfidence(result.data.confidence);

    await withOrgContext(input.orgId, "system", "admin", async (tx) => {
      const [doc] = await tx
        .select({ metadata: documents.metadata, documentType: documents.documentType })
        .from(documents)
        .where(and(eq(documents.id, input.documentId), eq(documents.organizationId, input.orgId)))
        .limit(1);
      if (!doc) return;

      await tx
        .update(documents)
        .set({
          metadata: {
            ...doc.metadata,
            triage: {
              docKind: result.data.docKind,
              confidence: confidence01,
              version: INGEST_TRIAGE_VERSION,
              cachedAt: new Date().toISOString(),
            },
          },
          updatedAt: new Date(),
        })
        .where(and(eq(documents.id, input.documentId), eq(documents.organizationId, input.orgId)));

      // Confirm-first: confident non-"other" kinds become a proposal (unless
      // one is already pending for this document).
      const proposable =
        doc.documentType === "other" &&
        result.data.docKind !== "other" &&
        confidence01 >= PROPOSAL_CONFIDENCE_THRESHOLD;
      if (!proposable) return;

      const existing = await listProposals(tx, input.orgId, {
        status: "pending",
        kind: "document_type",
        sourceRef: { entityType: "document", entityId: input.documentId },
        limit: 1,
      });
      if (existing.length > 0) return;

      await createProposal(tx, {
        orgId: input.orgId,
        kind: "document_type",
        payload: {
          documentId: input.documentId,
          documentType: result.data.docKind,
          confidence: confidence01,
          reasoning: result.data.reasoning,
        },
        invocationId: result.invocationId,
        confidence: confidence01,
        sourceRef: { entityType: "document", entityId: input.documentId },
        createdBy: input.userId,
      });
    });
  } catch (err) {
    logger.warn("Ingest triage failed (non-fatal)", {
      documentId: input.documentId,
      orgId: input.orgId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
