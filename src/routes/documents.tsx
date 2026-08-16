/**
 * Documents Page — Grid/List view with search, filter, sort & upload
 */
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery, keepPreviousData, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, useMemo } from "react";
import {
  listDocuments,
  getDocumentThumbnailUrl,
  deleteDocument,
  getDocumentUrl,
} from "./api/-documents";
import { DocumentUploadModal } from "../components/documents/DocumentUploadModal";
import { FileTypeIcon, getDocumentTypeLabel } from "../components/documents/DocumentUploadModal";
import { useToast } from "../components/ui/Toast";
import { FilterBar } from "../components/ui/Actions";
import { RowActionsMenu } from "../components/ui/DataTable";
import { useIsMobile } from "../hooks/useBreakpoint";
import { createLogger } from "../lib/logger";
import { callServerFn } from "../lib/server-fn-client";
const logger = createLogger("ui.documents");

// ============================================================================
// Types
// ============================================================================

interface DocumentRecord {
  id: string;
  originalFilename: string;
  displayTitle: string | null;
  documentType: string;
  fileType: string;
  fileSizeBytes: number | null;
  mimeType: string | null;
  thumbnailR2Key: string | null;
  uploadedById: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
  uploaderName?: string | null;
  uploaderImage?: string | null;
}

type ListDocumentsInput = NonNullable<Parameters<typeof listDocuments>[0]>["data"];
type DocumentTypeFilter = Exclude<ListDocumentsInput["documentType"], undefined>;
type FileTypeFilter = Exclude<ListDocumentsInput["fileType"], undefined>;

// ============================================================================
// Route
// ============================================================================

interface DocumentsSearch {
  view?: "grid" | "list";
  search?: string;
  documentType?: string;
  fileType?: string;
  sort?: string;
  order?: "asc" | "desc";
}

export const Route = createFileRoute("/documents")({
  component: DocumentsPage,
  validateSearch(search: Record<string, unknown>): DocumentsSearch {
    return {
      view: (search.view as "grid" | "list") || undefined,
      search: (search.search as string) || undefined,
      documentType: (search.documentType as string) || undefined,
      fileType: (search.fileType as string) || undefined,
      sort: (search.sort as string) || undefined,
      order: (search.order as "asc" | "desc") || undefined,
    };
  },
});

// ============================================================================
// Constants
// ============================================================================

const DOCUMENT_TYPES = [
  { value: "", label: "All Types" },
  { value: "statement", label: "Statement" },
  { value: "bill", label: "Bill" },
  { value: "invoice", label: "Invoice" },
  { value: "receipt", label: "Receipt" },
  { value: "contract", label: "Contract" },
  { value: "tax_form", label: "Tax Form" },
  { value: "other", label: "Other" },
] as const satisfies ReadonlyArray<{ value: "" | DocumentTypeFilter; label: string }>;

const FILE_TYPES = [
  { value: "", label: "All Files" },
  { value: "pdf", label: "PDF" },
  { value: "csv", label: "CSV" },
  { value: "xlsx", label: "Excel" },
  { value: "doc", label: "Word" },
  { value: "image", label: "Image" },
  { value: "zip", label: "ZIP" },
  { value: "other", label: "Other" },
] as const satisfies ReadonlyArray<{ value: "" | FileTypeFilter; label: string }>;

const SORT_OPTIONS = [
  { key: "createdAt", label: "Upload Date" },
  { key: "originalFilename", label: "File Name" },
] as const satisfies ReadonlyArray<{ key: SortKey; label: string }>;

type SortKey = "createdAt" | "originalFilename";
type SortOrder = "asc" | "desc";

function parseDocumentTypeFilter(value: string): "" | DocumentTypeFilter {
  return DOCUMENT_TYPES.some((option) => option.value === value)
    ? (value as "" | DocumentTypeFilter)
    : "";
}

function parseFileTypeFilter(value: string): "" | FileTypeFilter {
  return FILE_TYPES.some((option) => option.value === value) ? (value as "" | FileTypeFilter) : "";
}

