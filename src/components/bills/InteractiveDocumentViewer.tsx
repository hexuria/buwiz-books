/**
 * Interactive Document Viewer
 * SVG-based document viewer with bounding box overlays.
 * Renders the document as an <image> inside an <svg>, with <rect>
 * elements for AI-detected field regions. Supports zoom, pan, and
 * field-to-box linking (focus sidebar field → highlight + zoom to box).
 *
 * The `imageUrl` should point to a rendered image (PNG/JPEG) of the
 * document — not a PDF. The server converts PDFs to PNGs on upload.
 * `documentUrl` is the original file URL used for the "Open" link.
 *
 * Coordinate system:
 * - Bounding boxes are in [ymin, xmin, ymax, xmax] format, 0-1000
 *   normalized relative to the image's natural dimensions.
 * - The SVG viewBox is fixed at 1000×1000, matching Gemini's native
 *   coordinate space. The SVG stretches (preserveAspectRatio="none")
 *   to fill a CSS aspect-ratio container that maintains the correct
 *   visual proportions. This ensures bbox coords map accurately
 *   without any scaling that could amplify errors.
 */
import { useState, useRef, useCallback, useEffect, useMemo } from "react";

// ============================================================================
// Types
// ============================================================================

export interface BoundingBox {
  fieldId: string;
  label: string;
  text?: string; // Actual extracted text content (for clipboard copy)
  bbox: [number, number, number, number]; // [ymin, xmin, ymax, xmax] 0-1000
  page: number;
}

interface InteractiveDocumentViewerProps {
  /** URL of the rendered image (PNG from server-side PDF conversion) */
  imageUrl: string;
  /** Array of per-page image URLs for multi-page documents */
  imageUrls?: string[];
  /** Original document URL for the "Open" link (may differ from imageUrl for PDFs) */
  documentUrl?: string;
  boundingBoxes: BoundingBox[];
  /** Total number of pages (from API) */
  totalPages?: number;
  /** External page change callback */
  onPageChange?: (page: number) => void;
  /** Which field to highlight + zoom to (driven by sidebar field focus) */
  /**
   * Deprecated. Resolves to the first box with this fieldId on any page,
   * which is ambiguous once a document has repeated fields across pages.
   * Prefer `activeBox`.
   */
  activeFieldId?: string | null;
  /**
   * The box to focus. `index` (into `boundingBoxes`) is unambiguous even when
   * a page repeats a fieldId; `page` disambiguates when only a name is known.
   */
  activeBox?: { fieldId: string; page?: number; index?: number } | null;
  /** Callback to trigger bounding box re-scan */
  onRescan?: () => void;
  /** Whether a re-scan is in progress */
  isRescanning?: boolean;
  /** Callback to upload a new document if the current one is broken */
  onReplaceDocument?: (file: File) => void;
  /** Whether the document preview is being generated (specific to PDFs) */
  isPreviewPending?: boolean;
}

// ============================================================================
// Constants
// ============================================================================

const VB_SIZE = 1000; // ViewBox is 1000×1000 — matches Gemini's 0-1000 normalized range
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 4;
const ZOOM_STEP = 0.25;

// Field color mapping for visual differentiation
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
};

function getFieldColor(fieldId: string | undefined | null): string {
  if (!fieldId) return "#10b981";
  // Handle dynamic line_item_N fieldIds
  if (fieldId.toString().startsWith("line_item_")) return "#ec4899";
  return FIELD_COLORS[fieldId] ?? "#10b981";
}

// ============================================================================
// Component
// ============================================================================

