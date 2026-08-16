/**
 * DocumentPickerModal — Browse and attach existing documents
 * without re-uploading. Searchable list with one-click attach.
 */
import { useState, useEffect, useCallback } from "react";
import type { StagedDocument } from "../transactions/AttachmentsPanel";
import { FileTypeIcon, formatFileSize } from "./DocumentUploadModal";
import { Modal } from "../ui/Modal";

interface DocumentPickerModalProps {
  open: boolean;
  onClose: () => void;
  /** Already-staged document IDs to exclude from the list */
  excludeDocumentIds: string[];
  /** Called with selected documents */
  onAttach: (docs: StagedDocument[]) => void;
}

interface DocumentRow {
  id: string;
  originalFilename: string;
  displayTitle: string | null;
  fileType: string;
  fileSizeBytes: number | null;
  mimeType: string | null;
  createdAt: Date;
  ocrBoundingBoxes?: unknown[] | null;
}

export default function DocumentPickerModal({
  open,
  onClose,
  excludeDocumentIds,
  onAttach,
}: DocumentPickerModalProps) {
  const [search, setSearch] = useState("");
  const [documents, setDocuments] = useState<DocumentRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Fetch documents on open / search change
  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    const fetchDocs = async () => {
      setLoading(true);
      try {
        const { listDocuments } = await import("../../routes/api/-documents");
        const result = await listDocuments({
          data: { search: search || undefined },
        });
        if (!cancelled) {
          setDocuments(result.documents);
        }
      } catch {
        // Silently fail — user can retry by typing
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    const debounce = setTimeout(fetchDocs, search ? 300 : 0);
    return () => {
      cancelled = true;
      clearTimeout(debounce);
    };
  }, [open, search]);

  // Reset selection when modal opens
  useEffect(() => {
    if (open) setSelectedIds(new Set());
  }, [open]);

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleAttach = useCallback(() => {
    const selected = documents
      .filter((d) => selectedIds.has(d.id))
      .map(
        (d): StagedDocument => ({
          documentId: d.id,
          filename: d.originalFilename,
          contentType: d.mimeType || "",
          fileSizeBytes: d.fileSizeBytes || 0,
          hasOcrData: Array.isArray(d.ocrBoundingBoxes) && d.ocrBoundingBoxes.length > 0,
        }),
      );
    onAttach(selected);
    onClose();
  }, [documents, selectedIds, onAttach, onClose]);

  const filteredDocs = documents.filter((d) => !excludeDocumentIds.includes(d.id));

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Browse Documents"
      mobile="sheet"
      size="md"
      bodyClassName="px-2 py-0"
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="h-11 px-4 rounded-lg text-sm font-medium text-[#64748b] dark:text-white/50 hover:bg-[#f1f5f9] dark:hover:bg-white/5 transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleAttach}
            disabled={selectedIds.size === 0}
            className="h-11 px-4 rounded-lg bg-gradient-to-r from-[#10b981] to-[#059669] text-white text-sm font-medium shadow-sm hover:shadow-md transition-all disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Attach ({selectedIds.size})
          </button>
        </>
      }
    >
      {/* Search — sticky so the list scrolls under it rather than pushing it away. */}
      <div className="sticky top-0 z-10 bg-white dark:bg-slate-900 px-3 pt-3 pb-2">
        <div className="relative">
          <svg
            className="absolute left-3 top-1/2 -translate-y-1/2 text-[#94a3b8]"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search documents..."
            className="w-full h-11 pl-9 pr-3 rounded-lg border border-[#e2e8f0] dark:border-white/10 bg-white dark:bg-[#0f172a] text-base sm:text-sm text-[#1e293b] dark:text-white placeholder:text-[#94a3b8] focus:outline-none focus:ring-2 focus:ring-[#10b981]/20 focus:border-[#10b981]"
            autoFocus
          />
        </div>
        <p className="mt-2 text-xs text-[#94a3b8] dark:text-white/40">
          {selectedIds.size > 0 ? `${selectedIds.size} selected` : "Select documents to attach"}
        </p>
      </div>

      {/* Document list */}
      <div className="pb-2">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="w-6 h-6 rounded-full border-2 border-[#e2e8f0] dark:border-white/10 border-t-[#10b981] animate-spin" />
          </div>
        ) : filteredDocs.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <p className="text-sm text-[#94a3b8] dark:text-white/40">
              {search ? "No documents match your search" : "No documents found"}
            </p>
          </div>
        ) : (
          filteredDocs.map((doc) => {
            const isSelected = selectedIds.has(doc.id);
            return (
              <button
                type="button"
                key={doc.id}
                onClick={() => toggleSelect(doc.id)}
                className={`w-full min-h-12 flex items-center gap-3 px-3 py-3 rounded-lg text-left transition-all cursor-pointer ${
                  isSelected
                    ? "bg-[#10b981]/10 border border-[#10b981]/30"
                    : "hover:bg-[#f8fafc] dark:hover:bg-white/5 border border-transparent"
                }`}
              >
                {/* Checkbox */}
                <div
                  className={`w-5 h-5 rounded border-2 flex items-center justify-center shrink-0 transition-colors ${
                    isSelected
                      ? "border-[#10b981] bg-[#10b981]"
                      : "border-[#cbd5e1] dark:border-white/20"
                  }`}
                >
                  {isSelected && (
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="white"
                      strokeWidth="3"
                    >
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  )}
                </div>

                {/* File icon */}
                <FileTypeIcon fileType={doc.fileType} size={28} />

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-[#1e293b] dark:text-white truncate">
                    {doc.displayTitle || doc.originalFilename}
                  </p>
                  <p className="text-xs text-[#94a3b8] dark:text-white/40">
                    {formatFileSize(doc.fileSizeBytes)} ·{" "}
                    {new Date(doc.createdAt).toLocaleDateString()}
                  </p>
                </div>

                {/* OCR indicator */}
                {Array.isArray(doc.ocrBoundingBoxes) && doc.ocrBoundingBoxes.length > 0 && (
                  <div
                    className="flex items-center justify-center w-5 h-5 rounded-full bg-[#3b82f6]/10 shrink-0"
                    title="Document has AI-detected field data"
                  >
                    <svg
                      width="10"
                      height="10"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="#3b82f6"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                      <circle cx="12" cy="12" r="3" />
                    </svg>
                  </div>
                )}
              </button>
            );
          })
        )}
      </div>
    </Modal>
  );
}
