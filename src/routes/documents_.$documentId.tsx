/**
 * Document Detail Page — Viewer + metadata sidebar
 */
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, useCallback, useMemo } from "react";
import {
  getDocument,
  getDocumentUrl,
  deleteDocument,
  updateDocument,
  generateDocumentThumbnail,
  regenerateDocumentThumbnailWithAI,
  getDocumentThumbnailUrl,
  getDocumentViewerData,
  detachDocument,
} from "./api/-documents";
import { startFieldScan } from "./api/-ai-bill-ocr";
import { pollFieldScan, describeDeferredScan } from "../lib/reconciliation-ocr-store";
import { InteractiveDocumentViewer } from "../components/bills/InteractiveDocumentViewer";
import { Modal } from "../components/ui/Modal";
import {
  FileTypeIcon,
  formatFileSize,
  getDocumentTypeLabel,
} from "../components/documents/DocumentUploadModal";
import { createLogger } from "../lib/logger";
import type { DocumentBoundingBox, DocumentViewerData } from "../lib/document-types";
import { callServerFn } from "../lib/server-fn-client";

const logger = createLogger("ui.documents");

// ============================================================================
// Types
// ============================================================================

interface DocumentDetail {
  id: string;
  originalFilename: string;
  displayTitle: string | null;
  summary: string | null;
  documentType: string;
  fileType: string;
  fileSizeBytes: number | null;
  mimeType: string | null;
  storagePath: string;
  r2Key: string | null;
  thumbnailR2Key: string | null;
  uploadedById: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
  ocrBoundingBoxes?: DocumentBoundingBox[] | null;
}

interface Attachment {
  id: string;
  linkableType: string;
  linkableId: string;
  partyType: string | null;
  createdAt: Date | string;
}

function isDocumentLinkableType(
  value: string,
): value is Parameters<typeof detachDocument>[0]["data"]["linkableType"] {
  return [
    "journal_header",
    "invoice",
    "bill",
    "party",
    "reconciliation",
    "financial_account",
  ].includes(value);
}

// ============================================================================
// Field Color Mapping (matches InteractiveDocumentViewer)
// ============================================================================

const FIELD_COLORS: Record<string, string> = {
  vendor_name: "#10b981",
  vendor_email: "#059669",
  vendor_address: "#14b8a6",
  invoice_number: "#3b82f6",
  invoice_date: "#6366f1",
  due_date: "#8b5cf6",
  total_amount: "#f59e0b",
  line_items: "#ec4899",
  payment_terms: "#06b6d4",
  recipient_name: "#0ea5e9",
  recipient_email: "#0284c7",
  recipient_address: "#0369a1",
  memo: "#64748b",
  // Bank statement fields
  account_number: "#3b82f6",
  account_holder: "#0ea5e9",
  statement_period: "#6366f1",
  beginning_balance: "#f97316",
  ending_balance: "#f59e0b",
  total_deposits: "#10b981",
  total_withdrawals: "#ef4444",
  reference_number: "#8b5cf6",
};

function getFieldColorForViewer(fieldId: string | undefined | null): string {
  if (!fieldId) return "#10b981";
  if (fieldId.startsWith("line_item_")) return "#ec4899";
  return FIELD_COLORS[fieldId] ?? "#10b981";
}

// Friendly display labels — fieldId stays unchanged for viewer highlight compatibility
const FRIENDLY_LABELS: Record<string, string> = {
  vendor_name: "Vendor / Merchant",
  vendor_address: "Address",
  vendor_email: "Email",
  vendor_country: "Country",
  invoice_number: "Reference #",
  invoice_date: "Date",
  due_date: "Due Date",
  total_amount: "Total Amount",
  payment_terms: "Payment Method",
  memo: "Notes / Memo",
  recipient_name: "Recipient",
  recipient_email: "Recipient Email",
  recipient_address: "Recipient Address",
  // Bank statement fields
  account_number: "Account Number",
  account_holder: "Account Holder",
  statement_period: "Statement Period",
  beginning_balance: "Beginning Balance",
  ending_balance: "Ending Balance",
  total_deposits: "Total Deposits",
  total_withdrawals: "Total Withdrawals",
  reference_number: "Reference Number",
};

function getFriendlyFieldLabel(fieldId: string | undefined | null, fallbackLabel: string): string {
  if (!fieldId) return fallbackLabel || "Field";
  if (fieldId.startsWith("line_item_")) {
    const idx = parseInt(fieldId.replace("line_item_", ""), 10);
    return `Line Item ${isNaN(idx) ? "" : idx + 1}`;
  }
  return FRIENDLY_LABELS[fieldId] ?? fallbackLabel;
}

// ============================================================================
// Route
// ============================================================================

export const Route = createFileRoute("/documents_/$documentId")({
  component: DocumentDetailPage,
});

// ============================================================================
// Page Component
// ============================================================================

