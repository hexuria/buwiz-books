/**
 * ImportPanel — File upload, validation preview, and import execution
 */
import { useState, useRef, useCallback } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { validateImport, executeImport } from "../../routes/api/-export-import";
import type { EntityType } from "../../routes/api/-export-import";

// ============================================================================
// Constants
// ============================================================================

const ENTITY_OPTIONS: { value: EntityType; label: string }[] = [
  { value: "banks", label: "Banks & Cards" },
  { value: "vendors", label: "Vendors" },
  { value: "customers", label: "Customers" },
  { value: "employees", label: "Employees" },
  { value: "shareholders", label: "Shareholders" },
  { value: "lenders", label: "Lenders" },
  { value: "government", label: "Government" },
  { value: "categories", label: "Categories (COA)" },
  { value: "departments", label: "Departments" },
  { value: "locations", label: "Locations" },
  { value: "products", label: "Products & Services" },
];

type ImportStep = "select" | "validate" | "importing" | "done";

interface ValidationRow {
  row: number;
  valid: boolean;
  data?: Record<string, any>;
  errors?: string[];
}

interface ValidationResult {
  entityType: string;
  total: number;
  valid: number;
  invalid: number;
  rows: ValidationRow[];
}

interface ImportResult {
  imported: number;
  skipped: number;
  failed: number;
  results: Array<{ name: string; success: boolean; error?: string }>;
}

// ============================================================================
// Component
// ============================================================================