// ============================================================================
// Page Component
// ============================================================================

function DocumentsPage() {
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const [uploadOpen, setUploadOpen] = useState(false);
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  const [searchQuery, setSearchQuery] = useState("");
  const [filterOpen, setFilterOpen] = useState(false);
  const [sortOpen, setSortOpen] = useState(false);
  const [docTypeFilter, setDocTypeFilter] = useState<DocumentTypeFilter | "">("");
  const [fileTypeFilter, setFileTypeFilter] = useState<FileTypeFilter | "">("");
  const [sortBy, setSortBy] = useState<SortKey>("createdAt");
  const [sortOrder, setSortOrder] = useState<SortOrder>("desc");

  // Fetch documents
  const { data, isPending } = useQuery({
    queryKey: ["documents", docTypeFilter, fileTypeFilter, sortBy, sortOrder],
    queryFn: () =>
      callServerFn(listDocuments, {
        data: {
          documentType: docTypeFilter || undefined,
          fileType: fileTypeFilter || undefined,
          sortBy,
          sortOrder,
        },
      }),
    staleTime: Number.POSITIVE_INFINITY,
    placeholderData: keepPreviousData,
  });

  const documents = data?.documents ?? [];

  // Client-side search filter
  const filtered = useMemo(() => {
    if (!searchQuery.trim()) return documents;
    const q = searchQuery.toLowerCase();
    return documents.filter(
      (d) =>
        d.originalFilename.toLowerCase().includes(q) ||
        (d.displayTitle && d.displayTitle.toLowerCase().includes(q)),
    );
  }, [documents, searchQuery]);

  function formatDate(dateStr: Date | string): string {
    const d = new Date(dateStr);
    return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
  }

  function handleDocClick(docId: string) {
    navigate({ to: `/documents/${docId}` });
  }

  const activeFilters = (docTypeFilter ? 1 : 0) + (fileTypeFilter ? 1 : 0);

  function toggleSort(key: SortKey) {
    if (sortBy === key) setSortOrder(sortOrder === "desc" ? "asc" : "desc");
    else {
      setSortBy(key);
      setSortOrder("desc");
    }
  }

  function clearFilters() {
    setDocTypeFilter("");
    setFileTypeFilter("");
  }

  const { showToast } = useToast();
  const queryClient = useQueryClient();

  const deleteMutation = useMutation({
    mutationFn: (documentId: string) => callServerFn(deleteDocument, { data: { documentId } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["documents"] });
      showToast("Document deleted", { icon: "success" });
    },
    onError: (err: unknown) => {
      const message = err instanceof Error ? err.message : "Failed to delete document";
      showToast(message, { icon: "error" });
    },
  });

  // Search and the view toggle are the two controls that stay visible at every width, so they are
  // authored once and placed by whichever toolbar (mobile or desktop) is mounted.
  const searchField = (
    <div className="flex-1 relative min-w-0">
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        className="absolute left-3 top-1/2 -translate-y-1/2 text-[#94a3b8] dark:text-white/30"
      >
        <circle cx="11" cy="11" r="8" />
        <path d="M21 21l-4.35-4.35" />
      </svg>
      <input
        type="text"
        value={searchQuery}
        onChange={(e) => setSearchQuery(e.target.value)}
        placeholder={`Filter ${filtered.length} document${filtered.length !== 1 ? "s" : ""}…`}
        className="w-full h-11 pl-10 pr-4 rounded-lg border border-[#e2e8f0] dark:border-white/10 bg-white dark:bg-[#111827] text-base md:text-sm text-[#1e293b] dark:text-white placeholder:text-[#94a3b8] dark:placeholder:text-white/30 focus:outline-none focus:ring-2 focus:ring-[#10b981]/20 focus:border-[#10b981] transition-all"
      />
    </div>
  );

  const viewToggle = (
    <div className="flex shrink-0 items-center rounded-lg border border-[#e2e8f0] dark:border-white/10 overflow-hidden">
      <button
        type="button"
        onClick={() => setViewMode("grid")}
        aria-label="Grid view"
        aria-pressed={viewMode === "grid"}
        className={`flex h-11 w-11 items-center justify-center transition-colors ${
          viewMode === "grid"
            ? "bg-[#10b981]/10 text-[#10b981]"
            : "text-[#94a3b8] dark:text-white/30 hover:text-[#64748b] dark:hover:text-white/50"
        }`}
        title="Grid view"
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <rect x="3" y="3" width="7" height="7" />
          <rect x="14" y="3" width="7" height="7" />
          <rect x="14" y="14" width="7" height="7" />
          <rect x="3" y="14" width="7" height="7" />
        </svg>
      </button>
      <button
        type="button"
        onClick={() => setViewMode("list")}
        aria-label="List view"
        aria-pressed={viewMode === "list"}
        className={`flex h-11 w-11 items-center justify-center transition-colors ${
          viewMode === "list"
            ? "bg-[#10b981]/10 text-[#10b981]"
            : "text-[#94a3b8] dark:text-white/30 hover:text-[#64748b] dark:hover:text-white/50"
        }`}
        title="List view"
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <line x1="8" y1="6" x2="21" y2="6" />
          <line x1="8" y1="12" x2="21" y2="12" />
          <line x1="8" y1="18" x2="21" y2="18" />
          <line x1="3" y1="6" x2="3.01" y2="6" />
          <line x1="3" y1="12" x2="3.01" y2="12" />
          <line x1="3" y1="18" x2="3.01" y2="18" />
        </svg>
      </button>
    </div>
  );

  // Below `md` the two dropdowns and the sort menu cannot share a row with search, so they move
  // into the FilterBar sheet. Sort lives here too — a 26px popover row is not a tap target.
  const filterFields = (
    <>
      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-semibold uppercase tracking-wider text-[#94a3b8] dark:text-white/40">
          Document Type
        </span>
        <select
          value={docTypeFilter}
          onChange={(e) => setDocTypeFilter(parseDocumentTypeFilter(e.target.value))}
          className="h-11 w-full px-3 rounded-lg border border-[#e2e8f0] dark:border-white/10 bg-white dark:bg-[#0f172a] text-base text-[#1e293b] dark:text-white focus:outline-none focus:ring-2 focus:ring-[#10b981]/20"
        >
          {DOCUMENT_TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-semibold uppercase tracking-wider text-[#94a3b8] dark:text-white/40">
          File Type
        </span>
        <select
          value={fileTypeFilter}
          onChange={(e) => setFileTypeFilter(parseFileTypeFilter(e.target.value))}
          className="h-11 w-full px-3 rounded-lg border border-[#e2e8f0] dark:border-white/10 bg-white dark:bg-[#0f172a] text-base text-[#1e293b] dark:text-white focus:outline-none focus:ring-2 focus:ring-[#10b981]/20"
        >
          {FILE_TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
      </label>

      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-[#94a3b8] dark:text-white/40">
          Sort By
        </legend>
        {SORT_OPTIONS.map((opt) => (
          <button
            key={opt.key}
            type="button"
            onClick={() => toggleSort(opt.key)}
            aria-pressed={sortBy === opt.key}
            className={`flex min-h-12 w-full items-center justify-between rounded-lg px-3 text-left text-sm font-medium transition-colors ${
              sortBy === opt.key
                ? "bg-[#10b981]/10 text-[#1e293b] dark:text-white"
                : "text-[#64748b] dark:text-white/50"
            }`}
          >
            {opt.label}
            {sortBy === opt.key && (
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="#10b981"
                strokeWidth="2.5"
              >
                {sortOrder === "desc" ? (
                  <path d="M12 5v14M5 12l7 7 7-7" />
                ) : (
                  <path d="M12 19V5M5 12l7-7 7 7" />
                )}
              </svg>
            )}
          </button>
        ))}
      </fieldset>

      {activeFilters > 0 && (
        <button
          type="button"
          onClick={clearFilters}
          className="min-h-11 w-full rounded-lg text-sm font-semibold text-[#10b981]"
        >
          Clear Filters
        </button>
      )}
    </>
  );

  return (
    <>
      <div className="flex flex-col h-full bg-[#fafbfc] dark:bg-[#0c1322]">
        {/* ── Header ── */}
        <div className="flex items-center justify-between gap-3 px-4 py-4 md:px-8 md:py-5 border-b border-[#e2e8f0] dark:border-white/10">
          <div className="flex min-w-0 items-center gap-3">
            <svg
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="shrink-0 text-[#10b981]"
            >
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
            <h1 className="truncate text-lg sm:text-xl font-semibold text-[#1e293b] dark:text-white">
              Documents
            </h1>
          </div>
          {/* Label collapses to the icon below `sm` — a two-word button cannot share 375px with
              the title without wrapping. */}
          <button
            type="button"
            aria-label="Upload Document"
            title="Upload Document"
            className="flex shrink-0 items-center justify-center gap-2 h-11 w-11 px-0 sm:h-auto sm:w-auto sm:px-5 sm:py-2.5 rounded-lg bg-gradient-to-r from-[#10b981] to-[#059669] text-white text-sm font-medium shadow-sm hover:shadow-md transition-all"
            onClick={() => setUploadOpen(true)}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="shrink-0"
            >
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
            <span className="hidden sm:inline">Upload Document</span>
          </button>
        </div>

        {/* ── Toolbar ── */}
        {isMobile ? (
          <div className="flex flex-col gap-2 px-4 py-3 border-b border-[#e2e8f0] dark:border-white/10">
            {searchField}
            <FilterBar activeCount={activeFilters} trailing={viewToggle}>
              {filterFields}
            </FilterBar>
          </div>
        ) : (
          <div className="flex items-center gap-3 px-8 py-3 border-b border-[#e2e8f0] dark:border-white/10">
            {searchField}
            {viewToggle}

            {/* Filter */}
            <div className="relative">
              <button
                type="button"
                onClick={() => {
                  setFilterOpen(!filterOpen);
                  setSortOpen(false);
                }}
                aria-label="Filter"
                aria-expanded={filterOpen}
                className={`relative flex h-11 w-11 items-center justify-center rounded-lg border transition-colors ${
                  activeFilters > 0
                    ? "border-[#10b981]/40 text-[#10b981] bg-[#10b981]/5"
                    : "border-[#e2e8f0] dark:border-white/10 text-[#94a3b8] dark:text-white/30 hover:text-[#64748b] dark:hover:text-white/50"
                }`}
                title="Filter"
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
                </svg>
                {activeFilters > 0 && (
                  <span className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-[#10b981] text-white text-[9px] font-bold flex items-center justify-center">
                    {activeFilters}
                  </span>
                )}
              </button>

              {filterOpen && (
                <>
                  <div
                    className="fixed inset-0 z-10"
                    onClick={() => setFilterOpen(false)}
                    onKeyDown={() => {}}
                    role="presentation"
                  />
                  <div className="absolute right-0 top-full mt-2 w-64 bg-white dark:bg-[#1e293b] rounded-xl border border-[#e2e8f0] dark:border-white/10 shadow-xl z-20 py-3 px-4">
                    <p className="text-[11px] font-semibold text-[#94a3b8] dark:text-white/40 uppercase tracking-wider mb-2">
                      Document Type
                    </p>
                    <select
                      value={docTypeFilter}
                      onChange={(e) => setDocTypeFilter(parseDocumentTypeFilter(e.target.value))}
                      className="w-full px-3 py-2 rounded-lg border border-[#e2e8f0] dark:border-white/10 bg-white dark:bg-[#0f172a] text-base md:text-sm text-[#1e293b] dark:text-white mb-3 focus:outline-none focus:ring-2 focus:ring-[#10b981]/20"
                    >
                      {DOCUMENT_TYPES.map((t) => (
                        <option key={t.value} value={t.value}>
                          {t.label}
                        </option>
                      ))}
                    </select>

                    <p className="text-[11px] font-semibold text-[#94a3b8] dark:text-white/40 uppercase tracking-wider mb-2">
                      File Type
                    </p>
                    <select
                      value={fileTypeFilter}
                      onChange={(e) => setFileTypeFilter(parseFileTypeFilter(e.target.value))}
                      className="w-full px-3 py-2 rounded-lg border border-[#e2e8f0] dark:border-white/10 bg-white dark:bg-[#0f172a] text-base md:text-sm text-[#1e293b] dark:text-white mb-3 focus:outline-none focus:ring-2 focus:ring-[#10b981]/20"
                    >
                      {FILE_TYPES.map((t) => (
                        <option key={t.value} value={t.value}>
                          {t.label}
                        </option>
                      ))}
                    </select>

                    {activeFilters > 0 && (
                      <button
                        type="button"
                        onClick={clearFilters}
                        className="w-full text-center text-xs text-[#10b981] font-medium py-1.5 hover:underline"
                      >
                        Clear Filters
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>

            {/* Sort */}
            <div className="relative">
              <button
                type="button"
                onClick={() => {
                  setSortOpen(!sortOpen);
                  setFilterOpen(false);
                }}
                aria-label="Sort"
                aria-expanded={sortOpen}
                className="flex h-11 w-11 items-center justify-center rounded-lg border border-[#e2e8f0] dark:border-white/10 text-[#94a3b8] dark:text-white/30 hover:text-[#64748b] dark:hover:text-white/50 transition-colors"
                title="Sort"
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M11 5h10M11 9h7M11 13h4M3 17l3 3 3-3M6 18V4" />
                </svg>
              </button>

              {sortOpen && (
                <>
                  <div
                    className="fixed inset-0 z-10"
                    onClick={() => setSortOpen(false)}
                    onKeyDown={() => {}}
                    role="presentation"
                  />
                  <div className="absolute right-0 top-full mt-2 w-52 bg-white dark:bg-[#1e293b] rounded-xl border border-[#e2e8f0] dark:border-white/10 shadow-xl z-20 py-1">
                    <p className="px-3 py-1.5 text-[10px] font-semibold text-[#94a3b8] dark:text-white/40 uppercase tracking-wider">
                      Sort By
                    </p>
                    {SORT_OPTIONS.map((opt) => (
                      <button
                        key={opt.key}
                        type="button"
                        onClick={() => toggleSort(opt.key)}
                        className={`w-full text-left px-3 py-2 text-sm flex items-center justify-between transition-colors ${
                          sortBy === opt.key
                            ? "text-[#1e293b] dark:text-white font-medium bg-[#f8fafc] dark:bg-white/5"
                            : "text-[#64748b] dark:text-white/50 hover:bg-[#f8fafc] dark:hover:bg-white/5"
                        }`}
                      >
                        {opt.label}
                        {sortBy === opt.key && (
                          <svg
                            width="14"
                            height="14"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="#10b981"
                            strokeWidth="2.5"
                          >
                            {sortOrder === "desc" ? (
                              <path d="M12 5v14M5 12l7 7 7-7" />
                            ) : (
                              <path d="M12 19V5M5 12l7-7 7 7" />
                            )}
                          </svg>
                        )}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        {/* ── Content ── */}
        <div className="flex-1 overflow-y-auto px-4 py-4 md:px-8 md:py-6">
          {isPending ? (
            viewMode === "grid" ? (
              <GridSkeleton />
            ) : (
              <ListSkeleton />
            )
          ) : filtered.length === 0 ? (
            <EmptyState onUpload={() => setUploadOpen(true)} />
          ) : viewMode === "grid" ? (
            /* ── Grid View ── */
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3 md:gap-5">
              {filtered.map((doc) => (
                <DocumentCard
                  key={doc.id}
                  doc={doc}
                  onClick={() => handleDocClick(doc.id)}
                  formatDate={formatDate}
                />
              ))}
            </div>
          ) : (
            /* ── List View ── */
            <div className="rounded-xl border border-[#e2e8f0] dark:border-white/10 overflow-hidden bg-white dark:bg-[#111827]">
              {/* Table header */}
              {/* Table header - Hidden on mobile */}
              <div className="hidden md:grid grid-cols-[1fr_140px_140px_160px_80px] items-center px-5 py-3 border-b border-[#e2e8f0] dark:border-white/10 bg-[#f8fafc] dark:bg-[#0f172a]">
                <span className="text-[11px] font-semibold text-[#94a3b8] dark:text-white/40 uppercase tracking-wider">
                  Document Name
                </span>
                <span className="text-[11px] font-semibold text-[#94a3b8] dark:text-white/40 uppercase tracking-wider">
                  Document Type
                </span>
                <span className="text-[11px] font-semibold text-[#94a3b8] dark:text-white/40 uppercase tracking-wider">
                  Uploaded By
                </span>
                <span className="text-[11px] font-semibold text-[#94a3b8] dark:text-white/40 uppercase tracking-wider text-right">
                  Uploaded On
                </span>
                <span />
              </div>

              {/* Table rows */}
              {filtered.map((doc) => (
                <DocumentRow
                  key={doc.id}
                  doc={doc}
                  onClick={() => handleDocClick(doc.id)}
                  formatDate={formatDate}
                  onDelete={(id) => deleteMutation.mutate(id)}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      <DocumentUploadModal open={uploadOpen} onClose={() => setUploadOpen(false)} />
    </>
  );
}

// ============================================================================
// Document Card (Grid View)
// ============================================================================

function DocumentCard({
  doc,
  onClick,
  formatDate,
}: {
  doc: DocumentRecord;
  onClick: () => void;
  formatDate: (d: Date | string) => string;
}) {
  const isImage = ["jpg", "jpeg", "png", "gif", "webp"].includes(doc.fileType);
  const isPdf = doc.fileType === "pdf";

  // Fetch thumbnail URL when thumbnailR2Key is available
  const { data: thumbData } = useQuery({
    queryKey: ["documentThumbnail", doc.id],
    queryFn: () => callServerFn(getDocumentThumbnailUrl, { data: { documentId: doc.id } }),
    enabled: !!doc.thumbnailR2Key,
    staleTime: 5 * 60 * 1000, // 5 min cache
  });
  const thumbUrl = thumbData?.url ?? null;

  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex flex-col rounded-xl border border-[#e2e8f0] dark:border-white/10 bg-white dark:bg-[#111827] overflow-hidden hover:shadow-lg hover:border-[#a7f3d0] dark:hover:border-[#10b981]/30 transition-all cursor-pointer text-left w-full"
    >
      {/* Thumbnail area */}
      <div className="w-full aspect-[4/3] bg-[#f1f5f9] dark:bg-[#0f172a] flex items-center justify-center overflow-hidden relative">
        {thumbUrl ? (
          <img
            src={thumbUrl}
            alt={doc.displayTitle || doc.originalFilename}
            className="w-full h-full object-cover"
          />
        ) : isPdf ? (
          <div className="flex flex-col items-center gap-2">
            <FileTypeIcon fileType="pdf" size={48} />
            <span className="text-xs text-[#94a3b8] dark:text-white/30">PDF Document</span>
          </div>
        ) : isImage ? (
          <div className="flex flex-col items-center gap-2">
            <FileTypeIcon fileType={doc.fileType} size={48} />
            <span className="text-xs text-[#94a3b8] dark:text-white/30">Image</span>
          </div>
        ) : (
          <FileTypeIcon fileType={doc.fileType} size={56} />
        )}
      </div>

      {/* Info */}
      <div className="flex items-start gap-2 px-3 py-3">
        <FileTypeIcon fileType={doc.fileType} size={24} />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-[#1e293b] dark:text-white truncate leading-tight">
            {doc.displayTitle || doc.originalFilename}
          </p>
          <p className="text-xs text-[#94a3b8] dark:text-white/40 mt-0.5">
            Uploaded {formatDate(String(doc.createdAt))}
          </p>
        </div>
      </div>
    </button>
  );
}

// ============================================================================
// Document Row (List View)
// ============================================================================

function DocumentRow({
  doc,
  onClick,
  formatDate,
  onDelete,
}: {
  doc: DocumentRecord;
  onClick: () => void;
  formatDate: (d: Date | string) => string;
  onDelete: (id: string) => void;
}) {
  // Fetch thumbnail URL when thumbnailR2Key is available
  const { data: thumbData } = useQuery({
    queryKey: ["documentThumbnail", doc.id],
    queryFn: () => callServerFn(getDocumentThumbnailUrl, { data: { documentId: doc.id } }),
    enabled: !!doc.thumbnailR2Key,
    staleTime: 5 * 60 * 1000, // 5 min cache
  });
  const thumbUrl = thumbData?.url ?? null;

  const handleDownload = async () => {
    try {
      const { url } = await callServerFn(getDocumentUrl, { data: { documentId: doc.id } });
      if (url) {
        const link = document.createElement("a");
        link.href = url;
        link.download = doc.originalFilename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
      }
    } catch (error) {
      logger.error("Failed to download document", { error });
    }
  };

  const typeChip = (
    <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-800 dark:bg-white/10 dark:text-gray-300">
      {getDocumentTypeLabel(doc.documentType)}
    </span>
  );

  return (
    <div
      className="flex items-center gap-3 px-4 py-3 md:grid md:grid-cols-[1fr_140px_140px_160px_80px] md:items-center md:gap-0 md:px-5 md:py-3.5 border-b last:border-b-0 border-[#e2e8f0] dark:border-white/10 hover:bg-[#f8fafc] dark:hover:bg-white/[0.02] transition-colors cursor-pointer"
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter") onClick();
      }}
      role="button"
      tabIndex={0}
    >
      {/* Identity — the only column that survives below `md`. The three columns that drop out
          reappear here as a secondary line plus the type chip, so nothing becomes unreachable. */}
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center">
          {thumbUrl ? (
            <div className="w-8 h-8 rounded overflow-hidden bg-gray-50 border border-gray-200 dark:border-white/10 dark:bg-white/5">
              <img src={thumbUrl} alt="" className="w-full h-full object-cover" />
            </div>
          ) : (
            <FileTypeIcon fileType={doc.fileType} size={28} />
          )}
        </div>

        <div className="flex min-w-0 flex-col">
          <span className="truncate text-sm font-medium text-[#1e293b] dark:text-white">
            {doc.displayTitle || doc.originalFilename}
          </span>
          <span className="mt-0.5 truncate text-xs text-[#64748b] dark:text-white/50 md:hidden">
            {formatDate(String(doc.createdAt))} · {doc.uploaderName || "User"}
          </span>
          <div className="mt-1.5 md:hidden">{typeChip}</div>
        </div>
      </div>

      {/* Document Type */}
      <div className="hidden md:block">{typeChip}</div>

      {/* Uploaded By */}
      <div
        className="hidden md:flex items-center gap-2"
        title={`Uploaded by ${doc.uploaderName || "User"}`}
      >
        {doc.uploaderImage ? (
          <img
            src={doc.uploaderImage}
            alt={doc.uploaderName || "User"}
            className="w-6 h-6 rounded-full object-cover"
          />
        ) : (
          <div className="w-6 h-6 rounded-full bg-[#10b981]/20 flex items-center justify-center text-[10px] font-bold text-[#10b981] shrink-0">
            {(doc.uploaderName?.[0] || "U").toUpperCase()}
          </div>
        )}
        <span className="text-sm text-[#64748b] dark:text-white/50 truncate max-w-[120px]">
          {doc.uploaderName || "User"}
        </span>
      </div>

      {/* Uploaded On */}
      <span className="hidden md:block text-sm text-[#64748b] dark:text-white/50 text-right">
        {formatDate(String(doc.createdAt))}
      </span>

      {/* Actions — one overflow control at every width: a popover on desktop, a labelled bottom
          sheet on touch, where the old hover-revealed 32px icon had no equivalent. */}
      <div className="flex shrink-0 items-center justify-end">
        <RowActionsMenu
          row={doc}
          actions={[
            {
              label: "Download",
              onSelect: () => {
                void handleDownload();
              },
              icon: (
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
              ),
            },
            {
              label: "Delete",
              destructive: true,
              onSelect: () => onDelete(doc.id),
              icon: (
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                </svg>
              ),
            },
          ]}
        />
      </div>
    </div>
  );
}

// ============================================================================
// Empty State
// ============================================================================

function EmptyState({ onUpload }: { onUpload: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center px-4 py-16 md:py-24">
      <div className="w-20 h-20 rounded-2xl bg-[#10b981]/10 flex items-center justify-center mb-5">
        <svg
          width="36"
          height="36"
          viewBox="0 0 24 24"
          fill="none"
          stroke="#10b981"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
        </svg>
      </div>
      <h3 className="text-lg font-semibold text-[#1e293b] dark:text-white mb-1">
        No documents yet
      </h3>
      <p
        className="text-sm text-[#94a3b8] dark:text-white/40 mb-5 text-center"
        style={{ maxWidth: 420 }}
      >
        Upload statements, invoices, receipts, and other financial documents to keep everything
        organized.
      </p>
      <button
        type="button"
        onClick={onUpload}
        className="flex h-11 items-center gap-2 px-5 rounded-lg bg-gradient-to-r from-[#10b981] to-[#059669] text-white text-sm font-medium shadow-sm hover:shadow-md transition-all"
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
          <polyline points="17 8 12 3 7 8" />
          <line x1="12" y1="3" x2="12" y2="15" />
        </svg>
        Upload Document
      </button>
    </div>
  );
}

// ============================================================================
// Skeletons
// ============================================================================

function GridSkeleton() {
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3 md:gap-5">
      {Array.from({ length: 8 }).map((_, i) => (
        <div
          key={`skel-${i.toString()}`}
          className="flex flex-col rounded-xl border border-[#e2e8f0] dark:border-white/10 bg-white dark:bg-[#111827] overflow-hidden animate-pulse"
        >
          <div className="w-full aspect-[4/3] bg-[#f1f5f9] dark:bg-[#0f172a]" />
          <div className="p-3 flex items-center gap-2">
            <div className="w-6 h-6 rounded-md bg-[#e2e8f0] dark:bg-white/10" />
            <div className="flex-1">
              <div className="h-3.5 w-3/4 rounded bg-[#e2e8f0] dark:bg-white/10 mb-1" />
              <div className="h-2.5 w-1/2 rounded bg-[#e2e8f0] dark:bg-white/10" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function ListSkeleton() {
  return (
    <div className="rounded-xl border border-[#e2e8f0] dark:border-white/10 overflow-hidden bg-white dark:bg-[#111827]">
      <div className="hidden md:block px-5 py-3 border-b border-[#e2e8f0] dark:border-white/10 bg-[#f8fafc] dark:bg-[#0f172a]">
        <div className="h-3 w-32 rounded bg-[#e2e8f0] dark:bg-white/10" />
      </div>
      {Array.from({ length: 5 }).map((_, i) => (
        <div
          key={`lskel-${i.toString()}`}
          className="flex items-center gap-4 px-4 py-4 md:px-5 border-b last:border-b-0 border-[#e2e8f0] dark:border-white/10 animate-pulse"
        >
          <div className="w-10 h-10 shrink-0 rounded-lg bg-[#e2e8f0] dark:bg-white/10 md:w-7 md:h-7 md:rounded-md" />
          <div className="min-w-0 flex-1 h-3.5 rounded bg-[#e2e8f0] dark:bg-white/10" />
          {/* The trailing columns only exist from `md` up, so the skeleton must not imply them. */}
          <div className="hidden md:block w-20 h-3 rounded bg-[#e2e8f0] dark:bg-white/10" />
          <div className="hidden md:block w-16 h-3 rounded bg-[#e2e8f0] dark:bg-white/10" />
          <div className="hidden md:block w-28 h-3 rounded bg-[#e2e8f0] dark:bg-white/10" />
        </div>
      ))}
    </div>
  );
}