export function InteractiveDocumentViewer({
  imageUrl,
  imageUrls,
  documentUrl,
  boundingBoxes,
  totalPages: totalPagesProp,
  onPageChange,
  activeFieldId = null,
  activeBox: activeBoxProp = null,
  onRescan,
  isRescanning = false,
  onReplaceDocument,
  isPreviewPending = false,
}: InteractiveDocumentViewerProps) {
  const openUrl = documentUrl ?? imageUrl;
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Multi-page state
  const [currentPage, setCurrentPage] = useState(0);
  const totalPages = totalPagesProp ?? imageUrls?.length ?? 1;
  const activeImageUrl = imageUrls?.[currentPage] ?? imageUrl;

  // Filter bounding boxes to current page
  const pageBoxes = useMemo(
    () => boundingBoxes.filter((b) => b.page === currentPage),
    [boundingBoxes, currentPage],
  );

  // Bridge the deprecated activeFieldId onto the page-aware shape.
  const activeBox = useMemo(
    () => activeBoxProp ?? (activeFieldId ? { fieldId: activeFieldId } : null),
    [activeBoxProp, activeFieldId],
  );

  /** Index (within boundingBoxes) of the focused box, or -1. */
  const activeIndex = useMemo(() => {
    if (!activeBox) return -1;
    if (typeof activeBox.index === "number") return activeBox.index;
    return boundingBoxes.findIndex(
      (b) =>
        b.fieldId === activeBox.fieldId &&
        (activeBox.page === undefined || b.page === activeBox.page),
    );
  }, [activeBox, boundingBoxes]);

  // Image natural dimensions — used to set CSS aspect-ratio on the container
  const [imgNatural, setImgNatural] = useState<{ w: number; h: number } | null>(null);
  const [imageLoaded, setImageLoaded] = useState(false);
  const [hasError, setHasError] = useState(false);

  // Zoom & pan state
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const panStart = useRef({ x: 0, y: 0 });
  const panOrigin = useRef({ x: 0, y: 0 }); // Copy-to-clipboard toast
  const [copiedLabel, setCopiedLabel] = useState<string | null>(null);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Hidden file input for replacement
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleBoxCopy = useCallback((text: string | undefined, label: string) => {
    const copyText = text ?? label;
    void navigator.clipboard.writeText(copyText);
    // Show truncated text in toast for feedback
    const display = copyText.length > 50 ? `${copyText.slice(0, 47)}…` : copyText;
    setCopiedLabel(display);
    if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
    copyTimeoutRef.current = setTimeout(() => setCopiedLabel(null), 1500);
  }, []);

  // Hover state for "click to copy" cursor hint
  const [hoveredBox, setHoveredBox] = useState<string | null>(null);

  // Page navigation handlers
  const handlePrevPage = useCallback(() => {
    if (currentPage > 0) {
      const newPage = currentPage - 1;
      setCurrentPage(newPage);
      onPageChange?.(newPage);
      // Reset zoom/pan when changing pages
      setZoom(1);
      setPan({ x: 0, y: 0 });
    }
  }, [currentPage, onPageChange]);

  const handleNextPage = useCallback(() => {
    if (currentPage < totalPages - 1) {
      const newPage = currentPage + 1;
      setCurrentPage(newPage);
      onPageChange?.(newPage);
      // Reset zoom/pan when changing pages
      setZoom(1);
      setPan({ x: 0, y: 0 });
    }
  }, [currentPage, totalPages, onPageChange]);

  // --- Preload image to learn its natural width/height ---
  useEffect(() => {
    const img = new Image();
    setImageLoaded(false);
    setHasError(false);

    img.onload = () => {
      setImgNatural({ w: img.naturalWidth, h: img.naturalHeight });
      setImageLoaded(true);
    };
    img.onerror = () => {
      setHasError(true);
      setImageLoaded(true); // Stop spinner
    };
    img.src = activeImageUrl;
  }, [activeImageUrl]);

  // Compute viewBox string based on zoom + pan
  // ViewBox is always 1000×1000 to match Gemini's normalized coordinate space.
  // The SVG uses preserveAspectRatio="none" to stretch into the aspect-ratio
  // container, ensuring both image and bboxes stretch identically.
  const viewBox = useMemo(() => {
    const w = VB_SIZE / zoom;
    const h = VB_SIZE / zoom;
    const cx = VB_SIZE / 2 - pan.x;
    const cy = VB_SIZE / 2 - pan.y;
    return `${cx - w / 2} ${cy - h / 2} ${w} ${h}`;
  }, [zoom, pan]);

  // --- Zoom controls ---
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

  // --- Pan (drag) ---
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
      const scaleX = VB_SIZE / rect.width;
      const scaleY = VB_SIZE / rect.height;
      const dx = ((e.clientX - panStart.current.x) * scaleX) / zoom;
      const dy = ((e.clientY - panStart.current.y) * scaleY) / zoom;
      setPan({
        x: panOrigin.current.x + dx,
        y: panOrigin.current.y + dy,
      });
    },
    [isPanning, zoom],
  );

  const handleMouseUp = useCallback(() => {
    setIsPanning(false);
  }, []);

  // --- Field focus → navigate to its page, then zoom to the box ---
  useEffect(() => {
    if (!activeBox) return;

    // Resolve within the requested page when one is given. A bare fieldId
    // search across all pages picks the first match, so focusing a field
    // that also appears on page 0 used to zoom page 0's box while leaving
    // the viewer on whatever page it was already showing.
    const box =
      typeof activeBox.index === "number"
        ? boundingBoxes[activeBox.index]
        : boundingBoxes.find(
            (b) =>
              b.fieldId === activeBox.fieldId &&
              (activeBox.page === undefined || b.page === activeBox.page),
          );
    if (!box) return;

    // Navigate first; this is what was missing, and it is why an off-page
    // field appeared to do nothing.
    if (box.page !== currentPage) {
      setCurrentPage(box.page);
      onPageChange?.(box.page);
    }

    const [ymin, xmin, ymax, xmax] = box.bbox;
    // Both x and y are already in 0-1000 (Gemini coordinate space = viewBox space)
    const cx = (xmin + xmax) / 2;
    const cy = (ymin + ymax) / 2;

    // Zoom level based on box size — for large boxes (like line_items), stay at 100%
    const boxW = xmax - xmin;
    const boxH = ymax - ymin;
    const maxDim = Math.max(boxW, boxH);
    const isLargeBox = maxDim > VB_SIZE * 0.5 || boxH > VB_SIZE * 0.35;

    if (isLargeBox) {
      // Don't zoom for large regions (e.g., line items table) — just reset to fit
      setZoom(1);
      setPan({ x: 0, y: 0 });
    } else {
      const targetZoom = Math.min(MAX_ZOOM, Math.max(1.5, VB_SIZE / (maxDim * 2.5)));
      setZoom(targetZoom);
      setPan({
        x: VB_SIZE / 2 - cx,
        y: VB_SIZE / 2 - cy,
      });
    }
    // currentPage is deliberately excluded: including it would re-run the
    // effect after the page change above and clobber the zoom just set.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeBox, boundingBoxes, onPageChange]);

  const zoomPercent = Math.round(zoom * 100);

  // File input handler
  const onFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file && onReplaceDocument) {
        onReplaceDocument(file);
      }
      // Reset input
      e.target.value = "";
    },
    [onReplaceDocument],
  );

  if (hasError) {
    return (
      <div className="flex flex-col items-center justify-center gap-6 text-center p-12 rounded-2xl border-2 border-dashed border-red-200 dark:border-red-900/50 bg-gray-50/50 dark:bg-gray-900/50 backdrop-blur-sm max-w-3xl mx-auto">
        <div className="w-16 h-16 rounded-full bg-red-50 dark:bg-red-900/20 flex items-center justify-center text-red-500">
          <svg
            width="32"
            height="32"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
        </div>
        <div className="space-y-2">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Document Missing</h3>
          <p className="text-sm text-gray-500 dark:text-gray-400 leading-relaxed">
            We couldn't load the document preview. The file might have been deleted or the link is
            invalid.
          </p>
        </div>
        {onReplaceDocument && (
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="mt-2 px-5 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-600 text-white text-sm font-medium transition-all shadow-sm hover:shadow-md active:scale-95"
          >
            Upload New Document
          </button>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf,image/jpeg,image/png,image/webp"
          className="hidden"
          onChange={onFileChange}
        />
      </div>
    );
  }

  // CSS aspect-ratio derived from the image's natural dimensions.
  // This keeps the container shaped correctly while the SVG stretches
  // non-uniformly to fill it (preserveAspectRatio="none").
  const aspectRatio = imgNatural ? `${imgNatural.w} / ${imgNatural.h}` : "8.5 / 11";

  return (
    <div className="max-w-3xl mx-auto flex flex-col">
      {/* ─── Toolbar ─── */}
      <div
        className="flex items-center justify-between px-4 py-2.5 rounded-t-xl border border-b-0"
        style={{
          backgroundColor: "var(--viewer-toolbar-bg, rgba(255,255,255,0.95))",
          borderColor: "var(--viewer-border, #e2e8f0)",
          backdropFilter: "blur(12px)",
        }}
      >
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={handleZoomOut}
            disabled={zoom <= MIN_ZOOM}
            className="w-7 h-7 min-h-11 min-w-11 lg:min-h-0 lg:min-w-0 flex items-center justify-center rounded-md text-sm font-medium transition-colors hover:bg-[#f1f5f9] dark:hover:bg-white/5 disabled:opacity-30"
            style={{ color: "#64748b" }}
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

          <span
            className="text-xs font-semibold min-w-[3.5rem] text-center tabular-nums"
            style={{ color: "#94a3b8" }}
          >
            {zoomPercent}%
          </span>

          <button
            type="button"
            onClick={handleZoomIn}
            disabled={zoom >= MAX_ZOOM}
            className="w-7 h-7 min-h-11 min-w-11 lg:min-h-0 lg:min-w-0 flex items-center justify-center rounded-md text-sm font-medium transition-colors hover:bg-[#f1f5f9] dark:hover:bg-white/5 disabled:opacity-30"
            style={{ color: "#64748b" }}
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

          <div className="w-px h-4 mx-1.5" style={{ backgroundColor: "#e2e8f0" }} />

          <button
            type="button"
            onClick={handleZoomReset}
            className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium transition-colors hover:bg-[#f1f5f9] dark:hover:bg-white/5"
            style={{ color: "#94a3b8" }}
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
            </svg>
            Fit
          </button>
        </div>

        {/* ─── Page Navigation ─── */}
        {totalPages > 1 && (
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={handlePrevPage}
              disabled={currentPage <= 0}
              className="w-7 h-7 min-h-11 min-w-11 lg:min-h-0 lg:min-w-0 flex items-center justify-center rounded-md text-sm font-medium transition-colors hover:bg-[#f1f5f9] dark:hover:bg-white/5 disabled:opacity-30"
              style={{ color: "#64748b" }}
              title="Previous page"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
              >
                <polyline points="15 18 9 12 15 6" />
              </svg>
            </button>
            <span
              className="text-xs font-semibold min-w-[4rem] text-center tabular-nums"
              style={{ color: "#94a3b8" }}
            >
              {currentPage + 1} / {totalPages}
            </span>
            <button
              type="button"
              onClick={handleNextPage}
              disabled={currentPage >= totalPages - 1}
              className="w-7 h-7 min-h-11 min-w-11 lg:min-h-0 lg:min-w-0 flex items-center justify-center rounded-md text-sm font-medium transition-colors hover:bg-[#f1f5f9] dark:hover:bg-white/5 disabled:opacity-30"
              style={{ color: "#64748b" }}
              title="Next page"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
              >
                <polyline points="9 18 15 12 9 6" />
              </svg>
            </button>
          </div>
        )}

        <div className="flex items-center gap-3">
          {onRescan && (
            <button
              type="button"
              onClick={onRescan}
              disabled={isRescanning}
              className="flex items-center gap-1 text-xs font-medium transition-colors hover:opacity-80 disabled:opacity-40"
              style={{ color: "#64748b" }}
              title="Re-scan document for improved field detection"
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                className={isRescanning ? "animate-spin" : ""}
              >
                <path d="M21 12a9 9 0 1 1-6.219-8.56" />
              </svg>
              {isRescanning ? "Scanning…" : "Re-scan"}
            </button>
          )}
          <a
            href={openUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 text-xs font-medium no-underline transition-colors hover:opacity-80"
            style={{ color: "#10b981" }}
          >
            Open
            <svg
              width="11"
              height="11"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
            >
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3" />
            </svg>
          </a>
        </div>
      </div>

      {/* ─── SVG Viewer ─── */}
      {/* Container uses CSS aspect-ratio from image natural dims */}
      {/* SVG stretches to fill with preserveAspectRatio="none"    */}
      {/* Both <image> and <rect> bboxes share the same 1000×1000  */}
      {/* coordinate space, so they stay aligned regardless of     */}
      {/* image aspect ratio.                                       */}
      <div
        ref={containerRef}
        className="relative rounded-b-xl border border-t-0 overflow-hidden"
        style={{
          borderColor: "var(--viewer-border, #e2e8f0)",
          backgroundColor: "#f8fafc",
          cursor: isPanning ? "grabbing" : "grab",
          aspectRatio,
          width: "100%",
        }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
      >
        <svg
          ref={svgRef}
          viewBox={viewBox}
          style={{
            display: "block",
            width: "100%",
            height: "100%",
            position: "absolute",
            inset: "0",
            transition: isPanning ? "none" : "all 0.35s cubic-bezier(0.4, 0, 0.2, 1)",
          }}
          preserveAspectRatio="none"
        >
          {/* Document image — fills the 1000×1000 coordinate space */}
          {!hasError && (
            <image
              href={activeImageUrl}
              x="0"
              y="0"
              width={VB_SIZE}
              height={VB_SIZE}
              preserveAspectRatio="none"
              style={{ opacity: imageLoaded ? 1 : 0 }}
            />
          )}

          {/* Bounding box overlays — coords in 0-1000 used directly */}
          {imageLoaded &&
            !hasError &&
            pageBoxes.map((box, i) => {
              const [ymin, xmin, ymax, xmax] = box.bbox;
              // Compare by identity, not by name: one page can legitimately
              // carry several boxes with the same fieldId (line_item_3 twice
              // from one model response), and a name match would light up
              // all of them.
              const isActive = activeIndex >= 0 && boundingBoxes[activeIndex] === box;
              const color = getFieldColor(box.fieldId);

              const isHovered = hoveredBox === box.fieldId;

              return (
                <rect
                  key={`${box.page}:${box.fieldId}:${i}`}
                  x={xmin}
                  y={ymin}
                  width={xmax - xmin}
                  height={ymax - ymin}
                  fill={isActive ? `${color}12` : isHovered ? `${color}08` : "transparent"}
                  stroke={isActive ? color : isHovered ? `${color}60` : "transparent"}
                  strokeWidth={isActive ? 2 : isHovered ? 1.5 : 0}
                  rx="3"
                  ry="3"
                  style={{
                    cursor: "copy",
                    transition: "all 0.2s ease",
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    handleBoxCopy(box.text, box.label);
                  }}
                  onMouseEnter={() => setHoveredBox(box.fieldId)}
                  onMouseLeave={() => setHoveredBox(null)}
                />
              );
            })}
        </svg>

        {/* Loading overlay */}
        {(!imageLoaded || isPreviewPending) && !hasError && (
          <div
            className="absolute inset-0 flex flex-col items-center justify-center bg-white/5 backdrop-blur-sm z-10"
            style={{ minHeight: 500 }}
          >
            <div className="flex flex-col items-center gap-4">
              <div
                className="w-8 h-8 rounded-full border-2 border-t-transparent animate-spin"
                style={{ borderColor: "#10b981", borderTopColor: "transparent" }}
              />
              <div className="flex flex-col items-center gap-1">
                <span className="text-sm font-medium text-slate-700 dark:text-slate-200">
                  {isPreviewPending ? "Generating Preview..." : "Loading document..."}
                </span>
                {isPreviewPending && (
                  <span className="text-xs text-slate-500 dark:text-slate-400">
                    This may take a few seconds
                  </span>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Copied toast */}
        {copiedLabel && (
          <div
            className="absolute bottom-4 left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-lg text-xs font-medium text-white shadow-lg animate-in fade-in zoom-in-95 duration-200"
            style={{ backgroundColor: "#10b981", zIndex: 20 }}
          >
            Copied: {copiedLabel}
          </div>
        )}
      </div>
    </div>
  );
}

export default InteractiveDocumentViewer;
