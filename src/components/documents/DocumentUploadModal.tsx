/**
 * Document Upload Modal — Drag & drop or browse to upload documents
 */
import { useState, useCallback, useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { uploadDocument } from "../../routes/api/-documents";
import { createLogger } from "../../lib/logger";
import { Modal } from "../ui/Modal";
const logger = createLogger("ui.document-upload");

type UploadStep = "select" | "uploading" | "done";

export function DocumentUploadModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [step, setStep] = useState<UploadStep>("select");
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form state
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [displayTitle, setDisplayTitle] = useState("");

  // Upload progress
  const [uploadProgress, setUploadProgress] = useState({ current: 0, total: 0 });

  // Upload mutation
  const uploadMutation = useMutation({
    mutationFn: (data: {
      filename: string;
      contentType: string;
      fileBase64: string;
      documentType?: string;
      displayTitle?: string;
      intakeMode: "standalone";
    }) =>
      (uploadDocument as (opts: { data: unknown }) => Promise<any>)({
        data,
      }),
    // We handle success/error manually in the loop
  });

  function resetAndClose() {
    setStep("select");
    setError(null);
    setDisplayTitle("");

    setSelectedFiles([]);
    setUploadProgress({ current: 0, total: 0 });
    onClose();
  }

  const handleFiles = useCallback(
    (files: FileList | File[]) => {
      setError(null);
      const newFiles: File[] = [];

      // Convert FileList to array if needed
      const fileArray = files instanceof FileList ? Array.from(files) : files;

      for (const file of fileArray) {
        if (file.size > 50 * 1024 * 1024) {
          setError("One or more files exceed the 50MB limit");
          continue;
        }
        newFiles.push(file);
      }

      if (newFiles.length > 0) {
        setSelectedFiles((prev) => [...prev, ...newFiles]);
        // If it's the first file added, perform any single-file setup if needed
        if (selectedFiles.length === 0 && newFiles.length === 1) {
          setDisplayTitle(newFiles[0].name.replace(/\.[^.]+$/, ""));
        } else {
          // Clear display title for multi-file as we'll use filenames
          setDisplayTitle("");
        }
      }
    },
    [selectedFiles.length],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        handleFiles(e.dataTransfer.files);
      }
    },
    [handleFiles],
  );

  const removeFile = useCallback((index: number) => {
    setSelectedFiles((prev) => prev.filter((_, i) => i !== index));
  }, []);

  async function handleUpload() {
    if (selectedFiles.length === 0) return;

    setStep("uploading");
    setError(null);
    setUploadProgress({ current: 0, total: selectedFiles.length });

    let successCount = 0;
    const errors: string[] = [];

    // Process files sequentially
    for (let i = 0; i < selectedFiles.length; i++) {
      const file = selectedFiles[i];
      setUploadProgress({ current: i + 1, total: selectedFiles.length });

      try {
        const base64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => {
            const res = (reader.result as string).split(",")[1];
            resolve(res);
          };
          reader.onerror = () => reject(new Error("Failed to read file"));
          reader.readAsDataURL(file);
        });

        await uploadMutation.mutateAsync({
          filename: file.name,
          contentType: file.type || "application/octet-stream",
          fileBase64: base64,
          documentType: "other",
          intakeMode: "standalone",
          // Only use custom display title if uploading a single file and the user set it
          displayTitle: selectedFiles.length === 1 && displayTitle ? displayTitle : undefined,
        });

        successCount++;
      } catch (err: unknown) {
        const errMessage = err instanceof Error ? err.message : String(err);
        logger.error("Failed to upload file", { fileName: file.name, error: err });
        errors.push(`${file.name}: ${errMessage || "Upload failed"}`);
      }
    }

    // Refresh regardless of partial success
    if (successCount > 0) {
      queryClient.invalidateQueries({ queryKey: ["documents"] });
    }

    if (errors.length > 0) {
      setError(`Failed to upload ${errors.length} file(s). ${successCount} succeeded.`);
      setStep("select");
      // Keep the failed files in the list? For simplicity, we clear all for now or keep all.
      // Let's clear for now to match resetAndClose behavior on success,
      // but strictly we might want to keep failed ones.
      // User experience: if some fail, showing an error and resetting is acceptable for now.
    } else {
      resetAndClose();
    }
  }

  return (
    <Modal
      open={open}
      onClose={resetAndClose}
      title="Upload Document"
      mobile="fullscreen"
      size="md"
      footer={
        step === "select" && selectedFiles.length > 0 ? (
          <>
            <button
              type="button"
              onClick={resetAndClose}
              className="h-11 px-4 rounded-lg text-sm font-medium text-[#64748b] dark:text-white/50 hover:bg-[#f1f5f9] dark:hover:bg-white/5 transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleUpload}
              className="h-11 px-5 rounded-lg bg-gradient-to-r from-[#10b981] to-[#059669] text-white text-sm font-medium shadow-sm hover:shadow-md transition-all"
            >
              Upload {selectedFiles.length > 1 ? `(${selectedFiles.length})` : ""}
            </button>
          </>
        ) : undefined
      }
    >
      {step === "uploading" ? (
        <div className="flex flex-col items-center justify-center py-12">
          <div className="relative w-14 h-14 mb-4">
            <div className="absolute inset-0 rounded-full border-4 border-[#e2e8f0] dark:border-white/10" />
            <div className="absolute inset-0 rounded-full border-4 border-transparent border-t-[#10b981] animate-spin" />
          </div>
          <p className="text-sm font-medium text-[#1e293b] dark:text-white">
            Uploading {uploadProgress.current} of {uploadProgress.total}…
          </p>
          <p className="text-xs text-[#94a3b8] dark:text-white/40 mt-1">
            Please wait while we process your documents.
          </p>
        </div>
      ) : (
        <>
          {selectedFiles.length === 0 ? (
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleDrop}
              className={`flex flex-col items-center justify-center border-2 border-dashed rounded-xl py-10 px-6 sm:py-14 sm:px-8 transition-colors cursor-pointer ${
                dragOver
                  ? "border-[#10b981] bg-[#10b981]/5"
                  : "border-[#e2e8f0] dark:border-white/10 hover:border-[#94a3b8] dark:hover:border-white/20"
              }`}
              onClick={() => fileInputRef.current?.click()}
              onKeyDown={(e) => {
                if (e.key === "Enter") fileInputRef.current?.click();
              }}
              role="button"
              tabIndex={0}
            >
              <div className="w-14 h-14 rounded-2xl bg-[#10b981]/10 flex items-center justify-center mb-3">
                <svg
                  width="24"
                  height="24"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="#10b981"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="17 8 12 3 7 8" />
                  <line x1="12" y1="3" x2="12" y2="15" />
                </svg>
              </div>
              <p className="text-sm font-medium text-[#1e293b] dark:text-white mb-0.5 text-center">
                Drop your documents here, or <span className="text-[#10b981]">browse</span>
              </p>
              <p className="text-xs text-[#94a3b8] dark:text-white/40 text-center">
                PDF, Images, Spreadsheets, Documents (max 50MB)
              </p>
              <input
                ref={fileInputRef}
                type="file"
                multiple // Enable multiple files
                accept=".pdf,.jpg,.jpeg,.png,.gif,.webp,.xlsx,.xls,.csv,.doc,.docx,.zip"
                onChange={(e) => {
                  if (e.target.files && e.target.files.length > 0) {
                    handleFiles(e.target.files);
                  }
                }}
                className="hidden"
              />
            </div>
          ) : (
            <>
              {/* File List */}
              <div className="space-y-2 mb-4 max-h-[240px] overflow-y-auto">
                {selectedFiles.map((file, idx) => (
                  <div
                    key={`${file.name}-${idx}`}
                    className="flex items-center gap-3 px-4 py-3 rounded-lg bg-[#f0fdf4] dark:bg-emerald-900/20 border border-[#bbf7d0] dark:border-emerald-800/40"
                  >
                    <FileTypeIcon fileType={getFileType(file.name)} size={20} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-[#1e293b] dark:text-white truncate">
                        {file.name}
                      </p>
                      <p className="text-xs text-[#94a3b8] dark:text-white/40">
                        {formatFileSize(file.size)}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => removeFile(idx)}
                      aria-label={`Remove ${file.name}`}
                      className="touch-target p-1 rounded text-[#94a3b8] hover:text-[#ef4444] transition-colors"
                    >
                      <svg
                        width="16"
                        height="16"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                      >
                        <line x1="18" y1="6" x2="6" y2="18" />
                        <line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                    </button>
                  </div>
                ))}
              </div>

              {/* Add more button */}
              <div className="flex justify-start mb-4">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="touch-target text-sm font-medium text-[#10b981] hover:underline flex items-center gap-1"
                >
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <line x1="12" y1="5" x2="12" y2="19" />
                    <line x1="5" y1="12" x2="19" y2="12" />
                  </svg>
                  Add more files
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept=".pdf,.jpg,.jpeg,.png,.gif,.webp,.xlsx,.xls,.csv,.doc,.docx,.zip"
                  onChange={(e) => {
                    if (e.target.files && e.target.files.length > 0) {
                      handleFiles(e.target.files);
                    }
                    // Reset input value to allow selecting same file again if needed (though rare for add more)
                    if (fileInputRef.current) fileInputRef.current.value = "";
                  }}
                  className="hidden"
                />
              </div>

              {/* Title (Only for single file) */}
              {selectedFiles.length === 1 && (
                <div className="mb-3">
                  <label className="block text-[11px] font-medium text-[#94a3b8] dark:text-white/40 uppercase tracking-wider mb-1.5">
                    Display Title
                  </label>
                  <input
                    type="text"
                    value={displayTitle}
                    onChange={(e) => setDisplayTitle(e.target.value)}
                    placeholder="Document title..."
                    className="w-full h-11 px-3 rounded-lg border border-[#e2e8f0] dark:border-white/10 bg-white dark:bg-[#0f172a] text-base sm:text-sm text-[#1e293b] dark:text-white placeholder:text-[#94a3b8] focus:outline-none focus:ring-2 focus:ring-[#10b981]/20 focus:border-[#10b981]"
                  />
                </div>
              )}
            </>
          )}

          {error && (
            <div className="mt-4 px-4 py-3 rounded-lg bg-[#fef2f2] dark:bg-red-900/20 border border-[#fecaca] dark:border-red-800/40">
              <p className="text-sm text-[#dc2626] dark:text-red-300">{error}</p>
            </div>
          )}
        </>
      )}
    </Modal>
  );
}

