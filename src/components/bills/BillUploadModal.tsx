/**
 * Bill Upload Modal — Simple file picker that kicks off background processing
 *
 * The modal immediately closes on file select. Processing (R2 upload + AI OCR)
 * happens in the background via the bill-upload-store module. Progress is shown
 * via BillUploadProgress floating card and toast notifications.
 */
import { useState, useCallback, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { listParties } from "../../routes/api/-parties";
import { listAccounts } from "../../routes/api/-accounts";
import { startBillUpload } from "../../lib/bill-upload-store";
import { Modal } from "../ui/Modal";

// ============================================================================
// Component
// ============================================================================

export function BillUploadModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

  // UI state
  const [dragOver, setDragOver] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // Data queries (needed for background processing context)
  const { data: vendors = [] } = useQuery({
    queryKey: ["parties"],
    queryFn: () =>
      (listParties as (opts: { data: unknown }) => Promise<any[]>)({
        data: {},
      }),
  });

  const { data: accounts = [] } = useQuery({
    queryKey: ["accounts"],
    queryFn: () =>
      (listAccounts as (opts: { data: unknown }) => Promise<any[]>)({
        data: {},
      }),
  });

  // ============================================================================
  // Handlers
  // ============================================================================

  const handleFile = useCallback(
    (file: File) => {
      setUploadError(null);
      const validTypes = ["application/pdf", "image/jpeg", "image/png", "image/webp"];
      if (!validTypes.includes(file.type)) {
        setUploadError("Please upload a PDF or image file (JPEG, PNG, WebP)");
        return;
      }
      if (file.size > 20 * 1024 * 1024) {
        setUploadError("File size must be under 20MB");
        return;
      }

      // Start background processing and close modal immediately
      startBillUpload(file, accounts, vendors, queryClient);
      onClose();
    },
    [accounts, vendors, queryClient, onClose],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const file = e.dataTransfer.files[0];
      if (file) handleFile(file);
    },
    [handleFile],
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
  }, []);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Upload Bill"
      description="Drop a PDF or image — AI will extract the details"
      mobile="fullscreen"
      size="md"
    >
      <div
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onClick={() => fileInputRef.current?.click()}
        className={`relative flex flex-col items-center justify-center gap-4 p-6 sm:p-10 rounded-xl border-2 border-dashed cursor-pointer transition-all duration-200 ${
          dragOver
            ? "border-emerald-400 bg-emerald-50 dark:bg-emerald-900/20 scale-[1.02]"
            : "border-slate-300 dark:border-white/20 hover:border-emerald-400 hover:bg-emerald-50/50 dark:hover:bg-emerald-900/10"
        }`}
      >
        {/* Cloud upload icon */}
        <div
          className={`w-16 h-16 rounded-2xl flex items-center justify-center transition-colors ${
            dragOver ? "bg-emerald-100 dark:bg-emerald-900/40" : "bg-slate-100 dark:bg-white/5"
          }`}
        >
          <svg
            width="32"
            height="32"
            viewBox="0 0 24 24"
            fill="none"
            className={`transition-colors ${
              dragOver ? "text-emerald-500" : "text-slate-400 dark:text-white/40"
            }`}
          >
            <path
              d="M12 16V8m0 0l-3 3m3-3l3 3"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="M20 16.7428C21.2215 15.734 22 14.2079 22 12.5C22 9.46243 19.5376 7 16.5 7C16.2815 7 16.0771 6.886 15.9661 6.69774C14.6621 4.48484 12.2544 3 9.5 3C5.35786 3 2 6.35786 2 10.5C2 12.5661 2.83545 14.4371 4.18695 15.7935"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>

        <div className="text-center">
          <p className="text-sm font-medium text-slate-700 dark:text-white">
            {dragOver ? "Drop file to upload" : "Drop bill here or click to browse"}
          </p>
          <p className="text-xs text-slate-400 dark:text-white/40 mt-1">
            PDF, JPEG, PNG, or WebP — up to 20MB
          </p>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf,image/jpeg,image/png,image/webp"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleFile(file);
            e.target.value = "";
          }}
        />
      </div>

      {/* Error */}
      {uploadError && (
        <div className="mt-3 flex items-center gap-2 px-3 py-2 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/40">
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            className="text-red-500 shrink-0"
          >
            <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" />
            <path
              d="M15 9l-6 6M9 9l6 6"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
          <span className="text-xs text-red-600 dark:text-red-400">{uploadError}</span>
        </div>
      )}
    </Modal>
  );
}