function DocumentDetailPage() {
  const { documentId } = Route.useParams() as { documentId: string };
  const queryClient = useQueryClient();
  const [editingTitle, setEditingTitle] = useState(false);
  const [editingSummary, setEditingSummary] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [summaryDraft, setSummaryDraft] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [viewerOpen, setViewerOpen] = useState(false);
  const [viewerData, setViewerData] = useState<{
    imageUrl: string;
    imageUrls: string[];
    pageCount: number;
    documentUrl?: string;
    boundingBoxes: DocumentBoundingBox[];
  } | null>(null);
  const [isLoadingViewer, setIsLoadingViewer] = useState(false);
  const [unlinkTarget, setUnlinkTarget] = useState<Attachment | null>(null);
  // Index into viewerData.boundingBoxes. An index rather than a fieldId
  // because that list is flat across pages and repeats fieldIds.
  const [activeBoxIndex, setActiveBoxIndex] = useState<number | null>(null);
  const [showMobileViewer, setShowMobileViewer] = useState(false);

  // The viewer resolves this to a box and navigates to its page.
  const activeBox = useMemo(() => {
    if (activeBoxIndex == null) return null;
    const box = viewerData?.boundingBoxes[activeBoxIndex];
    if (!box) return null;
    return { fieldId: box.fieldId, page: box.page, index: activeBoxIndex };
  }, [activeBoxIndex, viewerData]);

  // Fetch document
  const { data, isLoading, error } = useQuery<{
    document: DocumentDetail;
    attachments: Attachment[];
  }>({
    queryKey: ["document", documentId],
    queryFn: () => callServerFn(getDocument, { data: { documentId } }) as any,
  });

  // Fetch presigned URL for viewing
  const { data: urlData } = useQuery({
    queryKey: ["documentUrl", documentId],
    queryFn: () => callServerFn(getDocumentUrl, { data: { documentId } }),
    enabled: !!data?.document,
  });

  // Calculate load error based on server response (url will be null if missing)
  const serverReportedMissing = urlData && urlData.url === null;
  const loadError = serverReportedMissing;

  // Update mutation
  const updateMutation = useMutation({
    mutationFn: (updateData: { documentId: string; displayTitle?: string; summary?: string }) =>
      callServerFn(updateDocument, { data: updateData }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["document", documentId] });
    },
  });

  // Delete mutation
  const deleteMutation = useMutation({
    mutationFn: () => callServerFn(deleteDocument, { data: { documentId } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["documents"] });
      window.location.href = "/documents";
    },
    onError: () => {
      // Error is handled by top banner
      setConfirmDelete(false);
    },
  });

  // Thumbnail URL query
  const { data: thumbnailData } = useQuery({
    queryKey: ["documentThumbnail", documentId],
    queryFn: () => callServerFn(getDocumentThumbnailUrl, { data: { documentId } }),
    enabled: !!data?.document?.thumbnailR2Key,
  });

  // Generate thumbnail mutation
  const generateThumbnailMutation = useMutation({
    mutationFn: () => callServerFn(generateDocumentThumbnail, { data: { documentId } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["document", documentId] });
      queryClient.invalidateQueries({ queryKey: ["documentThumbnail", documentId] });
    },
  });

  // AI thumbnail regeneration mutation (manual override)
  const aiThumbnailMutation = useMutation({
    mutationFn: () => callServerFn(regenerateDocumentThumbnailWithAI, { data: { documentId } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["document", documentId] });
      queryClient.invalidateQueries({ queryKey: ["documentThumbnail", documentId] });
    },
  });

  // Unlink (detach) attachment mutation
  const unlinkMutation = useMutation({
    mutationFn: (att: Attachment) => {
      if (!isDocumentLinkableType(att.linkableType)) {
        throw new Error(`Unsupported attachment type: ${att.linkableType}`);
      }

      return callServerFn(detachDocument, {
        data: {
          documentId,
          linkableType: att.linkableType,
          linkableId: att.linkableId,
        },
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["document", documentId] });
      setUnlinkTarget(null);
    },
  });

  // Scan document for AI-detected fields — enqueues the server-side bbox_scan
  // job (one download + rasterize, every page scanned in the worker) and polls
  // it, rather than holding a request open across N model calls.
  const scanFieldsMutation = useMutation({
    mutationFn: async () => {
      const queued = (await callServerFn(startFieldScan, { data: { documentId } })) as {
        jobId: string | null;
      };
      if (!queued.jobId) {
        throw new Error("Field scan could not be queued. Try again in a moment.");
      }
      const result = await pollFieldScan(queued.jobId, documentId);
      if (result.outcome === "deferred") {
        // Still running server-side — report that honestly rather than
        // claiming a failure or a success neither of which happened.
        throw new Error(
          `Field scan is taking longer than expected. ${describeDeferredScan(result.status)}`,
        );
      }
      if (result.status.status === "failed") {
        throw new Error(result.status.error || "Field scan failed");
      }
      return result.status;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["document", documentId] });
    },
  });

  const doc = data?.document;
  const attachments = data?.attachments ?? [];
  const viewUrl = urlData?.url;
  const thumbnailUrl = thumbnailData?.url ?? null;

  const isImage = doc && ["jpg", "jpeg", "png", "gif", "webp"].includes(doc.fileType);
  const isPdf = doc?.fileType === "pdf";
  const canPreview = isImage || isPdf;
  const hasOcrData = !!doc?.ocrBoundingBoxes?.length;

  const handleOpenViewer = useCallback(async () => {
    if (!doc) return;
    if (viewerData) {
      setViewerOpen(true);
      return;
    }
    setIsLoadingViewer(true);
    try {
      const result: DocumentViewerData = await callServerFn(getDocumentViewerData, {
        data: { documentId },
      });
      if (result.imageUrl || result.imageUrls?.length) {
        setViewerData({
          imageUrl: result.imageUrl ?? result.imageUrls?.[0] ?? "",
          imageUrls: result.imageUrls ?? [],
          pageCount: result.pageCount ?? 1,
          documentUrl: result.documentUrl ?? undefined,
          boundingBoxes: result.boundingBoxes ?? [],
        });
        setViewerOpen(true);
      }
    } catch (err) {
      logger.error("Failed to load viewer data", { error: err });
    } finally {
      setIsLoadingViewer(false);
    }
  }, [doc, documentId, viewerData]);

  function handleSaveTitle() {
    if (!doc) return;
    updateMutation.mutate({ documentId, displayTitle: titleDraft });
    setEditingTitle(false);
  }

  function handleSaveSummary() {
    if (!doc) return;
    updateMutation.mutate({ documentId, summary: summaryDraft });
    setEditingSummary(false);
  }

  function handleDownload() {
    if (viewUrl) {
      const a = document.createElement("a");
      a.href = viewUrl;
      a.download = doc?.originalFilename ?? "document";
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.click();
    }
  }

  function formatDate(dateStr: Date | string): string {
    const d = new Date(dateStr);
    return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
  }

  function getLinkableLabel(type: string): string {
    const labels: Record<string, string> = {
      journal_header: "Journal Entry",
      invoice: "Invoice",
      bill: "Bill",
      party: "Party",
      reconciliation: "Reconciliation",
      financial_account: "Account",
    };
    return labels[type] || type;
  }

  function getLinkableHref(type: string, id: string, partyType?: string | null): string {
    if (type === "party" && partyType) {
      // Map party type to plural entity route
      const entityRoute = partyType === "government" ? "government" : `${partyType}s`;
      return `/entities/${entityRoute}?selected=${id}`;
    }
    const routes: Record<string, string> = {
      journal_header: `/transactions/${id}`,
      invoice: `/invoices/${id}`,
      bill: `/bills/${id}`,
      reconciliation: `/reconciliations/${id}`,
      financial_account: `/entities/banks?selected=${id}`,
    };
    return routes[type] || "#";
  }

  if (isLoading) {
    return (
      <div className="flex flex-col h-full bg-[#fafbfc] dark:bg-[#0c1322]">
        <div className="flex items-center gap-3 px-8 py-5 border-b border-[#e2e8f0] dark:border-white/10">
          <div className="h-5 w-40 rounded bg-[#e2e8f0] dark:bg-white/10 animate-pulse" />
        </div>
        <div className="flex-1 flex">
          <div className="flex-1 bg-[#f1f5f9] dark:bg-[#0f172a] animate-pulse" />
          <div className="w-80 border-l border-[#e2e8f0] dark:border-white/10 p-6">
            <div className="h-6 w-48 rounded bg-[#e2e8f0] dark:bg-white/10 animate-pulse mb-4" />
            <div className="h-4 w-full rounded bg-[#e2e8f0] dark:bg-white/10 animate-pulse mb-2" />
            <div className="h-4 w-2/3 rounded bg-[#e2e8f0] dark:bg-white/10 animate-pulse" />
          </div>
        </div>
      </div>
    );
  }

  if (error || !doc) {
    return (
      <div className="flex flex-col h-full bg-[#fafbfc] dark:bg-[#0c1322] items-center justify-center">
        <div className="text-center">
          <h2 className="text-lg font-semibold text-[#1e293b] dark:text-white mb-2">
            Document not found
          </h2>
          <Link to="/documents" className="text-sm text-[#10b981] hover:underline no-underline">
            ← Back to Documents
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-[#fafbfc] dark:bg-[#0c1322]">
      {/* ── Header ── */}
      <div className="flex items-center justify-between gap-4 px-4 py-3 md:px-8 md:py-4 border-b border-[#e2e8f0] dark:border-white/10">
        <Link
          to="/documents"
          className="touch-target flex items-center justify-center w-8 h-8 md:w-auto md:h-auto gap-2 text-sm font-medium text-[#10b981] hover:text-[#059669] hover:bg-[#10b981]/10 md:hover:bg-transparent rounded-lg transition-colors no-underline"
          title="Back to Documents"
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className="md:w-4 md:h-4"
          >
            <polyline points="15 18 9 12 15 6" />
          </svg>
          <span className="hidden md:inline">Back to Documents</span>
        </Link>

        <div className="flex items-center gap-4">
          {/* Mobile View Toggle */}
          <button
            type="button"
            onClick={() => setShowMobileViewer(true)}
            className="touch-target md:hidden flex items-center justify-center w-8 h-8 rounded-lg border border-[#e2e8f0] dark:border-white/10 text-[#64748b] dark:text-gray-300 hover:bg-[#f1f5f9] dark:hover:bg-white/5 transition-colors"
            title="View Document"
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          </button>
          {/* Create Transaction (Desktop Only for Space) */}
          {/* Create Transaction (Desktop Only for Space) - Removed */} {/* Delete */}
          <button
            type="button"
            onClick={() => setConfirmDelete(true)}
            className="touch-target flex items-center justify-center w-8 h-8 md:w-auto md:h-auto md:gap-1.5 md:px-3 md:py-2 rounded-lg border border-[#e2e8f0] dark:border-white/10 text-sm font-medium text-[#ef4444] hover:bg-[#fef2f2] dark:hover:bg-red-900/20 transition-colors"
            title="Delete Document"
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="md:w-[14px] md:h-[14px]"
            >
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            </svg>
            <span className="hidden md:inline">Delete</span>
          </button>
          {/* Download */}
          <button
            type="button"
            onClick={handleDownload}
            disabled={!viewUrl}
            className="touch-target flex items-center justify-center w-8 h-8 md:w-auto md:h-auto md:gap-1.5 md:px-4 md:py-2 rounded-lg bg-gradient-to-r from-[#10b981] to-[#059669] text-white text-sm font-medium shadow-sm hover:shadow-md transition-all disabled:opacity-50"
            title="Download Document"
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="md:w-[14px] md:h-[14px]"
            >
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            <span className="hidden md:inline">Download</span>
          </button>
        </div>
      </div>

      {/* ── Content ── */}
      <div className="flex-1 flex overflow-hidden relative">
        {/* ── Error Banner (Floating) ── */}
        {deleteMutation.isError && (
          <div className="max-w-7xl max-auto justify-center absolute top-0 left-1/2 -translate-x-1/2  z-50 bg-red-50/95 dark:bg-red-900/90 backdrop-blur-sm border-b border-red-200 dark:border-red-900/50 px-8 py-3 flex items-start gap-3 shadow-md transition-all animate-in slide-in-from-top-2">
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              className="text-red-600 dark:text-red-400 mt-0.5 shrink-0"
            >
              <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" />
              <path
                d="M12 8v4m0 4h.01"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
            <div className="flex-1">
              <h3 className="text-sm font-medium text-red-800 dark:text-red-200">
                Unable to delete document
              </h3>
              <p className="text-sm text-red-700 dark:text-red-300 mt-0.5">
                {(deleteMutation.error as Error)?.message || "An unexpected error occurred."}
              </p>
            </div>
            <button
              type="button"
              onClick={() => deleteMutation.reset()}
              className="text-red-500 hover:text-red-700 dark:text-red-400 dark:hover:text-red-200"
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
        )}

        {/* Left: Viewer (Desktop) */}
        <div className="hidden md:flex flex-1 bg-[#f1f5f9] dark:bg-[#0f172a] items-center justify-center overflow-auto p-8">
          {loadError ? (
            /* Missing file placeholder - Premium UI (Wide & Simplified) */
            <div className="relative w-full max-w-3xl shrink-0 bg-white dark:bg-[#1e293b] rounded-2xl shadow-[0_8px_30px_rgb(0,0,0,0.04)] dark:shadow-none border border-gray-100 dark:border-white/5 p-16 text-center">
              {/* Decorative background blob */}
              <div className="absolute top-0 left-1/2 -translate-x-1/2 -translate-y-1/2 w-32 h-32 bg-red-50 dark:bg-red-900/10 rounded-full blur-3xl opacity-60 pointer-events-none" />

              {/* Icon */}
              <div className="relative mx-auto w-24 h-24 bg-gradient-to-br from-red-50 to-white dark:from-red-900/20 dark:to-white/5 rounded-[24px] shadow-sm border border-red-100/50 dark:border-white/5 flex items-center justify-center mb-8 ring-4 ring-white dark:ring-[#1e293b]">
                <svg
                  width="48"
                  height="48"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  className="text-red-500/90 dark:text-red-400"
                >
                  <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
                  <polyline points="14 2 14 8 20 8" />
                  <line x1="9" y1="15" x2="15" y2="15" className="opacity-50" />
                  <line
                    x1="12"
                    y1="15"
                    x2="12"
                    y2="15"
                    strokeWidth="8"
                    strokeLinecap="round"
                    className="text-red-500 opacity-20"
                  />
                  <path d="M9 15l6 0" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
                <div className="absolute -bottom-1 -right-1 w-8 h-8 bg-white dark:bg-[#1e293b] rounded-full flex items-center justify-center shadow-sm border border-gray-100 dark:border-white/10">
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="#ef4444"
                    strokeWidth="2.5"
                  >
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </div>
              </div>

              {/* Text Content */}
              <h3 className="text-2xl font-bold text-gray-900 dark:text-white mb-4 tracking-tight">
                Document Missing
              </h3>
              <p className="text-base leading-relaxed text-gray-500 dark:text-gray-400 mb-10">
                We verify the storage integrity of every document. The file for this record cannot
                be located in the storage bucket.
              </p>

              {/* Action */}
              <button
                type="button"
                onClick={() => setConfirmDelete(true)}
                className="group relative inline-flex items-center justify-center gap-2.5 px-8 py-3 w-full sm:w-auto rounded-xl bg-white dark:bg-white/5 border border-gray-200 dark:border-white/10 text-gray-700 dark:text-gray-200 text-sm font-semibold hover:border-red-300 dark:hover:border-red-800 hover:text-red-600 dark:hover:text-red-400 hover:shadow-sm transition-all duration-200"
              >
                <span className="w-1.5 h-1.5 rounded-full bg-red-500 group-hover:scale-125 transition-transform" />
                Delete Record
              </button>
            </div>
          ) : canPreview && viewUrl ? (
            isPdf ? (
              <iframe
                src={viewUrl}
                title={doc.displayTitle || doc.originalFilename}
                className="w-full h-full rounded-lg shadow-lg bg-white"
                style={{ minHeight: 500 }}
              />
            ) : (
              <img
                src={viewUrl}
                alt={doc.displayTitle || doc.originalFilename}
                className="max-w-full max-h-full object-contain rounded-lg shadow-lg"
              />
            )
          ) : (
            /* Non-viewable file placeholder */
            <div className="flex flex-col items-center gap-4 text-center">
              <FileTypeIcon fileType={doc.fileType} size={80} />
              <div>
                <p className="text-lg font-semibold text-[#1e293b] dark:text-white mb-1">
                  {doc.originalFilename}
                </p>
                <p className="text-sm text-[#94a3b8] dark:text-white/40 mb-4">
                  {formatFileSize(doc.fileSizeBytes)} • {doc.fileType.toUpperCase()} file
                </p>
                <button
                  type="button"
                  onClick={handleDownload}
                  disabled={!viewUrl}
                  className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-gradient-to-r from-[#10b981] to-[#059669] text-white text-sm font-medium shadow-sm hover:shadow-md transition-all disabled:opacity-50"
                >
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="7 10 12 15 17 10" />
                    <line x1="12" y1="15" x2="12" y2="3" />
                  </svg>
                  Download to View
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Right: Metadata Sidebar */}
        <div className="w-full md:w-80 border-l border-[#e2e8f0] dark:border-white/10 bg-white dark:bg-[#111827] overflow-y-auto">
          <div className="p-6">
            {/* Title */}
            <div className="mb-5">
              <label className="block text-[11px] font-semibold text-[#94a3b8] dark:text-white/40 uppercase tracking-wider mb-1.5">
                Title
              </label>
              {editingTitle ? (
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={titleDraft}
                    onChange={(e) => setTitleDraft(e.target.value)}
                    className="flex-1 px-3 py-2 rounded-lg border border-[#10b981]/40 bg-white dark:bg-[#0f172a] text-base sm:text-sm text-[#1e293b] dark:text-white focus:outline-none focus:ring-2 focus:ring-[#10b981]/20"
                    autoFocus
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleSaveTitle();
                      if (e.key === "Escape") setEditingTitle(false);
                    }}
                  />
                  <button
                    type="button"
                    onClick={handleSaveTitle}
                    className="px-3 py-2 rounded-lg bg-[#10b981] text-white text-xs font-medium"
                  >
                    Save
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    setTitleDraft(doc.displayTitle || doc.originalFilename);
                    setEditingTitle(true);
                  }}
                  className="w-full text-left text-sm font-medium text-[#1e293b] dark:text-white hover:text-[#10b981] transition-colors group"
                >
                  {doc.displayTitle || doc.originalFilename}
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    className="inline ml-2 opacity-0 group-hover:opacity-100 transition-opacity text-[#94a3b8]"
                  >
                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                  </svg>
                </button>
              )}
            </div>

            {/* Summary */}
            <div className="mb-6">
              <label className="block text-[11px] font-semibold text-[#94a3b8] dark:text-white/40 uppercase tracking-wider mb-1.5">
                Summary
              </label>
              {editingSummary ? (
                <div className="flex flex-col gap-2">
                  <textarea
                    value={summaryDraft}
                    onChange={(e) => setSummaryDraft(e.target.value)}
                    rows={3}
                    className="w-full px-3 py-2 rounded-lg border border-[#10b981]/40 bg-white dark:bg-[#0f172a] text-base sm:text-sm text-[#1e293b] dark:text-white resize-none focus:outline-none focus:ring-2 focus:ring-[#10b981]/20"
                    autoFocus
                    onKeyDown={(e) => {
                      if (e.key === "Escape") setEditingSummary(false);
                    }}
                  />
                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setEditingSummary(false)}
                      className="px-3 py-1.5 rounded-lg text-xs text-[#64748b] hover:bg-[#f1f5f9] dark:hover:bg-white/5"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={handleSaveSummary}
                      className="px-3 py-1.5 rounded-lg bg-[#10b981] text-white text-xs font-medium"
                    >
                      Save
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    setSummaryDraft(doc.summary || "");
                    setEditingSummary(true);
                  }}
                  className="w-full text-left text-sm text-[#64748b] dark:text-white/50 hover:text-[#10b981] transition-colors group min-h-[40px]"
                >
                  {doc.summary || (
                    <span className="italic text-[#94a3b8] dark:text-white/30">Add a summary…</span>
                  )}
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    className="inline ml-2 opacity-0 group-hover:opacity-100 transition-opacity text-[#94a3b8]"
                  >
                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                  </svg>
                </button>
              )}
            </div>

            {/* Divider */}
            <div className="border-t border-[#e2e8f0] dark:border-white/10 mb-5" />

            {/* Thumbnail */}
            <div className="mb-5">
              <h3 className="text-[11px] font-semibold text-[#94a3b8] dark:text-white/40 uppercase tracking-wider mb-3">
                Thumbnail
              </h3>
              {thumbnailUrl ? (
                <div className="mb-3">
                  <img
                    src={thumbnailUrl}
                    alt="Document thumbnail"
                    className="w-full h-32 object-cover rounded-lg border border-[#e2e8f0] dark:border-white/10"
                  />
                </div>
              ) : (
                <p className="text-sm text-[#94a3b8] dark:text-white/30 italic mb-3">
                  No thumbnail generated
                </p>
              )}
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => generateThumbnailMutation.mutate()}
                  disabled={generateThumbnailMutation.isPending || aiThumbnailMutation.isPending}
                  className="flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg border border-[#10b981]/30 text-sm font-medium text-[#10b981] hover:bg-[#10b981]/10 dark:hover:bg-[#10b981]/10 transition-colors disabled:opacity-50"
                >
                  {generateThumbnailMutation.isPending ? (
                    <>
                      <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                        <circle
                          className="opacity-25"
                          cx="12"
                          cy="12"
                          r="10"
                          stroke="currentColor"
                          strokeWidth="4"
                        />
                        <path
                          className="opacity-75"
                          fill="currentColor"
                          d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                        />
                      </svg>
                      Generating…
                    </>
                  ) : (
                    <>
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                      >
                        <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                        <circle cx="8.5" cy="8.5" r="1.5" />
                        <polyline points="21 15 16 10 5 21" />
                      </svg>
                      {thumbnailUrl ? "Regenerate" : "Generate"}
                    </>
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => aiThumbnailMutation.mutate()}
                  disabled={aiThumbnailMutation.isPending || generateThumbnailMutation.isPending}
                  title="Regenerate thumbnail using AI"
                  className="flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border border-[#8b5cf6]/30 text-sm font-medium text-[#8b5cf6] hover:bg-[#8b5cf6]/10 dark:hover:bg-[#8b5cf6]/10 transition-colors disabled:opacity-50"
                >
                  {aiThumbnailMutation.isPending ? (
                    <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                      <circle
                        className="opacity-25"
                        cx="12"
                        cy="12"
                        r="10"
                        stroke="currentColor"
                        strokeWidth="4"
                      />
                      <path
                        className="opacity-75"
                        fill="currentColor"
                        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                      />
                    </svg>
                  ) : (
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z" />
                    </svg>
                  )}
                  AI
                </button>
              </div>
              {(generateThumbnailMutation.isError || aiThumbnailMutation.isError) && (
                <p className="text-xs text-[#ef4444] mt-2">
                  {((generateThumbnailMutation.error || aiThumbnailMutation.error) as Error)
                    ?.message || "Failed to generate thumbnail"}
                </p>
              )}
            </div>

            {/* Divider */}
            <div className="border-t border-[#e2e8f0] dark:border-white/10 mb-5" />

            {/* File Info */}
            <div className="space-y-4">
              <h3 className="text-[11px] font-semibold text-[#94a3b8] dark:text-white/40 uppercase tracking-wider">
                File Info
              </h3>

              <div className="flex items-center justify-between">
                <span className="text-sm text-[#94a3b8] dark:text-white/40">File Name</span>
                <span
                  className="text-sm text-[#1e293b] dark:text-white font-medium truncate max-w-[160px]"
                  title={doc.originalFilename}
                >
                  {doc.originalFilename}
                </span>
              </div>

              <div className="flex items-center justify-between">
                <span className="text-sm text-[#94a3b8] dark:text-white/40">Type</span>
                <div className="flex items-center gap-2">
                  <FileTypeIcon fileType={doc.fileType} size={18} />
                  <span className="text-sm text-[#1e293b] dark:text-white font-medium">
                    {doc.fileType.toUpperCase()}
                  </span>
                </div>
              </div>

              <div className="flex items-center justify-between">
                <span className="text-sm text-[#94a3b8] dark:text-white/40">Document Type</span>
                <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-[#10b981]/10 text-[#10b981]">
                  {getDocumentTypeLabel(doc.documentType)}
                </span>
              </div>

              <div className="flex items-center justify-between">
                <span className="text-sm text-[#94a3b8] dark:text-white/40">Size</span>
                <span className="text-sm text-[#1e293b] dark:text-white font-medium">
                  {formatFileSize(doc.fileSizeBytes)}
                </span>
              </div>

              <div className="flex items-center justify-between">
                <span className="text-sm text-[#94a3b8] dark:text-white/40">Uploaded</span>
                <span className="text-sm text-[#1e293b] dark:text-white font-medium">
                  {formatDate(doc.createdAt)}
                </span>
              </div>
            </div>

            {/* Linked Objects */}
            <>
              <div className="border-t border-[#e2e8f0] dark:border-white/10 my-5" />
              <div>
                <h3 className="text-[11px] font-semibold text-[#94a3b8] dark:text-white/40 uppercase tracking-wider mb-3">
                  Linked Objects
                </h3>
                {attachments.length > 0 ? (
                  <div className="space-y-2">
                    {attachments.map((att) => {
                      const href = getLinkableHref(att.linkableType, att.linkableId, att.partyType);
                      return (
                        <div
                          key={att.id}
                          className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[#f8fafc] dark:bg-[#0f172a] border border-[#e2e8f0] dark:border-white/10 group"
                        >
                          <svg
                            width="14"
                            height="14"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="#10b981"
                            strokeWidth="2"
                          >
                            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                          </svg>
                          <Link
                            to={href}
                            className="flex-1 text-sm text-[#1e293b] dark:text-white hover:text-[#10b981] transition-colors no-underline"
                          >
                            {getLinkableLabel(att.linkableType)}
                          </Link>
                          {/* Unlink button */}
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setUnlinkTarget(att);
                            }}
                            title="Unlink this object"
                            className="w-6 h-6 rounded-md flex items-center justify-center text-[#94a3b8] hover:text-[#ef4444] hover:bg-red-50 dark:hover:bg-red-900/20 opacity-0 group-hover:opacity-100 transition-all cursor-pointer shrink-0"
                          >
                            <svg
                              width="12"
                              height="12"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            >
                              <path d="M18 6L6 18M6 6l12 12" />
                            </svg>
                          </button>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <p className="text-sm text-[#94a3b8] dark:text-white/30 italic">
                    No linked transactions
                  </p>
                )}
              </div>
            </>
            {/* AI Detected Fields (OCR Bounding Boxes) */}
            {canPreview && (
              <>
                <div className="border-t border-[#e2e8f0] dark:border-white/10 my-5" />
                <div>
                  <h3 className="text-[11px] font-semibold text-[#94a3b8] dark:text-white/40 uppercase tracking-wider mb-3">
                    AI Detected Fields
                  </h3>
                  {hasOcrData ? (
                    /* Has OCR data — show count + View button */
                    <>
                      <p className="text-xs text-[#64748b] dark:text-white/40 mb-3">
                        This document has {doc!.ocrBoundingBoxes?.length ?? 0} AI-detected field
                        {(doc!.ocrBoundingBoxes?.length ?? 0) === 1 ? "" : "s"}.
                      </p>
                      <button
                        type="button"
                        onClick={handleOpenViewer}
                        disabled={isLoadingViewer}
                        className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg border border-[#3b82f6]/30 text-sm font-medium text-[#3b82f6] hover:bg-[#3b82f6]/10 dark:hover:bg-[#3b82f6]/10 transition-colors disabled:opacity-50"
                      >
                        {isLoadingViewer ? (
                          <>
                            <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                              <circle
                                className="opacity-25"
                                cx="12"
                                cy="12"
                                r="10"
                                stroke="currentColor"
                                strokeWidth="4"
                              />
                              <path
                                className="opacity-75"
                                fill="currentColor"
                                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                              />
                            </svg>
                            Loading…
                          </>
                        ) : (
                          <>
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
                            View Detected Fields
                          </>
                        )}
                      </button>
                    </>
                  ) : (
                    /* No OCR data yet — show Scan button */
                    <>
                      <p className="text-xs text-[#64748b] dark:text-white/40 mb-3">
                        No AI-detected fields yet. Scan this document to extract fields like
                        amounts, dates, and vendor info.
                      </p>
                      <button
                        type="button"
                        onClick={() => scanFieldsMutation.mutate()}
                        disabled={scanFieldsMutation.isPending}
                        className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg border border-[#8b5cf6]/30 text-sm font-medium text-[#8b5cf6] hover:bg-[#8b5cf6]/10 dark:hover:bg-[#8b5cf6]/10 transition-colors disabled:opacity-50"
                      >
                        {scanFieldsMutation.isPending ? (
                          <>
                            <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                              <circle
                                className="opacity-25"
                                cx="12"
                                cy="12"
                                r="10"
                                stroke="currentColor"
                                strokeWidth="4"
                              />
                              <path
                                className="opacity-75"
                                fill="currentColor"
                                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                              />
                            </svg>
                            Scanning…
                          </>
                        ) : (
                          <>
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
                              <path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z" />
                            </svg>
                            Scan for Fields
                          </>
                        )}
                      </button>
                      {scanFieldsMutation.isError && (
                        <p className="text-xs text-[#ef4444] mt-2">
                          {(scanFieldsMutation.error as Error)?.message ||
                            "Failed to scan document"}
                        </p>
                      )}
                    </>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* ── Delete Confirmation ── */}
      <Modal
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title="Delete document?"
        mobile="center"
        size="sm"
        closeOnBackdrop={!deleteMutation.isPending}
        footer={
          <>
            <button
              type="button"
              onClick={() => setConfirmDelete(false)}
              className="h-11 px-4 rounded-lg text-sm font-medium text-[#64748b] hover:bg-[#f1f5f9] dark:text-white/60 dark:hover:bg-white/5 transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => deleteMutation.mutate()}
              disabled={deleteMutation.isPending}
              className="h-11 px-4 rounded-lg bg-[#ef4444] text-white text-sm font-medium hover:bg-[#dc2626] transition-colors disabled:opacity-50"
            >
              {deleteMutation.isPending ? "Deleting…" : "Delete"}
            </button>
          </>
        }
      >
        <p className="text-sm text-[#1e293b] dark:text-white">Delete this document permanently?</p>
      </Modal>

      {/* ── OCR Viewer Modal ── */}
      {viewerData && (
        <Modal
          open={viewerOpen}
          onClose={() => setViewerOpen(false)}
          title={`AI Detected Fields — ${doc.displayTitle || doc.originalFilename}`}
          mobile="fullscreen"
          size="full"
          bodyClassName="p-0"
        >
          {/* The viewer needs a definite height to lay out against. On mobile the modal panel is
              already 100dvh so `h-full` resolves; on desktop the panel is only max-height bounded,
              so the min-height is what gives the split its size. */}
          <div className="flex h-full min-h-[70dvh] flex-col overflow-hidden md:min-h-[75dvh] md:flex-row">
            {/* Document viewer */}
            <div className="flex-1 min-h-0 overflow-hidden">
              <InteractiveDocumentViewer
                imageUrl={viewerData.imageUrl}
                imageUrls={viewerData.imageUrls}
                documentUrl={viewerData.documentUrl}
                boundingBoxes={viewerData.boundingBoxes}
                totalPages={viewerData.pageCount}
                activeBox={activeBox}
              />
            </div>
            {/* Fields sidebar — stacks under the document below `md`, where a 288px column would
                leave the page itself unreadable. */}
            <div className="flex max-h-[45%] w-full shrink-0 flex-col border-t border-[#e2e8f0] bg-[#f8fafc] md:max-h-none md:w-72 md:border-t-0 md:border-l dark:border-white/10 dark:bg-[#0f172a]">
              <div className="px-4 py-3 border-b border-[#e2e8f0] dark:border-white/10">
                <h3 className="text-[11px] font-semibold text-[#94a3b8] dark:text-white/40 uppercase tracking-wider">
                  Detected Fields ({viewerData.boundingBoxes.length})
                </h3>
              </div>
              <div className="flex-1 overflow-y-auto">
                {viewerData.boundingBoxes.length > 0 ? (
                  <div className="py-1">
                    {viewerData.boundingBoxes.map((box, idx) => {
                      const boxFieldId =
                        box.fieldId ??
                        (box.lineIndex != null ? `line_${box.lineIndex}` : `field_${idx}`);
                      // Identify by list index, not by fieldId: this list is
                      // flat across every page, and a multi-page document
                      // legitimately repeats fieldIds (two `vendor_name`
                      // entries), which collides as a React key and makes
                      // "which one did I click" unanswerable.
                      const isActive = activeBoxIndex === idx;
                      const color = getFieldColorForViewer(box.fieldId);
                      return (
                        <button
                          key={`${box.page ?? 0}:${boxFieldId}:${idx}`}
                          type="button"
                          onClick={() => setActiveBoxIndex(isActive ? null : idx)}
                          className={`w-full min-h-11 text-left px-4 py-2.5 flex items-start gap-3 transition-colors cursor-pointer ${
                            isActive
                              ? "bg-[#3b82f6]/10 dark:bg-[#3b82f6]/10"
                              : "hover:bg-[#e2e8f0]/50 dark:hover:bg-white/5"
                          }`}
                        >
                          <div
                            className="w-2.5 h-2.5 rounded-full mt-1 shrink-0"
                            style={{ backgroundColor: color }}
                          />
                          <div className="flex-1 min-w-0">
                            <div className="text-[11px] font-medium text-[#94a3b8] dark:text-white/40 uppercase tracking-wider flex items-center gap-1.5">
                              <span className="truncate">
                                {getFriendlyFieldLabel(
                                  box.fieldId,
                                  box.label ?? `Row ${(box.lineIndex ?? idx) + 1}`,
                                )}
                              </span>
                              {/* Without this, a multi-page document shows
                                  the same label several times over with
                                  nothing to tell the entries apart. */}
                              {(viewerData.pageCount ?? 1) > 1 && (
                                <span className="shrink-0 rounded px-1 py-px text-[10px] font-normal bg-[#e2e8f0] text-[#64748b] dark:bg-white/10 dark:text-white/50">
                                  p{(box.page ?? 0) + 1}
                                </span>
                              )}
                            </div>
                            {box.text && (
                              <div className="text-sm text-[#1e293b] dark:text-white mt-0.5 truncate">
                                {box.text}
                              </div>
                            )}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <div className="px-4 py-6 text-center text-sm text-[#94a3b8] dark:text-white/30 italic">
                    No fields detected
                  </div>
                )}
              </div>
            </div>
          </div>
        </Modal>
      )}

      {/* ── Unlink Confirmation Modal ── */}
      {unlinkTarget && (
        <Modal
          open={!!unlinkTarget}
          onClose={() => setUnlinkTarget(null)}
          title={`Unlink ${getLinkableLabel(unlinkTarget.linkableType)}?`}
          mobile="center"
          size="sm"
          closeOnBackdrop={!unlinkMutation.isPending}
          footer={
            <>
              <button
                type="button"
                onClick={() => setUnlinkTarget(null)}
                className="h-11 px-4 rounded-lg text-sm font-medium text-[#64748b] hover:bg-[#f1f5f9] dark:text-white/60 dark:hover:bg-white/5 transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => unlinkMutation.mutate(unlinkTarget)}
                disabled={unlinkMutation.isPending}
                className="h-11 px-4 rounded-lg bg-[#ef4444] text-white text-sm font-medium hover:bg-[#dc2626] transition-colors disabled:opacity-50"
              >
                {unlinkMutation.isPending ? "Unlinking…" : "Unlink"}
              </button>
            </>
          }
        >
          <p className="text-sm text-[#64748b] dark:text-white/50">
            This will remove the link between this document and the{" "}
            {getLinkableLabel(unlinkTarget.linkableType).toLowerCase()}. The document itself will
            not be deleted.
          </p>
        </Modal>
      )}

      {/* Mobile Viewer Modal */}
      <Modal
        open={showMobileViewer}
        onClose={() => setShowMobileViewer(false)}
        title={doc.displayTitle || doc.originalFilename}
        mobile="fullscreen"
        size="full"
        bodyClassName="p-0"
      >
        <div className="flex h-full min-h-[70dvh] items-center justify-center overflow-auto bg-[#f1f5f9] p-4 dark:bg-[#0f172a]">
          {loadError ? (
            <div className="text-center p-8">
              <p className="text-red-500">Document failed to load.</p>
            </div>
          ) : canPreview && viewUrl ? (
            isPdf ? (
              <iframe
                src={viewUrl}
                title={doc.displayTitle || doc.originalFilename}
                className="w-full h-full rounded-lg shadow-lg bg-white"
                style={{ minHeight: "100%" }}
              />
            ) : isImage && viewerData ? (
              <div className="w-full h-full flex flex-col">
                <InteractiveDocumentViewer
                  imageUrl={viewerData.imageUrl}
                  imageUrls={viewerData.imageUrls}
                  documentUrl={viewerData.documentUrl}
                  boundingBoxes={viewerData.boundingBoxes}
                  totalPages={viewerData.pageCount}
                  activeBox={activeBox}
                />
              </div>
            ) : (
              <div className="w-full flex-col flex items-center justify-center">
                <img
                  src={viewUrl}
                  alt={doc.displayTitle || doc.originalFilename}
                  className="max-w-full max-h-full object-contain"
                />
              </div>
            )
          ) : (
            <div className="text-center text-gray-500 dark:text-gray-400">
              <FileTypeIcon fileType={doc.fileType} size={64} />
              <p className="mt-4">Preview not available on mobile.</p>
              <button
                onClick={handleDownload}
                className="mt-4 min-h-11 px-4 text-emerald-500 font-medium"
              >
                Download File
              </button>
            </div>
          )}
        </div>
      </Modal>
    </div>
  );
}