// ============================================================================
// Helpers
// ============================================================================

function getFileType(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  return ext;
}

export function formatFileSize(bytes: number | null | undefined): string {
  if (!bytes) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function FileTypeIcon({ fileType, size = 24 }: { fileType: string; size?: number }) {
  const ext = fileType.toLowerCase();

  // Color mapping
  let color = "#94a3b8";
  let label = ext.toUpperCase() || "FILE";
  if (ext === "pdf") {
    color = "#ef4444";
    label = "PDF";
  } else if (["xlsx", "xls", "csv"].includes(ext)) {
    color = "#10b981";
    label = ext.toUpperCase();
  } else if (["jpg", "jpeg", "png", "gif", "webp"].includes(ext)) {
    color = "#3b82f6";
    label = "IMG";
  } else if (["doc", "docx"].includes(ext)) {
    color = "#2563eb";
    label = "DOC";
  } else if (ext === "zip") {
    color = "#f59e0b";
    label = "ZIP";
  }

  const fontSize = Math.max(6, size * 0.32);

  return (
    <div
      style={{
        width: size,
        height: size,
        backgroundColor: `${color}15`,
        borderRadius: size * 0.2,
      }}
      className="flex items-center justify-center flex-shrink-0"
    >
      <span
        style={{
          fontSize,
          color,
          fontWeight: 700,
          letterSpacing: "0.02em",
        }}
      >
        {label}
      </span>
    </div>
  );
}

export function getDocumentTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    statement: "Statement",
    bill: "Bill",
    invoice: "Invoice",
    receipt: "Receipt",
    payslip: "Payslip",
    contract: "Contract",
    tax_form: "Tax Form",
    other: "Other",
  };
  return labels[type] || type;
}
