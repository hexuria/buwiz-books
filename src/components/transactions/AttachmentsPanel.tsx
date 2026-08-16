/**
 * AttachmentsPanel — Drag & drop file attachments for the transaction sidebar.
 * Uploads files to R2 immediately, stores document IDs as "staged" until the
 * transaction is saved and we have a journal_header ID to link them.
 *
 * Features:
 * - Duplicate detection: checks if filename already exists before uploading
 * - "Browse Documents" picker: attach existing docs without re-uploading
 */
import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import DocumentPickerModal from "../documents/DocumentPickerModal";
import { callServerFn } from "../../lib/server-fn-client";
import { usePermission } from "../../lib/use-permission";
import type { ParsedTransactionResult } from "../../routes/api/-ai-transaction-parse";
import type { EntityCreationProposal } from "../../routes/api/-ai-entity-resolver";
import ProposalReviewCard, { formatBankAccountLabel } from "../ai/ProposalReviewCard";
import { InteractiveDocumentViewer } from "../bills/InteractiveDocumentViewer";
import type { BoundingBox } from "../bills/InteractiveDocumentViewer";
import { createLogger } from "../../lib/logger";
import { Modal } from "../ui/Modal";
const logger = createLogger("ui.attachments");

// ============================================================================
// Types
// ============================================================================

