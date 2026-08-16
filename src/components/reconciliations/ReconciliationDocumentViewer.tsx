/**
 * Reconciliation Document Viewer
 * Adapted from InteractiveDocumentViewer for bank statement viewing.
 * Shows the bank statement PDF/image with bounding boxes linked to statement lines.
 * Supports drag-and-drop upload of real bank statements.
 * Supports bidirectional hover linking with the transactions panel.
 * Can display PDFs via iframe or images via SVG overlay.
 */
import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { Trash2 } from "lucide-react";

// ============================================================================
// Types
// ============================================================================

export interface StatementBoundingBox {
  /** ID of the corresponding statement line */
  statementLineId: string;
  /** Display label (transaction description) */
  label: string;
  /** Amount text for tooltip */
  amount?: string;
  /** [ymin, xmin, ymax, xmax] 0-1000 normalized */
  bbox: [number, number, number, number];
  /** Page number (0-indexed) */
  page: number;
  /** Whether this line is matched */
  isMatched: boolean;
}

interface ReconciliationDocumentViewerProps {
  /** URL of the rendered statement image (for SVG overlay mode) */
  imageUrl: string | null;
  /** Array of per-page image URLs for multi-page documents */
  imageUrls?: string[];
  /** Base64 PDF data (data URL) — if provided, shown in iframe */
  pdfDataUrl?: string | null;
  /** Original document URL for the "Open" link */
  documentUrl?: string;
  /** Bounding boxes linked to statement lines */
  boundingBoxes: StatementBoundingBox[];
  /** Which statement line is currently hovered in the transactions panel */
  activeLineId?: string | null;
  /** Called when a bounding box is hovered */
  onLineHover?: (lineId: string | null) => void;
  /** Called when a bounding box is clicked */
  onLineSelect?: (lineId: string | null) => void;
  /** Current page */
  currentPage?: number;
  /** Total pages */
  totalPages?: number;
  /** Page change handler */
  onPageChange?: (page: number) => void;
  /** Called when user uploads a bank statement file */
  onUploadStatement?: (file: File) => void;
  /** Whether statement is being uploaded / AI-processed */
  isUploading?: boolean;
  /** Upload or validation error message */
  uploadError?: string | null;
  /** Non-blocking validation warnings */
  validationWarnings?: string[];
  /** Whether reconcile mode is active (user is matching a txn to a bbox) */
  reconcileMode?: boolean;
  /** Called when user clicks an unmatched bbox in reconcile mode */
  onReconcileSelect?: (statementLineId: string) => void;
  /** Called when user wants to create a transaction from an unmatched bbox */
  onCreateFromBbox?: (statementLineId: string) => void;
  /** Called when user wants to quick-match an unmatched bbox to a known ledger txn */
  onQuickMatchFromBbox?: (statementLineId: string, journalLineId: string) => void;
  /** Map of absolute amount string → match candidate ledger transaction */
  matchCandidateMap?: Map<
    string,
    { id: string; description?: string | null; partyName?: string | null }
  >;
  /** Statement line ID that was just successfully matched (triggers flash animation) */
  matchingLineId?: string | null;

  /** Called when user clicks Generate Statement */
  onGenerateStatement?: () => void;
  /** Whether statement generation is in progress */
  isGenerating?: boolean;
  /** Called when user clicks "Remove Reference" (trash icon) */
  onRemoveStatement?: () => void;
  /** Whether statement removal is in progress */
  isRemoving?: boolean;
  /** Called when user clicks "Run AI OCR" to generate bounding boxes */
  onRunOcr?: () => void;
  /** Whether AI OCR is in progress */
  isRunningOcr?: boolean;
  /** Called when user wants to re-run full statement extraction (lines + balances) */
  onRerunExtraction?: () => void;
  /** Whether a full statement re-extraction is in progress */
  isRerunningExtraction?: boolean;
}

// ============================================================================
// Constants
// ============================================================================

const VB_WIDTH = 1000;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 4;
const ZOOM_STEP = 0.25;