export function ImportPanel() {
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [step, setStep] = useState<ImportStep>("select");
  const [entityType, setEntityType] = useState<EntityType | "">("");
  const [fileName, setFileName] = useState("");
  const [fileContent, setFileContent] = useState("");
  const [format, setFormat] = useState<"json" | "csv">("json");
  const [validationResult, setValidationResult] = useState<ValidationResult | null>(null);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);

  // Validate mutation
  const validateMutation = useMutation({
    mutationFn: async ({
      entity,
      content,
      fmt,
    }: {
      entity: EntityType;
      content: string;
      fmt: "json" | "csv";
    }) => {
      return (validateImport as (opts: { data: unknown }) => Promise<ValidationResult>)({
        data: { entityType: entity, content, format: fmt },
      });
    },
    onSuccess: (data) => {
      setValidationResult(data);
      setStep("validate");
    },
  });

  // Execute mutation
  const executeMutation = useMutation({
    mutationFn: async ({ entity, rows }: { entity: EntityType; rows: Record<string, any>[] }) => {
      return (executeImport as (opts: { data: unknown }) => Promise<ImportResult>)({
        data: { entityType: entity, rows },
      });
    },
    onSuccess: (data) => {
      setImportResult(data);
      setStep("done");
      // Invalidate relevant queries
      if (entityType) {
        queryClient.invalidateQueries({ queryKey: ["exportable-records"] });
        const queryKeyMap: Record<string, string[]> = {
          banks: ["financial-accounts"],
          vendors: ["parties"],
          customers: ["parties"],
          employees: ["parties"],
          shareholders: ["parties"],
          lenders: ["parties"],
          government: ["parties"],
          categories: ["accounts"],
          departments: ["departments"],
          locations: ["locations"],
          products: ["products"],
        };
        const keys = queryKeyMap[entityType];
        if (keys) {
          for (const key of keys) {
            queryClient.invalidateQueries({ queryKey: [key] });
          }
        }
      }
    },
  });

  // File handling
  const processFile = useCallback(
    (file: File) => {
      setFileName(file.name);
      const detectedFormat = file.name.endsWith(".csv") ? "csv" : "json";
      setFormat(detectedFormat);

      const reader = new FileReader();
      reader.onload = (e) => {
        const content = e.target?.result as string;
        setFileContent(content);
        if (entityType) {
          validateMutation.mutate({
            entity: entityType as EntityType,
            content,
            fmt: detectedFormat,
          });
        }
      };
      reader.readAsText(file);
    },
    [entityType, validateMutation],
  );

  const handleFileDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragOver(false);
      const file = e.dataTransfer.files[0];
      if (file) processFile(file);
    },
    [processFile],
  );

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) processFile(file);
    },
    [processFile],
  );

  const handleImport = () => {
    if (!validationResult || !entityType) return;
    const validRows = validationResult.rows.filter((r) => r.valid && r.data).map((r) => r.data!);
    setStep("importing");
    executeMutation.mutate({ entity: entityType as EntityType, rows: validRows });
  };

  const reset = () => {
    setStep("select");
    setEntityType("");
    setFileName("");
    setFileContent("");
    setValidationResult(null);
    setImportResult(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  // ── Done view ───────────────────────────────────────────────────────────
  if (step === "done" && importResult) {
    return (
      <div className="space-y-5">
        <section className="bg-white dark:bg-[#1e293b] rounded-2xl border border-[#e2e8f0] dark:border-white/10 p-6 space-y-5">
          {/* Success header */}
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-[#f0fdfa] dark:bg-teal-900/30 flex items-center justify-center">
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="text-[#0d9488] dark:text-teal-400"
              >
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </div>
            <div>
              <h3 className="text-sm font-semibold text-[#1e293b] dark:text-white">
                Import Complete
              </h3>
              <p className="text-xs text-[#64748b] dark:text-white/50">
                {ENTITY_OPTIONS.find((o) => o.value === entityType)?.label}
              </p>
            </div>
          </div>

          {/* Stats */}
          <div className="grid grid-cols-3 gap-4">
            <div className="bg-[#f0fdfa] dark:bg-teal-900/20 rounded-xl px-4 py-3 text-center">
              <div className="text-2xl font-bold text-[#0d9488] dark:text-teal-400">
                {importResult.imported}
              </div>
              <div className="text-[10px] font-medium text-[#0d9488]/70 dark:text-teal-400/70 uppercase tracking-wider mt-0.5">
                Imported
              </div>
            </div>
            <div className="bg-[#fef3c7] dark:bg-amber-900/20 rounded-xl px-4 py-3 text-center">
              <div className="text-2xl font-bold text-[#92400e] dark:text-amber-300">
                {importResult.skipped}
              </div>
              <div className="text-[10px] font-medium text-[#92400e]/70 dark:text-amber-300/70 uppercase tracking-wider mt-0.5">
                Skipped
              </div>
            </div>
            <div className="bg-[#fef2f2] dark:bg-red-900/20 rounded-xl px-4 py-3 text-center">
              <div className="text-2xl font-bold text-[#991b1b] dark:text-red-300">
                {importResult.failed}
              </div>
              <div className="text-[10px] font-medium text-[#991b1b]/70 dark:text-red-300/70 uppercase tracking-wider mt-0.5">
                Failed
              </div>
            </div>
          </div>

          {/* Details (collapsible) */}
          {importResult.results.length > 0 && (
            <details className="group">
              <summary className="text-xs font-medium text-[#64748b] dark:text-white/50 cursor-pointer hover:text-[#1e293b] dark:hover:text-white transition-colors">
                View details ({importResult.results.length} records)
              </summary>
              <div className="mt-3 max-h-[300px] overflow-y-auto space-y-1 pr-1">
                {importResult.results.map((r) => (
                  <div
                    key={r.name}
                    className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs"
                  >
                    {r.success ? (
                      <span
                        className={`w-4 h-4 flex items-center justify-center rounded-full ${
                          r.error?.includes("skipped")
                            ? "bg-[#fef3c7] dark:bg-amber-900/20 text-[#92400e] dark:text-amber-300"
                            : "bg-[#f0fdfa] dark:bg-teal-900/20 text-[#0d9488] dark:text-teal-400"
                        }`}
                      >
                        {r.error?.includes("skipped") ? "~" : "\u2713"}
                      </span>
                    ) : (
                      <span className="w-4 h-4 flex items-center justify-center rounded-full bg-[#fef2f2] dark:bg-red-900/20 text-[#991b1b] dark:text-red-300">
                        \u2717
                      </span>
                    )}
                    <span className="font-medium text-[#1e293b] dark:text-white truncate flex-1">
                      {r.name}
                    </span>
                    {r.error && (
                      <span className="text-[#94a3b8] dark:text-white/40 truncate max-w-[200px]">
                        {r.error}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </details>
          )}

          {/* Actions */}
          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={reset}
              className="px-4 py-2 rounded-lg bg-[#0d9488] hover:bg-[#0f766e] text-white text-sm font-medium transition-all"
            >
              Import More
            </button>
            <button
              type="button"
              onClick={reset}
              className="px-4 py-2 rounded-lg border border-[#e2e8f0] dark:border-white/10 text-sm font-medium text-[#64748b] hover:bg-[#f1f5f9] dark:hover:bg-white/5 transition-all"
            >
              Done
            </button>
          </div>
        </section>
      </div>
    );
  }

  // ── Validation preview view ──────────────────────────────────────────────
  if (step === "validate" && validationResult) {
    return (
      <div className="space-y-5">
        <section className="bg-white dark:bg-[#1e293b] rounded-2xl border border-[#e2e8f0] dark:border-white/10 p-6 space-y-5">
          <h3 className="text-sm font-semibold text-[#1e293b] dark:text-white flex items-center gap-2">
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="text-[#0d9488]"
            >
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="16" y1="13" x2="8" y2="13" />
              <line x1="16" y1="17" x2="8" y2="17" />
              <polyline points="10 9 9 9 8 9" />
            </svg>
            Import Preview &mdash; {ENTITY_OPTIONS.find((o) => o.value === entityType)?.label}
          </h3>

          {/* Summary callout */}
          <div className="flex items-start gap-3 px-4 py-3 rounded-lg bg-[#f0fdfa] dark:bg-teal-900/20 border border-[#99f6e4] dark:border-teal-700/40">
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="text-[#0d9488] dark:text-teal-400 mt-0.5 shrink-0"
            >
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="16" x2="12" y2="12" />
              <line x1="12" y1="8" x2="12.01" y2="8" />
            </svg>
            <p className="text-xs text-[#0d9488] dark:text-teal-300">
              Found <strong>{validationResult.total}</strong> records.{" "}
              <strong>{validationResult.valid}</strong> valid,{" "}
              <strong>{validationResult.invalid}</strong> invalid.
              {fileName && (
                <span className="text-[#0d9488]/60 dark:text-teal-300/60 ml-1">({fileName})</span>
              )}
            </p>
          </div>

          {/* Row-by-row validation */}
          <div className="max-h-[400px] overflow-y-auto space-y-1 pr-1">
            {validationResult.rows.map((row) => (
              <div
                key={`row-${row.row}`}
                className={`flex items-start gap-2 px-3 py-2 rounded-lg text-xs ${
                  row.valid
                    ? "bg-[#f8fafc] dark:bg-white/[0.02]"
                    : "bg-[#fef2f2] dark:bg-red-900/10"
                }`}
              >
                {row.valid ? (
                  <span className="w-4 h-4 flex items-center justify-center rounded-full bg-[#f0fdfa] dark:bg-teal-900/20 text-[#0d9488] dark:text-teal-400 shrink-0 mt-0.5">
                    {"\u2713"}
                  </span>
                ) : (
                  <span className="w-4 h-4 flex items-center justify-center rounded-full bg-[#fef2f2] dark:bg-red-900/20 text-[#ef4444] dark:text-red-400 shrink-0 mt-0.5">
                    {"\u2717"}
                  </span>
                )}
                <div className="flex-1 min-w-0">
                  <span className="font-medium text-[#1e293b] dark:text-white">
                    Row {row.row}
                    {row.data &&
                      (row.data.name || row.data.accountName) &&
                      `: ${row.data.name || row.data.accountName}`}
                  </span>
                  {row.errors && (
                    <div className="mt-0.5 text-[#ef4444] dark:text-red-400">
                      {row.errors.join("; ")}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* Actions */}
          <div className="flex items-center justify-between pt-2">
            <button
              type="button"
              onClick={reset}
              className="px-4 py-2 rounded-lg border border-[#e2e8f0] dark:border-white/10 text-sm font-medium text-[#64748b] hover:bg-[#f1f5f9] dark:hover:bg-white/5 transition-all"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleImport}
              disabled={validationResult.valid === 0 || executeMutation.isPending}
              className="px-5 py-2.5 rounded-lg bg-[#0d9488] hover:bg-[#0f766e] disabled:opacity-40 text-white text-sm font-medium transition-all flex items-center gap-2"
            >
              {executeMutation.isPending ? (
                <>
                  <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                      fill="none"
                    />
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                    />
                  </svg>
                  Importing...
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
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="17 8 12 3 7 8" />
                    <line x1="12" y1="3" x2="12" y2="15" />
                  </svg>
                  Import {validationResult.valid} Valid Record
                  {validationResult.valid !== 1 ? "s" : ""}
                </>
              )}
            </button>
          </div>
        </section>
      </div>
    );
  }

  // ── Select / Upload view ─────────────────────────────────────────────────
  return (
    <div className="space-y-5">
      <section className="bg-white dark:bg-[#1e293b] rounded-2xl border border-[#e2e8f0] dark:border-white/10 p-6 space-y-5">
        <h3 className="text-sm font-semibold text-[#1e293b] dark:text-white flex items-center gap-2">
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="text-[#0d9488]"
          >
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="17 8 12 3 7 8" />
            <line x1="12" y1="3" x2="12" y2="15" />
          </svg>
          Import Data
        </h3>

        {/* Info callout */}
        <div className="flex items-start gap-3 px-4 py-3 rounded-lg bg-[#f0fdfa] dark:bg-teal-900/20 border border-[#99f6e4] dark:border-teal-700/40">
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="text-[#0d9488] dark:text-teal-400 mt-0.5 shrink-0"
          >
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="16" x2="12" y2="12" />
            <line x1="12" y1="8" x2="12.01" y2="8" />
          </svg>
          <p className="text-xs text-[#0d9488] dark:text-teal-300">
            Upload a previously exported JSON or CSV file to import records. Duplicate records
            (matching by name) will be automatically skipped.
          </p>
        </div>

        {/* Entity type selector */}
        <div>
          <label className="block text-xs font-medium text-[#64748b] dark:text-white/50 mb-1.5">
            Entity Type
          </label>
          <select
            value={entityType}
            onChange={(e) => {
              setEntityType(e.target.value as EntityType);
              // Re-validate if file already loaded
              if (fileContent && e.target.value) {
                validateMutation.mutate({
                  entity: e.target.value as EntityType,
                  content: fileContent,
                  fmt: format,
                });
              }
            }}
            className="w-full px-4 py-2.5 rounded-lg border border-[#e2e8f0] dark:border-white/10 bg-white dark:bg-[#111827] text-base sm:text-sm text-[#1e293b] dark:text-white focus:outline-none focus:ring-2 focus:ring-[#0d9488]/30 focus:border-[#0d9488] transition-all"
          >
            <option value="">Select entity type...</option>
            {ENTITY_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        {/* Drop zone */}
        <div
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              fileInputRef.current?.click();
            }
          }}
          onDragOver={(e) => {
            e.preventDefault();
            setIsDragOver(true);
          }}
          onDragLeave={() => setIsDragOver(false)}
          onDrop={handleFileDrop}
          onClick={() => fileInputRef.current?.click()}
          className={`relative border-2 border-dashed rounded-xl px-6 py-10 text-center cursor-pointer transition-all ${
            isDragOver
              ? "border-[#0d9488] bg-[#f0fdfa] dark:bg-teal-900/20"
              : "border-[#e2e8f0] dark:border-white/10 hover:border-[#0d9488]/50 hover:bg-[#f8fafc] dark:hover:bg-white/[0.02]"
          }`}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,.csv"
            onChange={handleFileSelect}
            className="hidden"
          />

          <svg
            width="32"
            height="32"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="mx-auto text-[#94a3b8] dark:text-white/30 mb-3"
          >
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
          </svg>

          <p className="text-sm font-medium text-[#1e293b] dark:text-white">
            {isDragOver ? "Drop file here" : "Drop file here or click to upload"}
          </p>
          <p className="text-xs text-[#94a3b8] dark:text-white/40 mt-1">
            Accepts .json or .csv files
          </p>

          {fileName && (
            <div className="mt-3 inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-[#f0fdfa] dark:bg-teal-900/20 border border-[#99f6e4] dark:border-teal-700/40">
              <span className="text-xs font-medium text-[#0d9488] dark:text-teal-400">
                {fileName}
              </span>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setFileName("");
                  setFileContent("");
                  setValidationResult(null);
                  if (fileInputRef.current) fileInputRef.current.value = "";
                }}
                className="w-4 h-4 flex items-center justify-center rounded-full text-[#0d9488]/60 hover:text-[#0d9488] transition-colors"
              >
                <svg
                  width="10"
                  height="10"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
          )}
        </div>

        {/* Validation error */}
        {validateMutation.isError && (
          <div className="text-xs text-[#ef4444] dark:text-red-400 font-medium">
            Failed to validate file. Please check the format and try again.
          </div>
        )}

        {/* Loading state */}
        {validateMutation.isPending && (
          <div className="flex items-center gap-2 text-xs text-[#64748b] dark:text-white/50">
            <svg className="animate-spin h-4 w-4 text-[#0d9488]" viewBox="0 0 24 24">
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
                fill="none"
              />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
              />
            </svg>
            Validating file...
          </div>
        )}
      </section>
    </div>
  );
}
