import { createServerFn } from "@tanstack/react-start";
import { aiComplete } from "../../lib/ai/facade";
import { classifyDocumentOutputSchema } from "../../lib/ai/schemas/classify-document";
import { normalizeConfidence } from "../../lib/ai/confidence";
import { createProposal } from "../../lib/ai/proposals";
import { documents } from "../../db/schema/documents";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { createLogger } from "../../lib/logger";
import { withMutationPermissionOrgContext } from "../../lib/server-context";
import { assertRolePermission } from "../../lib/auth-middleware";

const classifySchema = z.object({
  documentId: z.string().uuid(),
  // Optional content overrides if needed, but usually we fetch from DB/Storage
  contentPreview: z.string().optional(),
});

const logger = createLogger("api.ai-classify-document");

type ClassifiedDocumentType = (typeof documents.documentType.enumValues)[number];

export const classifyDocument = createServerFn({ method: "POST" })
  .inputValidator((data: z.input<typeof classifySchema>) => classifySchema.parse(data))
  .handler(async ({ data }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "aiTask",
      "run",
      { routeKey: "ai:document-classify", limit: 20, windowMs: 300_000 },
      async ({ orgId, db, role, userId }) => {
        // Two-key model: classification is invoked from the upload path;
        // it only ever CREATES a proposal now (the applier re-checks
        // document:upload at approval time).
        assertRolePermission(role, "document", "upload");
        const { documentId, contentPreview } = classifySchema.parse(data);

        const [doc] = await db
          .select()
          .from(documents)
          .where(and(eq(documents.id, documentId), eq(documents.organizationId, orgId)))
          .limit(1);

        if (!doc) {
          throw new Error("Document not found");
        }

        // Never override a type a human/UI already set — only classify when the
        // type is still the "other" default. This also skips the model call
        // (and its cost) for already-typed documents.
        if (doc.documentType && doc.documentType !== "other") {
          return {
            documentType: doc.documentType,
            confidence: 100,
            applied: false,
            reason: "already_typed",
          };
        }

        try {
          const aiResult = await aiComplete<z.infer<typeof classifyDocumentOutputSchema>>({
            task: "classify_document",
            input: { filename: doc.originalFilename, contentPreview },
            ctx: { orgId },
          });
          if (!aiResult.ok) {
            logger.warn("Classification output failed validation", {
              documentId: doc.id,
              orgId,
              issues: aiResult.issues,
            });
            return { documentType: "other", confidence: 0 };
          }
          const result = aiResult.data;

          // Confirm-first (ai_findings #6): classification NEVER writes
          // documentType directly anymore. A confident, non-"other" guess
          // becomes a document_type proposal a human approves (the applier
          // keeps the only-if-still-"other" race guard); below threshold,
          // nothing happens at all.
          const confidence01 = normalizeConfidence(result.confidence);
          const CONFIDENCE_THRESHOLD = 0.7;
          const proposable =
            result.documentType !== "other" && confidence01 >= CONFIDENCE_THRESHOLD;

          let proposalId: string | undefined;
          if (proposable) {
            const proposal = await createProposal(db, {
              orgId,
              kind: "document_type",
              payload: {
                documentId: doc.id,
                documentType: result.documentType as ClassifiedDocumentType & string,
                confidence: confidence01,
                reasoning: result.reasoning,
              },
              confidence: confidence01,
              sourceRef: { entityType: "document", entityId: doc.id },
              createdBy: userId,
            });
            proposalId = proposal.id;
          }

          logger.info("Classified document", {
            documentId: doc.id,
            orgId,
            documentType: result.documentType,
            confidence: result.confidence,
            proposalId,
          });

          return { ...result, applied: false, proposalId };
        } catch (error) {
          logger.error("Document classification failed", {
            error,
            documentId,
            orgId,
          });
          return { documentType: "other", confidence: 0 };
        }
      },
    ) as any;
  });