// ============================================================================
// Component
// ============================================================================

export function ReconciliationDocumentViewer({
  imageUrl,
  imageUrls,
  pdfDataUrl,
  documentUrl,
  boundingBoxes,
  activeLineId = null,
  onLineHover,
  onLineSelect,
  currentPage = 1,
  totalPages = 1,
  onPageChange,
  onUploadStatement,
  isUploading = false,
  uploadError = null,
  validationWarnings = [],
  reconcileMode = false,
  onReconcileSelect,
  onCreateFromBbox,
  onQuickMatchFromBbox,
  matchCandidateMap,
  matchingLineId = null,

  onGenerateStatement,
  isGenerating = false,
  onRemoveStatement,
  isRemoving = false,
  onRunOcr,
  isRunningOcr = false,
  onRerunExtraction,
  isRerunningExtraction = false,
}: ReconciliationDocumentViewerProps) {
  // Dismissible banner state for the populated viewer (errors/warnings after a
  // statement is already attached — previously these only showed pre-upload).
  const [bannerDismissed, setBannerDismissed] = useState(false);
  useEffect(() => {
    // New error/warnings → re-show the banner.
    setBannerDismissed(false);
  }, [uploadError, validationWarnings]);
  const openUrl = documentUrl ?? imageUrl;
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Compute active image URL (currentPage is 1-indexed)
  const activeImageUrl = imageUrls?.[currentPage - 1] ?? imageUrl;

  // Filter bounding boxes to current page (bboxes use 0-indexed page)
  const pageBoxes = useMemo(
    () => boundingBoxes.filter((b) => b.page === currentPage - 1),
    [boundingBoxes, currentPage],
  );

  const [imgNatural, setImgNatural] = useState<{ w: number; h: number } | null>(null);
  const [loadedUrls, setLoadedUrls] = useState<Set<string>>(new Set());
  const imageLoaded = activeImageUrl ? loadedUrls.has(activeImageUrl) : false;
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const panStart = useRef({ x: 0, y: 0 });
  const panOrigin = useRef({ x: 0, y: 0 });
  const [hoveredBox, setHoveredBox] = useState<string | null>(null);
  const [popoverBox, setPopoverBox] = useState<StatementBoundingBox | null>(null);
  const [flashLineId, setFlashLineId] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Flash animation when a match succeeds
  useEffect(() => {
    if (!matchingLineId) return;
    setFlashLineId(matchingLineId);
    const timer = setTimeout(() => setFlashLineId(null), 1200);
    return () => clearTimeout(timer);
  }, [matchingLineId]);

  // ── File upload handlers ──
  const handleFileSelect = useCallback(
    (file: File) => {
      const validTypes = ["application/pdf", "image/png", "image/jpeg", "image/jpg"];
      if (!validTypes.includes(file.type)) return;
      onUploadStatement?.(file);
    },
    [onUploadStatement],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragOver(false);
      const file = e.dataTransfer.files[0];
      if (file) handleFileSelect(file);
    },
    [handleFileSelect],
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
  }, []);

  const handleFileInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) handleFileSelect(file);
      // Reset so re-selecting same file triggers change
      e.target.value = "";
    },
    [handleFileSelect],
  );

  useEffect(() => {
    if (!activeImageUrl) return;
    const img = new Image();
    img.onload = () => {
      setImgNatural({ w: img.naturalWidth, h: img.naturalHeight });
    };
    img.src = activeImageUrl;
    // Don't reset loading for already-cached URLs
  }, [activeImageUrl]);

  const vbHeight = useMemo(() => {
    if (!imgNatural) return VB_WIDTH;
    return Math.round((imgNatural.h / imgNatural.w) * VB_WIDTH);
  }, [imgNatural]);

  const viewBox = useMemo(() => {
    const w = VB_WIDTH / zoom;
    const h = vbHeight / zoom;
    const cx = VB_WIDTH / 2 - pan.x;
    const cy = vbHeight / 2 - pan.y;
    return `${cx - w / 2} ${cy - h / 2} ${w} ${h}`;
  }, [zoom, pan, vbHeight]);

  const handleZoomIn = useCallback(() => {
    setZoom((z) => Math.min(MAX_ZOOM, z + ZOOM_STEP));
  }, []);
  const handleZoomOut = useCallback(() => {
    setZoom((z) => Math.max(MIN_ZOOM, z - ZOOM_STEP));
  }, []);
  const handleZoomReset = useCallback(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, []);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      setIsPanning(true);
      panStart.current = { x: e.clientX, y: e.clientY };
      panOrigin.current = { ...pan };
    },
    [pan],
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!isPanning || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const scaleX = VB_WIDTH / rect.width;
      const scaleY = vbHeight / rect.height;
      const dx = ((e.clientX - panStart.current.x) * scaleX) / zoom;
      const dy = ((e.clientY - panStart.current.y) * scaleY) / zoom;
      setPan({
        x: panOrigin.current.x + dx,
        y: panOrigin.current.y + dy,
      });
    },
    [isPanning, zoom, vbHeight],
  );

  const handleMouseUp = useCallback(() => {
    setIsPanning(false);
  }, []);

  // Auto-zoom to active line's bounding box - DISABLED per user request
  // useEffect(() => {
  //   if (!activeLineId) return;
  //   const box = boundingBoxes.find((b) => b.statementLineId === activeLineId);
  //   if (!box) return;
  //   const [ymin, xmin, ymax, xmax] = box.bbox;
  //   const cx = (xmin + xmax) / 2;
  //   const cy = ((ymin + ymax) / 2 / 1000) * vbHeight;
  //   const boxW = xmax - xmin;
  //   const boxH = ((ymax - ymin) / 1000) * vbHeight;
  //   const maxDim = Math.max(boxW, boxH);
  //   const isLargeBox = maxDim > VB_WIDTH * 0.5 || boxH > vbHeight * 0.35;

  //   if (isLargeBox) {
  //     setZoom(1);
  //     setPan({ x: 0, y: 0 });
  //   } else {
  //     const targetZoom = Math.min(MAX_ZOOM, Math.max(1.5, VB_WIDTH / (maxDim * 2.5)));
  //     setZoom(targetZoom);
  //     setPan({ x: VB_WIDTH / 2 - cx, y: vbHeight / 2 - cy });
  //   }
  // }, [activeLineId, boundingBoxes, vbHeight]);

  const zoomPercent = Math.round(zoom * 100);

  // ── Empty state: no document uploaded  // ── No image yet: upload placeholder ──
  if (!imageUrl && !pdfDataUrl) {
    return (
      <div className="flex flex-col h-full">
        {/* Toolbar placeholder */}
        <div className="flex items-center justify-between px-3 py-2 border-b border-gray-100 dark:border-white/5 shrink-0 bg-white/80 dark:bg-white/[0.02] backdrop-blur-sm">
          <span className="text-[13px] font-semibold text-gray-800 dark:text-white">
            Bank Statement
          </span>
        </div>
        <div
          className={`flex-1 flex flex-col items-center justify-center text-center px-6 transition-colors ${
            isDragOver
              ? "bg-emerald-50 dark:bg-emerald-900/20 ring-2 ring-inset ring-emerald-400 dark:ring-emerald-500 rounded-lg m-3"
              : ""
          }`}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,.png,.jpg,.jpeg"
            onChange={handleFileInputChange}
            className="hidden"
          />

          {/* Upload error — outside the upload/processing branches so a
              failure stays visible while the next attempt is in flight. */}
          {uploadError && (
            <div className="mb-3 px-3 py-2 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/30">
              <div className="text-[11px] font-medium text-red-600 dark:text-red-400">
                {uploadError}
              </div>
            </div>
          )}

          {/* Validation warnings — the pipeline reports these asynchronously,
              so they must render regardless of the empty state's branch. */}
          {validationWarnings.length > 0 && (
            <div className="mb-3 px-3 py-2 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/30">
              {validationWarnings.map((w, i) => (
                <div key={i} className="text-[11px] text-amber-600 dark:text-amber-400">
                  ⚠ {w}
                </div>
              ))}
            </div>
          )}

          {isUploading ? (
            /* Upload / AI processing spinner */
            <>
              <div className="w-16 h-16 rounded-2xl bg-emerald-50 dark:bg-emerald-900/20 flex items-center justify-center mb-4">
                <div className="w-7 h-7 rounded-full border-3 border-emerald-500 border-t-transparent animate-spin" />
              </div>
              <div className="text-[13px] font-medium text-emerald-600 dark:text-emerald-400 mb-1">
                Processing statement…
              </div>
              <div className="text-[11px] text-gray-400 dark:text-white/30">
                AI is classifying, extracting, and matching transactions
              </div>
            </>
          ) : (
            /* Drag-and-drop upload zone */
            <>
              <div className="w-16 h-16 rounded-2xl bg-gray-100 dark:bg-white/5 flex items-center justify-center mb-4">
                <svg
                  width="28"
                  height="28"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  className={isDragOver ? "text-emerald-500" : "text-gray-300 dark:text-white/20"}
                >
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="17 8 12 3 7 8" />
                  <line x1="12" y1="3" x2="12" y2="15" />
                </svg>
              </div>
              <div className="text-[13px] font-medium text-gray-500 dark:text-white/40 mb-1">
                {isDragOver ? "Drop to upload" : "Upload bank statement"}
              </div>
              <div className="text-[11px] text-gray-400 dark:text-white/30 mb-4">
                Drag & drop a PDF or image, or click to browse.
                <br />
                AI will extract and match transactions automatically.
              </div>

              {onUploadStatement && (
                <div className="flex flex-col items-center gap-2">
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="flex items-center justify-center gap-2 px-6 py-2 rounded-lg bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 text-[12px] font-semibold hover:bg-emerald-500/20 transition-colors whitespace-nowrap"
                  >
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                      <polyline points="17 8 12 3 7 8" />
                      <line x1="12" y1="3" x2="12" y2="15" />
                    </svg>
                    Upload Statement
                  </button>

                  {onGenerateStatement && (
                    <div className="flex flex-col items-center mt-4 pt-4 border-t border-gray-200 dark:border-white/10">
                      <p className="text-[11px] text-gray-500 dark:text-gray-400 mb-2 whitespace-nowrap">
                        Missing the original PDF?
                      </p>
                      <button
                        type="button"
                        onClick={onGenerateStatement}
                        disabled={isGenerating}
                        className="flex items-center justify-center gap-2 px-6 py-2 rounded-lg bg-blue-500/10 text-blue-700 dark:text-blue-400 text-[12px] font-semibold hover:bg-blue-500/20 transition-colors disabled:opacity-50 whitespace-nowrap"
                      >
                        {isGenerating ? (
                          <>
                            <div className="w-3 h-3 rounded-full border-2 border-current border-t-transparent animate-spin" />
                            Generating...
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
                              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                              <polyline points="14 2 14 8 20 8" />
                              <line x1="12" y1="18" x2="12" y2="12" />
                              <line x1="9" y1="15" x2="15" y2="15" />
                            </svg>
                            Generate Statement PDF
                          </>
                        )}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    );
  }

  // ── PDF display mode (iframe) REMOVED per user request (force SVG) ──
  // If we have pdfDataUrl but no imageUrl, it means preview is generating.
  // Show loading state instead of iframe.
  if (pdfDataUrl && !imageUrl) {
    return (
      <div className="flex flex-col h-full bg-[#f1f5f9] items-center justify-center relative group">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 rounded-full border-2 border-emerald-500 border-t-transparent animate-spin" />
          <span className="text-xs font-medium text-gray-500">Generating preview...</span>
        </div>

        {/* Escape hatch for stuck loading states */}
        {onRemoveStatement && (
          <div className="absolute top-4 right-4 opacity-0 group-hover:opacity-100 transition-opacity">
            <button
              onClick={onRemoveStatement}
              className="flex items-center gap-2 px-3 py-2 rounded-lg bg-white shadow-sm border border-gray-200 text-red-600 hover:bg-red-50 text-xs font-medium transition-colors"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Remove Statement
            </button>
          </div>
        )}
      </div>
    );
  }

  // ── Image display mode (SVG overlay with bounding boxes) ──
  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-100 dark:border-white/5 shrink-0 bg-white/80 dark:bg-white/[0.02] backdrop-blur-sm">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={handleZoomOut}
            disabled={zoom <= MIN_ZOOM}
            className="w-7 h-7 min-h-11 min-w-11 lg:min-h-0 lg:min-w-0 flex items-center justify-center rounded-md transition-colors hover:bg-gray-100 dark:hover:bg-white/5 disabled:opacity-30 text-gray-500"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
            >
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
          <span className="text-[11px] font-semibold min-w-[3rem] text-center tabular-nums text-gray-400">
            {zoomPercent}%
          </span>
          <button
            type="button"
            onClick={handleZoomIn}
            disabled={zoom >= MAX_ZOOM}
            className="w-7 h-7 min-h-11 min-w-11 lg:min-h-0 lg:min-w-0 flex items-center justify-center rounded-md transition-colors hover:bg-gray-100 dark:hover:bg-white/5 disabled:opacity-30 text-gray-500"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
            >
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
          <div className="w-px h-4 mx-1 bg-gray-200 dark:bg-white/10" />
          <button
            type="button"
            onClick={handleZoomReset}
            className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium transition-colors hover:bg-gray-100 dark:hover:bg-white/5 text-gray-400"
          >
            Fit
          </button>
        </div>

        <div className="flex items-center gap-2">
          {/* Page navigation */}
          {totalPages > 1 && (
            <div className="flex items-center gap-1 text-[11px] text-gray-400">
              <button
                type="button"
                onClick={() => onPageChange?.(Math.max(1, currentPage - 1))}
                disabled={currentPage <= 1}
                className="w-6 h-6 min-h-11 min-w-11 lg:min-h-0 lg:min-w-0 flex items-center justify-center rounded hover:bg-gray-100 dark:hover:bg-white/5 disabled:opacity-30"
              >
                <svg
                  width="10"
                  height="10"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                >
                  <path d="M15 18l-6-6 6-6" />
                </svg>
              </button>
              <span className="tabular-nums font-medium">
                {currentPage} / {totalPages}
              </span>
              <button
                type="button"
                onClick={() => onPageChange?.(Math.min(totalPages, currentPage + 1))}
                disabled={currentPage >= totalPages}
                className="w-6 h-6 min-h-11 min-w-11 lg:min-h-0 lg:min-w-0 flex items-center justify-center rounded hover:bg-gray-100 dark:hover:bg-white/5 disabled:opacity-30"
              >
                <svg
                  width="10"
                  height="10"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                >
                  <path d="M9 18l6-6-6-6" />
                </svg>
              </button>
            </div>
          )}

          {onRunOcr && (
            <button
              onClick={onRunOcr}
              disabled={isRunningOcr || isUploading}
              className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/10 disabled:opacity-50 transition-colors"
              title={
                boundingBoxes.length > 0
                  ? "Re-scan document fields"
                  : "Scan document fields using AI"
              }
            >
              {isRunningOcr ? (
                <>
                  <div className="w-3 h-3 rounded-full border-2 border-current border-t-transparent animate-spin" />
                  Scanning…
                </>
              ) : (
                <>
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <path d="M12 3v3m0 12v3M3 12h3m12 0h3M5.6 5.6l2.1 2.1m8.6 8.6l2.1 2.1M5.6 18.4l2.1-2.1m8.6-8.6l2.1-2.1" />
                  </svg>
                  {boundingBoxes.length > 0 ? "Re-scan" : "Scan Fields"}
                </>
              )}
            </button>
          )}

          {onRerunExtraction && (
            <button
              type="button"
              onClick={onRerunExtraction}
              disabled={isRerunningExtraction || isUploading || isRunningOcr}
              className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium text-violet-600 dark:text-violet-400 hover:bg-violet-50 dark:hover:bg-violet-900/10 disabled:opacity-50 transition-colors"
              title="Re-extract statement lines and balances with AI (replaces current lines and match decisions)"
            >
              {isRerunningExtraction ? (
                <>
                  <div className="w-3 h-3 rounded-full border-2 border-current border-t-transparent animate-spin" />
                  Extracting…
                </>
              ) : (
                <>
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6" />
                  </svg>
                  Re-extract
                </>
              )}
            </button>
          )}

          {onRemoveStatement && (
            <button
              onClick={onRemoveStatement}
              disabled={isRemoving || isUploading}
              className="w-6 h-6 min-h-11 min-w-11 lg:min-h-0 lg:min-w-0 flex items-center justify-center rounded hover:bg-red-50 dark:hover:bg-red-900/10 text-gray-400 hover:text-red-500 disabled:opacity-30 transition-colors"
              title="Remove statement"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}

          {openUrl && (
            <a
              href={openUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 text-[11px] font-medium text-emerald-600 dark:text-emerald-400 no-underline hover:opacity-80 transition-colors"
            >
              Open
              <svg
                width="10"
                height="10"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
              >
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3" />
              </svg>
            </a>
          )}
        </div>
      </div>

      {/* Error / validation banner (populated state) */}
      {!bannerDismissed && (uploadError || validationWarnings.length > 0) && (
        <div
          className={`flex items-start gap-2 px-3 py-2 border-b text-xs ${
            uploadError
              ? "bg-red-50 dark:bg-red-950/40 border-red-200 dark:border-red-800/50 text-red-700 dark:text-red-300"
              : "bg-amber-50 dark:bg-amber-950/40 border-amber-200 dark:border-amber-800/50 text-amber-700 dark:text-amber-300"
          }`}
        >
          <div className="flex-1 space-y-0.5">
            {uploadError && <p className="font-medium">{uploadError}</p>}
            {validationWarnings.map((w, i) => (
              <p key={i}>{w}</p>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setBannerDismissed(true)}
            className="shrink-0 opacity-60 hover:opacity-100 transition-opacity"
            aria-label="Dismiss"
          >
            ✕
          </button>
        </div>
      )}

      {/* Reconcile mode banner */}
      {reconcileMode && (
        <div className="flex items-center gap-2 px-3 py-2 bg-cyan-50 dark:bg-cyan-950/50 border-b border-cyan-200 dark:border-cyan-800/50">
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="text-cyan-600 dark:text-cyan-400 shrink-0"
          >
            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
          </svg>
          <span className="text-[11px] font-medium text-cyan-700 dark:text-cyan-300">
            Click an unmatched statement line to reconcile
          </span>
        </div>
      )}

      {/* SVG Viewer */}
      <div
        ref={containerRef}
        className="flex-1 overflow-hidden relative"
        style={{
          backgroundColor: "#f1f5f9",
          cursor: isPanning ? "grabbing" : "grab",
        }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
      >
        <svg
          ref={svgRef}
          viewBox={viewBox}
          className="w-full h-full"
          style={{
            display: "block",
            transition: isPanning ? "none" : "all 0.35s cubic-bezier(0.4, 0, 0.2, 1)",
          }}
          preserveAspectRatio="xMidYMid meet"
        >
          <image
            href={activeImageUrl!}
            x="0"
            y="0"
            width={VB_WIDTH}
            height={vbHeight}
            preserveAspectRatio="none"
            onLoad={() => {
              if (activeImageUrl) {
                setLoadedUrls((prev) => new Set(prev).add(activeImageUrl));
              }
            }}
            style={{ opacity: imageLoaded ? 1 : 0 }}
          />

          {/* Bounding box overlays linked to statement lines */}
          {imageLoaded &&
            pageBoxes.map((box) => {
              const [ymin, xmin, ymax, xmax] = box.bbox;
              const isActive = activeLineId === box.statementLineId;
              const isHovered = hoveredBox === box.statementLineId;
              const sy = (v: number) => (v / 1000) * vbHeight;
              const isFlashing = flashLineId === box.statementLineId;

              // Color based on match status (cyan for unmatched in reconcile mode)
              const reconcileClickable = reconcileMode && !box.isMatched;
              const color = box.isMatched
                ? "#10b981"
                : reconcileMode
                  ? "#06b6d4" // Cyan for reconcile-clickable
                  : "#f59e0b";

              return (
                <rect
                  key={box.statementLineId}
                  x={xmin}
                  y={sy(ymin)}
                  width={xmax - xmin}
                  height={sy(ymax) - sy(ymin)}
                  fill={
                    isActive
                      ? `${color}25`
                      : isHovered
                        ? `${color}18`
                        : reconcileClickable
                          ? "#06b6d418" // Cyan tint for reconcile targets
                          : box.isMatched
                            ? reconcileMode
                              ? "#10b98108" // Extra dimmed when reconcile mode active
                              : "#10b98112"
                            : "#f59e0b10"
                  }
                  stroke={
                    isActive
                      ? color
                      : isHovered
                        ? `${color}90`
                        : reconcileClickable
                          ? "#06b6d480" // Visible cyan border
                          : box.isMatched
                            ? "#10b98160"
                            : "#f59e0b50"
                  }
                  strokeWidth={isActive ? 2.5 : isHovered ? 2 : reconcileClickable ? 1.5 : 1}
                  strokeDasharray={
                    isActive || isHovered
                      ? "none"
                      : reconcileClickable
                        ? "none" // Solid for reconcile targets
                        : box.isMatched
                          ? "none"
                          : "4 2"
                  }
                  rx="3"
                  ry="3"
                  style={{
                    cursor: reconcileClickable ? "crosshair" : "pointer",
                    transition: "all 0.2s ease",
                    ...(isFlashing
                      ? {
                          fill: "#10b98140",
                          stroke: "#10b981",
                          strokeWidth: 3,
                          animation: "reconcile-flash 1.2s ease-out",
                        }
                      : {}),
                  }}
                  onMouseEnter={() => {
                    setHoveredBox(box.statementLineId);
                    onLineHover?.(box.statementLineId);
                    // Show popover for unmatched boxes (not in reconcile mode)
                    if (!box.isMatched && !reconcileMode) {
                      setPopoverBox(box);
                    }
                  }}
                  onMouseLeave={() => {
                    setHoveredBox(null);
                    onLineHover?.(null);
                    setPopoverBox(null);
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (reconcileMode && !box.isMatched) {
                      // In reconcile mode, clicking an unmatched box matches it
                      onReconcileSelect?.(box.statementLineId);
                    } else {
                      // Normal mode: select/highlight the line
                      onLineSelect?.(box.statementLineId);
                    }
                  }}
                />
              );
            })}
        </svg>

        {popoverBox &&
          !popoverBox.isMatched &&
          !reconcileMode &&
          containerRef.current &&
          (() => {
            const rect = containerRef.current!.getBoundingClientRect();
            const [ymin, xmin, _ymax, xmax] = popoverBox.bbox;
            // Convert SVG coords to pixel position relative to container
            // Parse the current viewBox to map coordinates
            const vbParts = viewBox.split(" ").map(Number);
            const [vbX, vbY, vbW, vbH] = vbParts;
            const _pxLeft = ((xmin - vbX) / vbW) * rect.width;
            const pxTop = (((ymin / 1000) * vbHeight - vbY) / vbH) * rect.height;
            const pxRight = ((xmax - vbX) / vbW) * rect.width;

            // Check if a match candidate exists for this bbox's amount
            const amountText = (popoverBox.amount || "").replace(/[,$+]/g, "");
            const amountKey = Math.abs(Number.parseFloat(amountText) || 0).toFixed(2);
            const matchCandidate = matchCandidateMap?.get(amountKey);

            return (
              <div
                className="absolute z-20 pointer-events-auto"
                style={{
                  left: Math.min(pxRight + 8, rect.width - 220),
                  top: Math.max(pxTop - 10, 4),
                }}
                onMouseEnter={() => setPopoverBox(popoverBox)}
                onMouseLeave={() => setPopoverBox(null)}
              >
                <div
                  className={`w-[210px] rounded-lg border shadow-xl p-3 space-y-2 ${
                    matchCandidate
                      ? "border-cyan-300/40 dark:border-cyan-600/30 bg-white dark:bg-[#1a1f2e]"
                      : "border-amber-300/40 dark:border-amber-600/30 bg-white dark:bg-[#1a1f2e]"
                  }`}
                >
                  <div className="flex items-center gap-1.5">
                    {matchCandidate ? (
                      <>
                        <div className="w-5 h-5 rounded-full bg-cyan-500/15 flex items-center justify-center">
                          <svg
                            width="10"
                            height="10"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            className="text-cyan-500"
                          >
                            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                          </svg>
                        </div>
                        <span className="text-[11px] font-semibold text-cyan-600 dark:text-cyan-400">
                          Match Available
                        </span>
                      </>
                    ) : (
                      <>
                        <div className="w-5 h-5 rounded-full bg-amber-500/15 flex items-center justify-center">
                          <svg
                            width="10"
                            height="10"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2.5"
                            className="text-amber-500"
                          >
                            <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                            <line x1="12" y1="9" x2="12" y2="13" />
                            <line x1="12" y1="17" x2="12.01" y2="17" />
                          </svg>
                        </div>
                        <span className="text-[11px] font-semibold text-amber-600 dark:text-amber-400">
                          Missing Transaction
                        </span>
                      </>
                    )}
                  </div>
                  <div className="space-y-1">
                    <div className="text-[11px] text-gray-700 dark:text-white/70 font-medium truncate">
                      {popoverBox.label}
                    </div>
                    {popoverBox.amount && (
                      <div className="text-[12px] font-semibold tabular-nums text-gray-900 dark:text-white">
                        {popoverBox.amount}
                      </div>
                    )}
                  </div>
                  {matchCandidate && onQuickMatchFromBbox ? (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onQuickMatchFromBbox(popoverBox.statementLineId, matchCandidate.id);
                        setPopoverBox(null);
                      }}
                      className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md bg-cyan-500/10 text-cyan-700 dark:text-cyan-400 text-[11px] font-semibold hover:bg-cyan-500/20 transition-colors"
                    >
                      <svg
                        width="10"
                        height="10"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                        <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                      </svg>
                      Link Transaction
                    </button>
                  ) : (
                    onCreateFromBbox && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onCreateFromBbox(popoverBox.statementLineId);
                        }}
                        className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 text-[11px] font-semibold hover:bg-emerald-500/20 transition-colors"
                      >
                        <svg
                          width="10"
                          height="10"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2.5"
                        >
                          <line x1="12" y1="5" x2="12" y2="19" />
                          <line x1="5" y1="12" x2="19" y2="12" />
                        </svg>
                        Create Transaction
                      </button>
                    )
                  )}
                </div>
              </div>
            );
          })()}

        {/* CSS keyframe for reconcile flash */}
        <style>{`
          @keyframes reconcile-flash {
            0% { fill: #10b98160; stroke: #10b981; stroke-width: 3; }
            50% { fill: #10b98130; stroke: #10b981; stroke-width: 2; }
            100% { fill: #10b98112; stroke: #10b98160; stroke-width: 1; }
          }
        `}</style>

        {/* Loading overlay */}
        {!imageLoaded && (
          <div
            className="absolute inset-0 flex items-center justify-center"
            style={{ minHeight: 400 }}
          >
            <div className="flex flex-col items-center gap-3">
              <div className="w-8 h-8 rounded-full border-2 border-emerald-500 border-t-transparent animate-spin" />
              <span className="text-xs font-medium text-gray-400">Loading statement…</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default ReconciliationDocumentViewer;