function computeContextHash(accounts: { id: string }[]): string {
  const ids = accounts.map((a) => a.id).sort();
  let hash = 0;
  for (let i = 0; i < ids.length; i++) {
    const char = ids[i].charCodeAt(0);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return hash.toString(36);
}

function validateCachedResult(
  cached: ParsedTransactionResult,
  accounts: { id: string }[],
  parties: { id: string }[],
): ParsedTransactionResult {
  const result = { ...cached };
  const accountSet = new Set(accounts.map((a) => a.id));
  const partySet = new Set(parties.map((p) => p.id));

  if (accountSet.size > 0 && result.categoryId && !accountSet.has(result.categoryId)) {
    result.categoryId = "";
  }
  if (partySet.size > 0 && result.partyId && !partySet.has(result.partyId)) {
    result.partyId = "";
    result.partyName = "";
  }
  return result;
}

/**
 * Form field → bounding-box fieldId.
 *
 * These must match what the bbox prompt actually emits (see
 * `src/lib/ai/prompts/bill-ocr.ts`): vendor_name, invoice_date, total_amount,
 * memo, line_item_N. The previous map named expense_category,
 * transaction_date, merchant_name and memo_notes — none of which exist
 * anywhere in the codebase, so four of the five field previews were dead
 * links. There is deliberately no entry for the category: it is inferred
 * from the document, not read off it, so there is no box to point at.
 */
const FIELD_TO_BBOX: Record<string, string> = {
  date: "invoice_date",
  amount: "total_amount",
  partyName: "vendor_name",
  memo: "memo",
};

interface ViewerData {
  imageUrl: string;
  /** Every page, so boxes on pages after the first are reachable. */
  imageUrls: string[];
  pageCount: number;
  documentUrl?: string;
  boundingBoxes: BoundingBox[];
  documentId: string;
}

export interface StagedDocument {
  /** Document ID returned from the server after uploading */
  documentId: string;
  /** Original filename */
  filename: string;
  /** MIME type */
  contentType: string;
  /** File size in bytes */
  fileSizeBytes: number;
  /** Local object URL for thumbnail preview (images only) */
  previewUrl?: string;
  /** Whether this document has OCR bounding box data for the doc viewer */
  hasOcrData?: boolean;
}

export interface AttachmentsPanelProps {
  stagedDocuments: StagedDocument[];
  onDocumentsChange: (docs: StagedDocument[]) => void;
  accounts: { id: string; name: string; accountNumber?: string | null; accountType: string }[];
  parties: { id: string; name: string }[];
  departments: { id: string; name: string }[];
  locations: { id: string; name: string }[];
  currentDate: string;
  onApply: (result: ParsedTransactionResult) => void;
  onEntitiesResolved?: () => void | Promise<void>;
}

interface UploadingFile {
  id: string;
  filename: string;
  progress: number; // 0-100
}

/** Pending duplicate confirmation */
interface DuplicatePrompt {
  file: File;
  base64: string;
  existingDocId: string;
  existingFilename: string;
}

// ============================================================================
// Component
// ============================================================================

export default function AttachmentsPanel({
  stagedDocuments,
  onDocumentsChange,
  accounts,
  parties,
  departments,
  locations,
  currentDate,
  onApply,
  onEntitiesResolved,
}: AttachmentsPanelProps) {
  const [isDragOver, setIsDragOver] = useState(false);
  const [uploading, setUploading] = useState<UploadingFile[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [duplicatePrompt, setDuplicatePrompt] = useState<DuplicatePrompt | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [parsingDocId, setParsingDocId] = useState<string | null>(null);
  const [parsedResult, setParsedResult] = useState<ParsedTransactionResult | null>(null);
  const [resultFromCache, setResultFromCache] = useState(false);
  const [entityProposals, setEntityProposals] = useState<EntityCreationProposal[]>([]);
  const lastParsedDocRef = useRef<{ documentId: string; filename: string } | null>(null);
  const { canAccess: canRunAi } = usePermission("aiTask", "run");

  const [viewerDataMap, setViewerDataMap] = useState<Record<string, ViewerData>>({});
  const [activeViewerDocId, setActiveViewerDocId] = useState<string | null>(null);
  // Index into viewerData.boundingBoxes rather than a fieldId: the list is
  // flat across pages and a document can repeat a fieldId on every page.
  const [activeBoxIndex, setActiveBoxIndex] = useState<number | null>(null);
  /** Document whose field scan is currently queued/running. */
  const [scanningDocId, setScanningDocId] = useState<string | null>(null);
  // A queued scan can resolve after this panel unmounts; guard the writes.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const [viewerOpen, setViewerOpen] = useState(false);

  const viewerData = activeViewerDocId ? (viewerDataMap[activeViewerDocId] ?? null) : null;

  const closeViewer = useCallback(() => {
    setViewerOpen(false);
    setActiveBoxIndex(null);
  }, []);

  // The viewer resolves this to a box and navigates to its page.
  const activeBox = useMemo(() => {
    if (activeBoxIndex == null) return null;
    const box = viewerData?.boundingBoxes[activeBoxIndex];
    if (!box) return null;
    return { fieldId: box.fieldId, page: box.page, index: activeBoxIndex };
  }, [activeBoxIndex, viewerData]);

  // ── Upload a single file (after dedup resolved) ──
  const uploadFile = useCallback(
    async (file: File, base64: string) => {
      const uploadId = crypto.randomUUID();
      setUploading((prev) => [...prev, { id: uploadId, filename: file.name, progress: 60 }]);

      try {
        const { uploadDocument } = await import("../../routes/api/-documents");
        const result = await callServerFn(uploadDocument, {
          data: {
            filename: file.name,
            contentType: file.type,
            fileBase64: base64,
            documentType: "receipt" as const,
            intakeMode: "evidence_only" as const,
          },
        });

        setUploading((prev) => prev.map((u) => (u.id === uploadId ? { ...u, progress: 100 } : u)));

        if (result?.success && result.document) {
          let previewUrl: string | undefined;
          if (file.type.startsWith("image/")) {
            previewUrl = URL.createObjectURL(file);
          }

          const newDoc: StagedDocument = {
            documentId: result.document.id,
            filename: file.name,
            contentType: file.type,
            fileSizeBytes: file.size,
            previewUrl,
          };

          onDocumentsChange([...stagedDocuments, newDoc]);
        }
      } catch (err) {
        setError(`Upload failed: ${err instanceof Error ? err.message : "Unknown error"}`);
      } finally {
        setUploading((prev) => prev.filter((u) => u.id !== uploadId));
      }
    },
    [stagedDocuments, onDocumentsChange],
  );

  // ── Handle files with duplicate check ──
  const handleFiles = useCallback(
    async (files: FileList | File[]) => {
      const fileArray = Array.from(files);
      if (fileArray.length === 0) return;

      setError(null);

      for (const file of fileArray) {
        // Validate file type
        const allowed = ["image/jpeg", "image/png", "image/webp", "image/gif", "application/pdf"];
        if (!allowed.includes(file.type)) {
          setError(`Unsupported file: ${file.name}. Use images or PDFs.`);
          continue;
        }

        // Max 20MB
        if (file.size > 20 * 1024 * 1024) {
          setError(`File too large: ${file.name} (max 20MB)`);
          continue;
        }

        // Convert to base64
        const buffer = await file.arrayBuffer();
        const base64 = btoa(
          new Uint8Array(buffer).reduce((data, byte) => data + String.fromCharCode(byte), ""),
        );

        // Check for duplicates
        try {
          const { checkDuplicateDocument } = await import("../../routes/api/-documents");
          const dupCheck = await callServerFn(checkDuplicateDocument, {
            data: { filename: file.name },
          });

          if (dupCheck.exists && dupCheck.existingDocument) {
            // Show duplicate prompt — only for first duplicate per batch
            setDuplicatePrompt({
              file,
              base64,
              existingDocId: dupCheck.existingDocument.id,
              existingFilename: dupCheck.existingDocument.originalFilename,
            });
            return; // Wait for user decision
          }
        } catch {
          // If dedup check fails, proceed with upload
        }

        await uploadFile(file, base64);
      }
    },
    [uploadFile],
  );

  // ── Duplicate resolution handlers ──
  const handleAttachExisting = useCallback(() => {
    if (!duplicatePrompt) return;
    // Reuse existing doc — no re-upload
    const alreadyStaged = stagedDocuments.some(
      (d) => d.documentId === duplicatePrompt.existingDocId,
    );
    if (!alreadyStaged) {
      onDocumentsChange([
        ...stagedDocuments,
        {
          documentId: duplicatePrompt.existingDocId,
          filename: duplicatePrompt.existingFilename,
          contentType: duplicatePrompt.file.type,
          fileSizeBytes: duplicatePrompt.file.size,
        },
      ]);
    }
    setDuplicatePrompt(null);
  }, [duplicatePrompt, stagedDocuments, onDocumentsChange]);

  const handleUploadNewCopy = useCallback(async () => {
    if (!duplicatePrompt) return;
    setDuplicatePrompt(null);
    await uploadFile(duplicatePrompt.file, duplicatePrompt.base64);
  }, [duplicatePrompt, uploadFile]);

  // ── Drag & drop handlers ──
  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragOver(false);
      handleFiles(e.dataTransfer.files);
    },
    [handleFiles],
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
  }, []);

  const handleBrowse = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files) {
        handleFiles(e.target.files);
        e.target.value = "";
      }
    },
    [handleFiles],
  );

  const handleRemove = useCallback(
    (docId: string) => {
      const doc = stagedDocuments.find((d) => d.documentId === docId);
      if (doc?.previewUrl) URL.revokeObjectURL(doc.previewUrl);
      onDocumentsChange(stagedDocuments.filter((d) => d.documentId !== docId));
    },
    [stagedDocuments, onDocumentsChange],
  );

  /**
   * Read the viewer payload. Never triggers a scan — page images exist
   * independently of bounding boxes, which is what lets the viewer open
   * immediately and fill boxes in later.
   */
  const loadViewerData = useCallback(async (documentId: string): Promise<ViewerData | null> => {
    const { getDocumentViewerData } = await import("../../routes/api/-documents");
    const result = await callServerFn(getDocumentViewerData, { data: { documentId } });
    if (!result?.imageUrl && (result?.imageUrls?.length ?? 0) === 0) return null;
    const data: ViewerData = {
      imageUrl: result.imageUrl ?? result.imageUrls[0],
      imageUrls: result.imageUrls ?? [],
      pageCount: result.pageCount ?? result.imageUrls?.length ?? 1,
      ...(result.documentUrl ? { documentUrl: result.documentUrl } : {}),
      boundingBoxes: (result.boundingBoxes ?? []) as BoundingBox[],
      documentId,
    };
    if (mountedRef.current) {
      setViewerDataMap((prev) => ({ ...prev, [documentId]: data }));
    }
    return data;
  }, []);

  /**
   * Show the document, then detect its fields.
   *
   * Field detection is a queued worker job now, so this can take far longer
   * than the single request it replaced. Images are loaded first and the
   * scan is polled in the background rather than making the user wait on a
   * blank modal.
   */
  const extractViewerData = useCallback(
    async (documentId: string) => {
      setActiveViewerDocId(documentId);
      try {
        const existing = await loadViewerData(documentId);
        if (existing && existing.boundingBoxes.length > 0) return;

        // Guard the SCAN only. Loading page images above must stay available
        // while another document is scanning, or the eye button silently
        // does nothing.
        if (scanningDocId) return;
        setScanningDocId(documentId);
        const { startFieldScan } = await import("../../routes/api/-ai-bill-ocr");
        const { pollFieldScan } = await import("../../lib/reconciliation-ocr-store");
        const queued = (await callServerFn(startFieldScan, { data: { documentId } })) as {
          jobId: string | null;
        };
        if (!queued.jobId) throw new Error("Field scan could not be queued. Try again shortly.");

        const outcome = await pollFieldScan(queued.jobId, documentId);
        if (outcome.outcome === "deferred") {
          const { describeDeferredScan } = await import("../../lib/reconciliation-ocr-store");
          throw new Error(
            `Field detection is taking longer than expected. ${describeDeferredScan(outcome.status)}`,
          );
        }
        if (outcome.status.status === "failed") {
          throw new Error(outcome.status.error || "Field detection failed.");
        }
        // The poll may outlive this component; skip the state writes if so.
        if (!mountedRef.current) return;
        await loadViewerData(documentId);
        onDocumentsChange(
          stagedDocuments.map((d) =>
            d.documentId === documentId ? { ...d, hasOcrData: true } : d,
          ),
        );
      } catch (err) {
        // Previously swallowed into a logger. A queued scan can time out or
        // return a real error message, and the user needs to see it.
        logger.error("Bounding box extraction failed", { error: err });
        if (mountedRef.current) {
          setError(err instanceof Error ? err.message : "Field detection failed.");
        }
      } finally {
        if (mountedRef.current) setScanningDocId(null);
      }
    },
    [loadViewerData, onDocumentsChange, stagedDocuments, scanningDocId],
  );

  const handleFieldClick = useCallback(
    (fieldName: string) => {
      if (!viewerData || viewerData.boundingBoxes.length === 0) return;
      const bboxFieldId = FIELD_TO_BBOX[fieldName];
      if (!bboxFieldId) return;
      // `find`, not `some`: the box's page has to travel with it, or the
      // viewer opens on page 0 while the match lives on page 3 — the
      // highlight then silently never appears.
      const index = viewerData.boundingBoxes.findIndex((b) => b.fieldId === bboxFieldId);
      if (index < 0) return;
      setActiveBoxIndex(index);
      setViewerOpen(true);
    },
    [viewerData],
  );

  const handleLineClick = useCallback(
    (lineIndex: number) => {
      if (!viewerData || viewerData.boundingBoxes.length === 0) return;
      const fieldId = `line_item_${lineIndex}`;
      const index = viewerData.boundingBoxes.findIndex((b) => b.fieldId === fieldId);
      if (index < 0) return;
      setActiveBoxIndex(index);
      setViewerOpen(true);
    },
    [viewerData],
  );

  const handleParseAttachment = useCallback(
    async (documentId: string, filename: string, forceReparse = false) => {
      if (parsingDocId) return;

      setParsingDocId(documentId);
      setError(null);
      setParsedResult(null);
      setResultFromCache(false);
      setEntityProposals([]);
      lastParsedDocRef.current = { documentId, filename };

      try {
        const { getDocumentContentBase64 } = await import("../../routes/api/-documents");
        const docContent = (await callServerFn(getDocumentContentBase64, {
          data: { documentId },
        })) as {
          base64: string;
          mimeType: string;
          filename: string | null;
          cachedOcrFields?: { fieldId: string; label: string; text: string }[];
          hasCachedBboxes: boolean;
          aiTransactionCache: {
            result: Record<string, unknown>;
            cachedAt: string;
            contextHash: string;
          } | null;
        };

        if (!forceReparse && docContent.aiTransactionCache?.result) {
          const cached = docContent.aiTransactionCache.result as unknown as ParsedTransactionResult;
          const validated = validateCachedResult(cached, accounts, parties);
          setParsedResult(validated);
          setResultFromCache(true);
          setParsingDocId(null);
          return;
        }

        const preExtractedFields =
          docContent.cachedOcrFields ??
          (viewerDataMap[documentId]
            ? viewerDataMap[documentId].boundingBoxes
                .filter((b) => b.text)
                .map((b) => ({ fieldId: b.fieldId, label: b.label, text: b.text! }))
            : undefined);

        const { parseReceiptDocument } = await import("../../routes/api/-ai-receipt-ocr");

        const parsed = (await callServerFn(parseReceiptDocument, {
          data: {
            base64Content: docContent.base64,
            mimeType: docContent.mimeType,
            currentDate,
            accounts: accounts.map((a) => ({
              id: a.id,
              name: a.name,
              accountNumber: a.accountNumber,
              accountType: a.accountType,
            })),
            parties: parties.map((p) => ({ id: p.id, name: p.name })),
            departments: departments.map((d) => ({ id: d.id, name: d.name })),
            locations: locations.map((l) => ({ id: l.id, name: l.name })),
            preExtractedFields,
          },
        })) as any;

        if (parsed?.needsReview === true && !parsed?.transactionType) {
          // Server-side schema validation rejected the model output — surface
          // the issues instead of applying garbage to the form (no Apply gate
          // bypass: parsedResult stays null so the Apply button never renders).
          const issues: string[] = Array.isArray(parsed.validationIssues)
            ? parsed.validationIssues
            : [];
          setError(
            `AI could not reliably read this document${issues.length > 0 ? ` (${issues.slice(0, 3).join("; ")}${issues.length > 3 ? "; …" : ""})` : ""}. Try re-parsing or enter the transaction manually.`,
          );
          return;
        }

        let enrichedResult = parsed;
        if (parsed.extractedEntities && parsed.extractedEntities.length > 0) {
          try {
            const { resolveExtractedEntities } =
              await import("../../routes/api/-ai-entity-resolver");
            const resolved = (await callServerFn(resolveExtractedEntities, {
              data: { entities: parsed.extractedEntities, sourceDocumentId: documentId },
            })) as any;

            if (Array.isArray(resolved.proposals)) {
              setEntityProposals(resolved.proposals as EntityCreationProposal[]);
            }

            enrichedResult = { ...parsed };
            if (resolved.primaryPartyId && !enrichedResult.partyId) {
              enrichedResult.partyId = resolved.primaryPartyId;
              const resolvedParty = resolved.entities.find(
                (e: any) => e.partyId === resolved.primaryPartyId,
              );
              if (resolvedParty?.partyName && !enrichedResult.partyName) {
                enrichedResult.partyName = resolvedParty.partyName;
              }
            }
            if (
              resolved.suggestedPayCategoryId &&
              (enrichedResult.transactionType === "pay_out" ||
                enrichedResult.transactionType === "pay_in")
            ) {
              enrichedResult.categoryId = resolved.suggestedPayCategoryId;
              if (resolved.suggestedPayCategoryName) {
                enrichedResult.categoryName = resolved.suggestedPayCategoryName;
              }
            } else if (resolved.suggestedPayCategoryId && !enrichedResult.categoryId) {
              enrichedResult.categoryId = resolved.suggestedPayCategoryId;
            }
          } catch {}
          await onEntitiesResolved?.();
        }

        setParsedResult(enrichedResult);

        import("../../routes/api/-documents")
          .then(({ cacheDocumentTransactionResult }) =>
            callServerFn(cacheDocumentTransactionResult, {
              data: {
                documentId,
                result: enrichedResult as unknown as Record<string, unknown>,
                contextHash: computeContextHash(accounts),
              },
            }),
          )
          .catch(() => {});

        if (!docContent.hasCachedBboxes) {
          extractViewerData(documentId);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to parse attachment");
      } finally {
        setParsingDocId(null);
      }
    },
    [parsingDocId, currentDate, accounts, parties, departments, locations],
  );

  const typeLabel = (t: string) => {
    switch (t) {
      case "pay_out":
        return "Pay Out";
      case "pay_in":
        return "Pay In";
      case "journal":
        return "Journal";
      case "transfer":
        return "Transfer";
      default:
        return t;
    }
  };

  const handleApply = useCallback(() => {
    if (parsedResult) {
      onApply(parsedResult);
      setParsedResult(null);
    }
  }, [parsedResult, onApply]);

  // A "Suggested records" card was approved or rejected: drop the card, and on
  // approval merge the newly created IDs into the parsed form (same logic as
  // the primaryPartyId / suggestedPayCategoryId merges above).
  const handleProposalDone = useCallback(
    (
      proposal: EntityCreationProposal,
      outcome: { action: "approved" | "rejected"; result: Record<string, unknown> | null },
    ) => {
      setEntityProposals((prev) => prev.filter((p) => p.proposalId !== proposal.proposalId));
      if (outcome.action !== "approved" || !outcome.result) return;

      const result = outcome.result;
      const partyId = typeof result.partyId === "string" ? result.partyId : undefined;
      const partyName = typeof result.partyName === "string" ? result.partyName : undefined;
      const accountId = typeof result.accountId === "string" ? result.accountId : undefined;

      setParsedResult((prev) => {
        if (!prev) return prev;
        const next = { ...prev };
        if (partyId && !next.partyId) {
          next.partyId = partyId;
          if (partyName && !next.partyName) next.partyName = partyName;
        }
        if (
          accountId &&
          (next.transactionType === "pay_in" || next.transactionType === "pay_out") &&
          !next.categoryId
        ) {
          next.categoryId = accountId;
          if (!next.categoryName && proposal.entity.entityType === "bank") {
            next.categoryName = formatBankAccountLabel(proposal.entity);
          }
        }
        return next;
      });

      // New party/account rows exist now — let the parent refresh its lists.
      void onEntitiesResolved?.();
    },
    [onEntitiesResolved],
  );

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <div className="flex flex-col gap-3 h-full">
      {/* Drop zone */}
      <div
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onClick={handleBrowse}
        onKeyDown={(e) => e.key === "Enter" && handleBrowse()}
        role="button"
        tabIndex={0}
        className={`flex flex-col items-center justify-center gap-2 px-4 py-6 rounded-xl border-2 border-dashed cursor-pointer transition-all ${
          isDragOver
            ? "border-[var(--color-app-header-teal)] bg-[var(--color-app-header-teal)]/5 scale-[1.01]"
            : "border-[#cbd5e1] dark:border-slate-600 hover:border-[var(--color-app-header-teal)] hover:bg-[#f8fafb] dark:hover:bg-slate-800/50"
        }`}
      >
        {/* Icon */}
        <div
          className={`w-10 h-10 rounded-full flex items-center justify-center transition-colors ${
            isDragOver
              ? "bg-[var(--color-app-header-teal)]/10 text-[var(--color-app-header-teal)]"
              : "bg-[#f1f5f9] dark:bg-slate-800 text-[#94a3b8] dark:text-slate-500"
          }`}
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="17 8 12 3 7 8" />
            <line x1="12" y1="3" x2="12" y2="15" />
          </svg>
        </div>
        <div className="text-center">
          <p className="text-xs font-medium text-[var(--color-app-header-teal)]">
            Browse
            <span className="text-[#94a3b8] dark:text-slate-500 font-normal"> or Drag & Drop</span>
          </p>
          <p className="text-[9px] text-[#94a3b8] dark:text-slate-500 mt-0.5">
            Images or PDF — max 20MB
          </p>
        </div>
      </div>

      {/* Browse existing documents button */}
      <button
        type="button"
        onClick={() => setPickerOpen(true)}
        className="flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border border-[#e2e8f0] dark:border-white/10 text-xs font-medium text-[#64748b] dark:text-white/50 hover:text-[#1e293b] dark:hover:text-white hover:bg-[#f8fafc] dark:hover:bg-white/5 transition-colors"
      >
        <svg
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
        </svg>
        Browse existing documents
      </button>

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*,application/pdf"
        multiple
        onChange={handleFileInput}
        className="hidden"
      />

      {/* Duplicate confirmation banner */}
      {duplicatePrompt && (
        <div className="px-3 py-2.5 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/40">
          <p className="text-[11px] font-medium text-amber-800 dark:text-amber-200 mb-2">
            "{duplicatePrompt.existingFilename}" already exists.
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleAttachExisting}
              className="flex-1 px-2 py-1.5 rounded-md bg-white dark:bg-white/10 border border-amber-200 dark:border-amber-700 text-[10px] font-medium text-amber-800 dark:text-amber-200 hover:bg-amber-50 dark:hover:bg-amber-900/30 transition-colors"
            >
              Attach existing
            </button>
            <button
              type="button"
              onClick={handleUploadNewCopy}
              className="flex-1 px-2 py-1.5 rounded-md bg-amber-100 dark:bg-amber-800/40 border border-amber-200 dark:border-amber-700 text-[10px] font-medium text-amber-900 dark:text-amber-100 hover:bg-amber-200 dark:hover:bg-amber-700/40 transition-colors"
            >
              Upload new copy
            </button>
          </div>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="px-2.5 py-2 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 flex items-center gap-2">
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#ef4444"
            strokeWidth="2"
          >
            <circle cx="12" cy="12" r="10" />
            <line x1="15" y1="9" x2="9" y2="15" />
            <line x1="9" y1="9" x2="15" y2="15" />
          </svg>
          <p className="text-[10px] text-red-700 dark:text-red-300 flex-1">{error}</p>
          <button
            type="button"
            onClick={() => setError(null)}
            className="text-red-400 hover:text-red-600 cursor-pointer"
          >
            <svg
              width="10"
              height="10"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
            >
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}

      {/* Uploading items */}
      {uploading.map((item) => (
        <div
          key={item.id}
          className="flex items-center gap-2.5 px-3 py-2 rounded-lg bg-[#f8fafb] dark:bg-slate-800 border border-[#e2e8f0] dark:border-slate-700"
        >
          <div className="w-8 h-8 rounded-lg bg-[var(--color-app-header-teal)]/10 flex items-center justify-center shrink-0">
            <svg
              className="animate-spin text-[var(--color-app-header-teal)]"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
            >
              <circle
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="3"
                strokeDasharray="32"
                strokeLinecap="round"
              />
            </svg>
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-[10px] font-medium text-[#1e293b] dark:text-white truncate">
              {item.filename}
            </p>
            <div className="w-full h-1 mt-1 rounded-full bg-[#e2e8f0] dark:bg-slate-700 overflow-hidden">
              <div
                className="h-full rounded-full bg-[var(--color-app-header-teal)] transition-all duration-300"
                style={{ width: `${item.progress}%` }}
              />
            </div>
          </div>
        </div>
      ))}

      {/* Uploaded files */}
      {stagedDocuments.map((doc) => (
        <div key={doc.documentId} className="flex flex-col gap-2">
          <div className="flex items-center gap-2.5 px-3 py-2 rounded-lg bg-white dark:bg-slate-800 border border-[#e2e8f0] dark:border-slate-700 group hover:border-[var(--color-app-header-teal)]/40 transition-colors">
            {doc.previewUrl ? (
              <img
                src={doc.previewUrl}
                alt={doc.filename}
                className="w-8 h-8 rounded-lg object-cover shrink-0"
              />
            ) : (
              <div className="w-8 h-8 rounded-lg bg-red-50 dark:bg-red-900/20 flex items-center justify-center shrink-0">
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="#ef4444"
                  strokeWidth="1.5"
                >
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                  <line x1="16" y1="13" x2="8" y2="13" />
                  <line x1="16" y1="17" x2="8" y2="17" />
                </svg>
              </div>
            )}
            <div className="flex-1 min-w-0">
              <p className="text-[10px] font-medium text-[#1e293b] dark:text-white truncate">
                {doc.filename}
              </p>
              <p className="text-[9px] text-[#94a3b8] dark:text-slate-500">
                {formatSize(doc.fileSizeBytes)}
              </p>
            </div>

            <div className="flex items-center gap-1.5">
              {canRunAi &&
              (parsedResult === null || lastParsedDocRef.current?.documentId !== doc.documentId) ? (
                <button
                  type="button"
                  disabled={parsingDocId !== null}
                  onClick={() => handleParseAttachment(doc.documentId, doc.filename)}
                  className="flex items-center gap-1 px-2.5 py-1 rounded-md text-[10px] font-medium text-[var(--color-app-header-teal)] bg-[var(--color-app-header-teal)]/10 hover:bg-[var(--color-app-header-teal)]/20 disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer shrink-0"
                >
                  {parsingDocId === doc.documentId ? (
                    <>
                      <svg
                        className="animate-spin"
                        width="10"
                        height="10"
                        viewBox="0 0 24 24"
                        fill="none"
                      >
                        <circle
                          cx="12"
                          cy="12"
                          r="10"
                          stroke="currentColor"
                          strokeWidth="3"
                          strokeDasharray="32"
                          strokeLinecap="round"
                        />
                      </svg>
                      Parsing...
                    </>
                  ) : (
                    <>✨ Parse with AI</>
                  )}
                </button>
              ) : null}

              {(doc.hasOcrData || viewerDataMap[doc.documentId]) && (
                <button
                  type="button"
                  onClick={() => {
                    if (viewerDataMap[doc.documentId]) {
                      setActiveViewerDocId(doc.documentId);
                      setActiveBoxIndex(null);
                      setViewerOpen(true);
                    } else {
                      void extractViewerData(doc.documentId).then(() => setViewerOpen(true));
                    }
                  }}
                  className="w-7 h-7 min-h-11 min-w-11 lg:min-h-0 lg:min-w-0 rounded-md flex items-center justify-center text-[#3b82f6] hover:bg-[#3b82f6]/10 transition-colors cursor-pointer shrink-0"
                  title="View document with detected fields"
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                </button>
              )}

              <button
                type="button"
                onClick={() => handleRemove(doc.documentId)}
                className="w-7 h-7 min-h-11 min-w-11 lg:min-h-0 lg:min-w-0 rounded-md flex items-center justify-center text-[#94a3b8] hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors cursor-pointer shrink-0 opacity-0 group-hover:opacity-100"
                title="Remove attachment"
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                >
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>

          {/* AI Result UI below the active row */}
          {parsedResult && lastParsedDocRef.current?.documentId === doc.documentId && (
            <div className="ml-8 border-l-2 border-[var(--color-app-header-teal)]/30 pl-3 py-1">
              <div className="rounded-lg border border-[var(--color-app-header-teal)]/20 bg-[var(--color-app-header-teal)]/5 overflow-hidden flex flex-col">
                <div className="px-2.5 py-2 bg-[var(--color-app-header-teal)]/10 border-b border-[var(--color-app-header-teal)]/15">
                  <p className="text-[10px] font-medium text-[var(--color-app-header-teal)] leading-snug">
                    {parsedResult.interpretation}
                  </p>
                  <div className="flex items-center gap-2 mt-1">
                    <span className="text-[9px] px-1 py-0.5 rounded-full bg-[var(--color-app-header-teal)]/20 text-[var(--color-app-header-teal)] font-medium inline-block">
                      {Math.round((parsedResult.confidence ?? 0) * 100)}% confident
                    </span>
                    {resultFromCache && (
                      <span className="text-[9px] px-1 py-0.5 rounded-full bg-[#8b5cf6]/15 text-[#8b5cf6] font-medium inline-block">
                        ⚡ Instant
                      </span>
                    )}
                    {viewerData && (
                      <button
                        type="button"
                        onClick={() => setViewerOpen(true)}
                        className="flex items-center gap-0.5 text-[9px] px-1.5 py-0.5 rounded-full bg-[#3b82f6]/10 text-[#3b82f6] font-medium hover:bg-[#3b82f6]/20 transition-colors cursor-pointer"
                      >
                        <svg
                          width="8"
                          height="8"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2.5"
                        >
                          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                          <polyline points="14 2 14 8 20 8" />
                        </svg>
                        View Document
                      </button>
                    )}
                  </div>
                </div>

                <div className="px-2.5 py-2 grid grid-cols-2 gap-x-3 gap-y-1.5">
                  <FieldPreview label="Type" value={typeLabel(parsedResult.transactionType)} />
                  {parsedResult.categoryName && (
                    <FieldPreview
                      label={
                        parsedResult.transactionType === "pay_out"
                          ? "Pay Out Category"
                          : parsedResult.transactionType === "pay_in"
                            ? "Pay In Category"
                            : parsedResult.transactionType === "transfer"
                              ? "From Account"
                              : "Category"
                      }
                      value={parsedResult.categoryName}
                      onClick={() => handleFieldClick("categoryName")}
                      hasViewer={!!viewerData}
                    />
                  )}
                  <FieldPreview
                    label="Date"
                    value={parsedResult.date}
                    onClick={() => handleFieldClick("date")}
                    hasViewer={!!viewerData}
                  />
                  <FieldPreview
                    label="Amount"
                    value={parsedResult.amount ? `$${parsedResult.amount}` : "—"}
                    onClick={() => handleFieldClick("amount")}
                    hasViewer={!!viewerData}
                  />
                  {parsedResult.partyName && (
                    <FieldPreview
                      label="Party"
                      value={parsedResult.partyName}
                      onClick={() => handleFieldClick("partyName")}
                      hasViewer={!!viewerData}
                    />
                  )}
                  {parsedResult.memo && (
                    <FieldPreview
                      label="Memo"
                      value={parsedResult.memo}
                      onClick={() => handleFieldClick("memo")}
                      hasViewer={!!viewerData}
                    />
                  )}
                  {parsedResult.departmentName && (
                    <FieldPreview label="Dept" value={parsedResult.departmentName} />
                  )}
                  {parsedResult.locationName && (
                    <FieldPreview label="Location" value={parsedResult.locationName} />
                  )}
                </div>

                {parsedResult.lines.length > 0 && (
                  <div className="px-2.5 pb-2">
                    <p className="text-[9px] font-semibold text-[#475569] dark:text-slate-400 mb-1">
                      Lines ({parsedResult.lines.length})
                    </p>
                    <div className="space-y-0.5">
                      {parsedResult.lines.map((line, i) => (
                        <div
                          key={`${line.description}-${i}`}
                          className={`flex items-center justify-between text-[10px] text-[#475569] dark:text-slate-400 px-2 py-0.5 rounded bg-white/50 dark:bg-slate-800/50 ${viewerData ? "cursor-pointer hover:bg-[#3b82f6]/5 transition-colors" : ""}`}
                          onClick={() => handleLineClick(i)}
                          role={viewerData ? "button" : undefined}
                          tabIndex={viewerData ? 0 : undefined}
                        >
                          <span className="truncate flex-1">
                            {line.categoryName || line.description || `Line ${i + 1}`}
                          </span>
                          <span className="tabular-nums font-medium ml-1 shrink-0">
                            {line.amount
                              ? `$${line.amount}`
                              : line.debit
                                ? `Dr $${line.debit}`
                                : line.credit
                                  ? `Cr $${line.credit}`
                                  : "—"}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {entityProposals.length > 0 && (
                  <div className="px-2.5 pb-2">
                    <p className="text-[9px] font-semibold text-[#475569] dark:text-slate-400 mb-1">
                      Suggested records ({entityProposals.length})
                    </p>
                    <div className="space-y-1.5">
                      {entityProposals.map((proposal) => (
                        <ProposalReviewCard
                          key={proposal.proposalId}
                          proposalId={proposal.proposalId}
                          kind="create_party"
                          proposal={{ entity: proposal.entity }}
                          summary={proposal.summary}
                          onDone={(outcome) => handleProposalDone(proposal, outcome)}
                        />
                      ))}
                    </div>
                  </div>
                )}

                <div className="px-2.5 py-2 border-t border-[var(--color-app-header-teal)]/15 flex justify-between gap-2">
                  <button
                    type="button"
                    onClick={() => setParsedResult(null)}
                    className="px-2.5 py-1 rounded-md text-[10px] font-medium text-[#64748b] dark:text-slate-400 hover:text-[#1e293b] dark:hover:text-slate-200 hover:bg-[#f1f5f9] dark:hover:bg-slate-800 transition-colors cursor-pointer"
                  >
                    Dismiss
                  </button>
                  <div className="flex items-center gap-1.5">
                    {resultFromCache && (
                      <button
                        type="button"
                        onClick={() => {
                          const ref = lastParsedDocRef.current!;
                          setParsedResult(null);
                          handleParseAttachment(ref.documentId, ref.filename, true);
                        }}
                        className="flex items-center gap-1 px-2.5 py-1 rounded-md text-[10px] font-medium text-[#64748b] dark:text-slate-400 hover:text-[#1e293b] dark:hover:text-slate-200 hover:bg-[#f1f5f9] dark:hover:bg-slate-800 border border-[#e2e8f0] dark:border-white/10 transition-colors cursor-pointer"
                      >
                        <svg
                          width="10"
                          height="10"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                        >
                          <polyline points="23 4 23 10 17 10" />
                          <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                        </svg>
                        Re-parse
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={handleApply}
                      className="flex items-center gap-1 px-3 py-1 rounded-md bg-[var(--color-app-header-teal)] hover:bg-[#248f82] text-white text-[10px] font-medium transition-colors cursor-pointer"
                    >
                      <svg
                        width="10"
                        height="10"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                      >
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                      Apply
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      ))}

      {/* Empty state */}
      {stagedDocuments.length === 0 && uploading.length === 0 && (
        <div className="flex-1 flex flex-col items-center justify-center text-center py-8 opacity-60">
          <svg
            width="32"
            height="32"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#94a3b8"
            strokeWidth="1"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="mb-2"
          >
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
          </svg>
          <p className="text-[10px] text-[#94a3b8] dark:text-slate-500 font-medium">
            No attachments yet
          </p>
          <p className="text-[9px] text-[#94a3b8] dark:text-slate-500 mt-0.5">
            Drop receipts, invoices, or documents
          </p>
        </div>
      )}

      {/* Document Picker Modal */}
      <DocumentPickerModal
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        excludeDocumentIds={stagedDocuments.map((d) => d.documentId)}
        onAttach={(docs) => {
          onDocumentsChange([...stagedDocuments, ...docs]);
        }}
      />

      {/* Document Viewer Modal */}
      {viewerData && (
        <Modal
          open={viewerOpen}
          onClose={closeViewer}
          title="Document Viewer"
          description={
            viewerData.boundingBoxes.length > 0
              ? `${viewerData.boundingBoxes.length} fields detected`
              : undefined
          }
          mobile="fullscreen"
          size="xl"
          bodyClassName="p-0 flex flex-col"
        >
          {/* Interactive viewer */}
          <div className="flex-1 min-h-0 overflow-y-auto p-4">
            <InteractiveDocumentViewer
              imageUrl={viewerData.imageUrl}
              imageUrls={viewerData.imageUrls}
              totalPages={viewerData.pageCount}
              documentUrl={viewerData.documentUrl}
              boundingBoxes={viewerData.boundingBoxes}
              activeBox={activeBox}
              isPreviewPending={scanningDocId === viewerData.documentId}
            />
          </div>

          {/* Field chips — click to zoom. Kept in the body rather than Modal's `footer`,
              which stacks its children full-width on mobile and would turn each chip
              into its own row. */}
          {viewerData.boundingBoxes.length > 0 && (
            <div className="shrink-0 px-4 sm:px-5 py-3 border-t border-[#e2e8f0] dark:border-white/10 flex flex-wrap gap-1.5">
              <span className="text-[10px] font-medium text-[#94a3b8] dark:text-slate-500 self-center mr-1">
                Jump to:
              </span>
              {viewerData.boundingBoxes
                // Track the original index so the chip can address its exact
                // box; filtering first would renumber them.
                .map((box, index) => ({ box, index }))
                .filter(({ box }) => !box.fieldId.startsWith("line_item_"))
                .map(({ box, index }) => (
                  <button
                    key={`${box.page ?? 0}:${box.fieldId}:${index}`}
                    type="button"
                    onClick={() => setActiveBoxIndex(index)}
                    className={`touch-target px-2 py-0.5 rounded-full text-[10px] font-medium transition-colors cursor-pointer ${
                      activeBoxIndex === index
                        ? "bg-[#10b981]/20 text-[#10b981] ring-1 ring-[#10b981]/30"
                        : "bg-[#f1f5f9] dark:bg-slate-800 text-[#475569] dark:text-slate-400 hover:bg-[#e2e8f0] dark:hover:bg-slate-700"
                    }`}
                  >
                    {box.label}
                    {viewerData.pageCount > 1 && (
                      <span className="ml-1 opacity-60">p{(box.page ?? 0) + 1}</span>
                    )}
                  </button>
                ))}
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}

function FieldPreview({
  label,
  value,
  onClick,
  hasViewer,
}: {
  label: string;
  value: string;
  onClick?: () => void;
  hasViewer?: boolean;
}) {
  const isClickable = hasViewer && onClick;
  return (
    <div
      className={`min-w-0 ${
        isClickable
          ? "cursor-pointer rounded px-1 -mx-1 py-0.5 -my-0.5 hover:bg-[#3b82f6]/5 transition-colors group"
          : ""
      }`}
      onClick={onClick}
      onKeyDown={undefined}
      role={isClickable ? "button" : undefined}
      tabIndex={isClickable ? 0 : undefined}
    >
      <p className="text-[9px] font-medium text-[#94a3b8] dark:text-slate-500 flex items-center gap-0.5">
        {label}
        {isClickable && (
          <svg
            width="7"
            height="7"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            className="opacity-0 group-hover:opacity-50 transition-opacity"
          >
            <circle cx="11" cy="11" r="8" />
            <path d="M21 21l-4.35-4.35" />
          </svg>
        )}
      </p>
      <p className="text-[10px] font-medium text-[#1e293b] dark:text-white truncate">{value}</p>
    </div>
  );
}
