/**
 * Import Bank Transactions — 4-Step Wizard
 * Step 1: Select Account & Category + Upload CSV
 * Step 2: Map Column Headers
 * Step 3: Review & Correct (full-screen table)
 * Step 4: Import (progress + completion)
 */
import React, { useCallback, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  validateBankTransactionCsv,
  importBankTransactions,
} from "../../routes/api/-transactions-import";
import type { ValidatedBankRow } from "../../routes/api/-transactions-import";
import { listAccounts, type AccountWithChildren } from "../../routes/api/-accounts";
import Combobox from "../ui/Combobox";
import { CustomSelect } from "../ui/CustomSelect";
import { Modal } from "../ui/Modal";
import { keys } from "../../lib/query-keys";
import { callServerFn } from "../../lib/server-fn-client";

// ============================================================================
// Types
// ============================================================================

interface ImportBankTransactionsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

type WizardStep = "upload" | "map" | "review" | "importing" | "complete";
type ReviewTab = "all" | "valid" | "invalid";

interface ColumnMapping {
  date: string;
  amount: string;
  description: string;
  department: string;
  location: string;
}

interface EditableRow {
  row: number;
  valid: boolean;
  selected: boolean;
  date: string;
  amount: string;
  description: string;
  department: string;
  location: string;
  errors?: string[];
  /** track if user manually edited this row */
  edited: boolean;
}

// ============================================================================
// Constants
// ============================================================================

const DATE_FORMATS = [
  { value: "MM/DD/YYYY", label: "MM/DD/YYYY" },
  { value: "M/D/YYYY", label: "M/D/YYYY" },
  { value: "MM/DD/YY", label: "MM/DD/YY" },
  { value: "M/D/YY", label: "M/D/YY" },
  { value: "YYYY/MM/DD", label: "YYYY/MM/DD" },
  { value: "YYYY/M/D", label: "YYYY/M/D" },
];

const SIGNAGE_OPTIONS = [
  { value: "positive", label: "Positive" },
  { value: "negative", label: "Negative" },
];

const FIELD_LABELS: Record<string, string> = {
  date: "Date",
  amount: "Amount",
  description: "Description",
  department: "Department",
  location: "Location",
};

// ============================================================================
// CSV Parse Utility (client-side, for column detection)
// ============================================================================

function parseCsvClient(content: string): { headers: string[]; rows: Record<string, string>[] } {
  const lines = content
    .split("\n")
    .map((l) => l.replace(/\r$/, ""))
    .filter((l) => l.trim());
  if (lines.length === 0) return { headers: [], rows: [] };

  const parseRow = (line: string): string[] => {
    const result: string[] = [];
    let current = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"' && line[i + 1] === '"') {
          current += '"';
          i++;
        } else if (ch === '"') {
          inQuotes = false;
        } else {
          current += ch;
        }
      } else if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        result.push(current.trim());
        current = "";
      } else {
        current += ch;
      }
    }
    result.push(current.trim());
    return result;
  };

  const headers = parseRow(lines[0]);
  const rows: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = parseRow(lines[i]);
    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = vals[j] ?? "";
    }
    rows.push(row);
  }
  return { headers, rows };
}

function autoDetectMapping(headers: string[]): ColumnMapping {
  const lower = headers.map((h) => h.toLowerCase().trim());
  const find = (candidates: string[]): string => {
    for (const c of candidates) {
      const idx = lower.findIndex((h) => h === c || h.includes(c));
      if (idx !== -1) return headers[idx];
    }
    return "";
  };
  return {
    date: find(["date", "transaction date", "txn date", "posting date"]),
    amount: find(["amount", "total", "value", "sum"]),
    description: find(["description", "memo", "narrative", "details", "payee", "name"]),
    department: find(["department", "dept", "division"]),
    location: find(["location", "branch", "office", "site"]),
  };
}

// ============================================================================
// Sub-Components
// ============================================================================

/** Step indicator bar */
const StepIndicator: React.FC<{ step: WizardStep }> = ({ step }) => {
  const steps = [
    { key: "upload", label: "Upload", num: 1 },
    { key: "map", label: "Map Columns", num: 2 },
    { key: "review", label: "Review", num: 3 },
  ] as const;

  const currentIdx = step === "upload" ? 0 : step === "map" ? 1 : step === "review" ? 2 : 3;

  return (
    // Bleeds past the modal body's gutter so the rule spans the full dialog width.
    <div className="-mx-4 -mt-4 mb-4 flex items-center gap-1 border-b border-[#e5e7eb] bg-[#f9fafb] px-4 py-3 dark:border-slate-700 dark:bg-slate-800/50">
      {steps.map((s, idx) => {
        const isDone = idx < currentIdx;
        const isCurrent = idx === currentIdx;
        return (
          <React.Fragment key={s.key}>
            {idx > 0 && (
              <div
                className={`flex-1 h-px mx-1 ${isDone ? "bg-teal-500" : "bg-[#e5e7eb] dark:bg-slate-700"}`}
              />
            )}
            <div className="flex items-center gap-1.5">
              <div
                className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold transition-colors ${
                  isDone
                    ? "bg-teal-500 text-white"
                    : isCurrent
                      ? "bg-teal-500/20 text-teal-600 dark:text-teal-400 ring-2 ring-teal-500"
                      : "bg-[#e5e7eb] dark:bg-slate-700 text-[#9ca3af] dark:text-slate-500"
                }`}
              >
                {isDone ? (
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="3"
                  >
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                ) : (
                  s.num
                )}
              </div>
              <span
                className={`text-xs font-medium hidden sm:inline ${
                  isCurrent
                    ? "text-teal-600 dark:text-teal-400"
                    : isDone
                      ? "text-[#374151] dark:text-slate-300"
                      : "text-[#9ca3af] dark:text-slate-500"
                }`}
              >
                {s.label}
              </span>
            </div>
          </React.Fragment>
        );
      })}
    </div>
  );
};

/** Tab bar for the review step */
const ReviewTabs: React.FC<{
  active: ReviewTab;
  counts: { all: number; valid: number; invalid: number };
  onChange: (tab: ReviewTab) => void;
}> = ({ active, counts, onChange }) => {
  const tabs: { key: ReviewTab; label: string; count: number }[] = [
    { key: "all", label: "All", count: counts.all },
    { key: "valid", label: "Valid", count: counts.valid },
    { key: "invalid", label: "Invalid", count: counts.invalid },
  ];
  return (
    <div className="flex items-center gap-1 border-b border-[#e5e7eb] dark:border-slate-700">
      {tabs.map((t) => (
        <button
          key={t.key}
          type="button"
          onClick={() => onChange(t.key)}
          className={`min-h-11 px-4 py-2.5 text-sm font-semibold transition-colors border-b-2 ${
            active === t.key
              ? "border-teal-500 text-teal-600 dark:text-teal-400"
              : "border-transparent text-[#6b7280] dark:text-slate-500 hover:text-[#374151] dark:hover:text-slate-300"
          }`}
        >
          {t.label}
          <span
            className={`ml-1.5 px-1.5 py-0.5 rounded-full text-xs font-bold ${
              active === t.key
                ? "bg-teal-500/15 text-teal-600 dark:text-teal-400"
                : "bg-[#e5e7eb] dark:bg-slate-700 text-[#9ca3af] dark:text-slate-500"
            }`}
          >
            {t.count}
          </span>
        </button>
      ))}
    </div>
  );
};

// ============================================================================
// Main Component
// ============================================================================

export const ImportBankTransactionsModal: React.FC<ImportBankTransactionsModalProps> = ({
  isOpen,
  onClose,
}) => {
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── Wizard State ──
  const [step, setStep] = useState<WizardStep>("upload");

  // Step 1 state — category IS the bank account (they're already mapped)
  const [selectedCategory, setSelectedCategory] = useState<string>("");
  const [csvContent, setCsvContent] = useState<string>("");
  const [fileHash, setFileHash] = useState<string>("");
  const [fileName, setFileName] = useState<string>("");

  // Step 2 state
  const [csvHeaders, setCsvHeaders] = useState<string[]>([]);
  const [csvRows, setCsvRows] = useState<Record<string, string>[]>([]);
  const [columnMapping, setColumnMapping] = useState<ColumnMapping>({
    date: "",
    amount: "",
    description: "",
    department: "",
    location: "",
  });
  const [dateFormat, setDateFormat] = useState<string>("MM/DD/YYYY");
  const [signage, setSignage] = useState<string>("positive");

  // Step 3 state
  const [reviewRows, setReviewRows] = useState<EditableRow[]>([]);
  const [reviewTab, setReviewTab] = useState<ReviewTab>("all");
  const [editingCell, setEditingCell] = useState<{ row: number; field: string } | null>(null);

  // Step 4 state
  const [importResult, setImportResult] = useState<{
    imported: number;
    failed: number;
    total: number;
  } | null>(null);

  // ── Queries ──
  const { data: bankAccounts = [] } = useQuery({
    queryKey: ["accounts", "bank-credit-card"],
    queryFn: () =>
      callServerFn(listAccounts, {
        data: {
          types: ["asset", "liability"],
          subtypes: ["bank_accounts", "credit_cards"],
          status: ["active"],
        },
      }),
    enabled: isOpen,
  });

  // ── Derived data ──
  // Categories ARE bank accounts — show actual accounts from the system
  const categoryOptions = useMemo(
    () =>
      bankAccounts.map((acc: AccountWithChildren) => ({
        value: acc.id,
        label: acc.accountNumber ? `${acc.accountNumber} — ${acc.name}` : acc.name,
        icon: (
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            className="text-slate-400"
          >
            <rect x="2" y="4" width="20" height="16" rx="2" />
            <path d="M2 10h20" />
          </svg>
        ),
      })),
    [bankAccounts],
  );

  const headerOptions = useMemo(
    () => [{ value: "", label: "— Skip —" }, ...csvHeaders.map((h) => ({ value: h, label: h }))],
    [csvHeaders],
  );

  const reviewCounts = useMemo(() => {
    const all = reviewRows.length;
    const valid = reviewRows.filter((r) => r.valid).length;
    const invalid = all - valid;
    return { all, valid, invalid };
  }, [reviewRows]);

  const filteredReviewRows = useMemo(() => {
    if (reviewTab === "valid") return reviewRows.filter((r) => r.valid);
    if (reviewTab === "invalid") return reviewRows.filter((r) => !r.valid);
    return reviewRows;
  }, [reviewRows, reviewTab]);

  const selectedValidCount = useMemo(
    () => reviewRows.filter((r) => r.selected && r.valid).length,
    [reviewRows],
  );

  // ── File Handling ──
  const handleFileDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file && file.name.endsWith(".csv")) {
      setFileName(file.name);
      const reader = new FileReader();
      reader.onload = (event) => {
        setCsvContent(event.target?.result as string);
      };
      reader.readAsText(file);
    }
  }, []);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setFileName(file.name);
      const reader = new FileReader();
      reader.onload = (event) => {
        setCsvContent(event.target?.result as string);
      };
      reader.readAsText(file);
    }
  }, []);

  const downloadTemplate = useCallback(() => {
    const header = "Date,Amount,Description,Department,Location";
    const example = "01/15/2026,1500.00,Client Payment,Sales,Main Office";
    const csv = `${header}\n${example}\n`;
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "Bank_Feed_Import_Template.csv";
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  // ── Step Transitions ──
  const goToMapStep = useCallback(() => {
    const { headers, rows } = parseCsvClient(csvContent);
    setCsvHeaders(headers);
    setCsvRows(rows);
    setColumnMapping(autoDetectMapping(headers));
    setStep("map");
  }, [csvContent]);

  // Validate mutation (reuses server validation)
  const validateMutation = useMutation({
    mutationFn: async (mappedContent: string) =>
      callServerFn(validateBankTransactionCsv, {
        data: { content: mappedContent, sourceContent: csvContent },
      }),
    onSuccess: (result) => {
      const vr = result as {
        fileHash: string;
        total: number;
        valid: number;
        invalid: number;
        rows: ValidatedBankRow[];
      };
      setFileHash(vr.fileHash);
      // Build editable rows from validation result
      const editable: EditableRow[] = vr.rows.map((r) => ({
        row: r.row,
        valid: r.valid,
        selected: r.valid, // auto-select valid rows
        date: r.data?.date ?? "",
        amount: r.data?.amount ?? "",
        description: r.data?.description ?? "",
        department: r.data?.department ?? "",
        location: r.data?.location ?? "",
        errors: r.errors,
        edited: false,
      }));
      setReviewRows(editable);
      setReviewTab("all");
      setStep("review");
    },
  });

  const handleValidate = useCallback(() => {
    // Re-map CSV using column mapping and rebuild CSV content for the server
    const mappedHeader = "Date,Amount,Description,Department,Location";
    const mappedRows = csvRows.map((row) => {
      let amount = row[columnMapping.amount] ?? "";

      // Apply signage: if "negative", flip the sign
      if (signage === "negative" && amount) {
        const num = Number.parseFloat(amount.replace(/[^0-9.-]/g, ""));
        if (!Number.isNaN(num)) {
          amount = String(-num);
        }
      }

      const fields = [
        row[columnMapping.date] ?? "",
        amount,
        `"${(row[columnMapping.description] ?? "").replace(/"/g, '""')}"`,
        row[columnMapping.department] ?? "",
        row[columnMapping.location] ?? "",
      ];
      return fields.join(",");
    });
    const content = `${mappedHeader}\n${mappedRows.join("\n")}`;
    validateMutation.mutate(content);
  }, [csvRows, columnMapping, signage, validateMutation]);

  // Import mutation
  const importMutation = useMutation({
    mutationFn: async (rows: EditableRow[]) => {
      const validRows = rows
        .filter((r) => r.selected && r.valid)
        .map((r) => ({
          sourceRow: r.row,
          date: r.date,
          amount: r.amount,
          description: r.description,
          department: r.department,
          location: r.location,
        }));
      return callServerFn(importBankTransactions, {
        data: { accountId: selectedCategory, fileHash, rows: validRows },
      });
    },
    onSuccess: (result) => {
      setImportResult(result as { imported: number; failed: number; total: number });
      setStep("complete");
      queryClient.invalidateQueries({ queryKey: keys.inbox.all() });
    },
  });

  const handleImport = useCallback(() => {
    setStep("importing");
    importMutation.mutate(reviewRows);
  }, [reviewRows, importMutation]);

  // ── Row editing ──
  const updateRowField = useCallback((rowIdx: number, field: keyof EditableRow, value: string) => {
    setReviewRows((prev) =>
      prev.map((r) => (r.row === rowIdx ? { ...r, [field]: value, edited: true } : r)),
    );
  }, []);

  const toggleRowSelection = useCallback((rowIdx: number) => {
    setReviewRows((prev) =>
      prev.map((r) => (r.row === rowIdx ? { ...r, selected: !r.selected } : r)),
    );
  }, []);

  const toggleSelectAll = useCallback(() => {
    const allSelected = filteredReviewRows.every((r) => r.selected);
    const filteredRowNums = new Set(filteredReviewRows.map((r) => r.row));
    setReviewRows((prev) =>
      prev.map((r) => (filteredRowNums.has(r.row) ? { ...r, selected: !allSelected } : r)),
    );
  }, [filteredReviewRows]);

  // ── Reset & Close ──
  const handleClose = useCallback(() => {
    setStep("upload");
    setCsvContent("");
    setFileHash("");
    setFileName("");
    setSelectedCategory("");
    setCsvHeaders([]);
    setCsvRows([]);
    setColumnMapping({ date: "", amount: "", description: "", department: "", location: "" });
    setDateFormat("MM/DD/YYYY");
    setSignage("positive");
    setReviewRows([]);
    setReviewTab("all");
    setEditingCell(null);
    setImportResult(null);
    onClose();
  }, [onClose]);

  if (!isOpen) return null;

  const isReviewStep = step === "review";

  return (
    <Modal
      open={isOpen}
      onClose={handleClose}
      title="Import Bank Transactions"
      mobile="fullscreen"
      size={isReviewStep ? "full" : step === "map" ? "lg" : "md"}
      // A stray backdrop tap partway through a wizard throws away the upload and the mapping.
      closeOnBackdrop={step === "upload" || step === "complete"}
      // The import step has no actions — an empty footer rule would read as a broken dialog.
      footer={
        step === "importing" ? undefined : (
          <>
            {step === "upload" && (
              <>
                <button
                  type="button"
                  onClick={handleClose}
                  className="h-11 px-4 text-sm text-[#6b7280] transition-colors hover:text-[#374151] dark:text-slate-400 dark:hover:text-slate-300"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={goToMapStep}
                  disabled={!csvContent || !selectedCategory}
                  className="flex h-11 items-center justify-center gap-2 rounded-full bg-teal-500 px-6 text-sm font-medium text-white transition-colors hover:bg-teal-600 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Next
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                  >
                    <path d="M5 12h14" />
                    <path d="m12 5 7 7-7 7" />
                  </svg>
                </button>
              </>
            )}

            {step === "map" && (
              <>
                <button
                  type="button"
                  onClick={() => {
                    // Upload Again resets to step 1
                    setCsvContent("");
                    setFileName("");
                    setCsvHeaders([]);
                    setCsvRows([]);
                    setStep("upload");
                  }}
                  className="flex h-11 items-center justify-center gap-2 px-4 text-sm text-teal-600 transition-colors hover:text-teal-700 dark:text-teal-400 dark:hover:text-teal-300"
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
                  Upload Again
                </button>
                <button
                  type="button"
                  onClick={() => setStep("upload")}
                  className="h-11 px-4 text-sm text-[#6b7280] transition-colors hover:text-[#374151] dark:text-slate-400 dark:hover:text-slate-300"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleValidate}
                  disabled={
                    !columnMapping.date ||
                    !columnMapping.amount ||
                    !columnMapping.description ||
                    validateMutation.isPending
                  }
                  className="flex h-11 items-center justify-center gap-2 rounded-full bg-teal-500 px-6 text-sm font-medium text-white transition-colors hover:bg-teal-600 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {validateMutation.isPending ? (
                    <>
                      <div className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                      Validating…
                    </>
                  ) : (
                    "Validate"
                  )}
                </button>
              </>
            )}

            {step === "review" && (
              <>
                <button
                  type="button"
                  onClick={() => {
                    setStep("map");
                    setReviewRows([]);
                  }}
                  className="flex h-11 items-center justify-center gap-2 px-4 text-sm text-[#6b7280] transition-colors hover:text-[#374151] dark:text-slate-400 dark:hover:text-slate-300"
                >
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                  >
                    <path d="M19 12H5" />
                    <path d="m12 19-7-7 7-7" />
                  </svg>
                  Back
                </button>
                <button
                  type="button"
                  onClick={handleImport}
                  disabled={selectedValidCount === 0}
                  className="flex h-11 items-center justify-center gap-2 rounded-full bg-teal-500 px-6 text-sm font-medium text-white transition-colors hover:bg-teal-600 disabled:cursor-not-allowed disabled:opacity-50"
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
                  Import {selectedValidCount} Transaction{selectedValidCount !== 1 ? "s" : ""}
                </button>
              </>
            )}

            {step === "complete" && (
              <button
                type="button"
                onClick={handleClose}
                className="h-11 rounded-full bg-teal-500 px-6 text-sm font-medium text-white transition-colors hover:bg-teal-600"
              >
                Done
              </button>
            )}
          </>
        )
      }
    >
      {/* Step Indicator */}
      {step !== "importing" && step !== "complete" && <StepIndicator step={step} />}

      {/* ── STEP 1: Upload ── */}
      {step === "upload" && (
        <div className="space-y-4">
          {/* Bank Account Selector — categories ARE bank accounts */}
          <div>
            <label className="block text-xs font-medium text-[#374151] dark:text-slate-300 mb-1.5">
              Bank or Credit Card Account
            </label>
            <Combobox
              value={selectedCategory}
              onChange={setSelectedCategory}
              options={categoryOptions}
              placeholder="Select an account…"
              searchPlaceholder="Type to filter accounts…"
            />
          </div>

          {/* Upload zone */}
          <div
            onDrop={handleFileDrop}
            onDragOver={(e) => e.preventDefault()}
            className="border-2 border-dashed border-[#d1d5db] dark:border-slate-600 rounded-lg p-6 text-center hover:border-teal-400 dark:hover:border-teal-500 transition-colors cursor-pointer"
            onClick={() => fileInputRef.current?.click()}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv"
              onChange={handleFileSelect}
              className="hidden"
            />
            {fileName ? (
              <div className="space-y-1">
                <div className="mx-auto w-12 h-14 rounded-lg bg-purple-50 dark:bg-purple-900/20 flex items-center justify-center">
                  <span className="text-xs font-bold text-purple-600 dark:text-purple-400">
                    CSV
                  </span>
                </div>
                <p className="text-sm font-medium text-[#374151] dark:text-slate-300">{fileName}</p>
                <p className="text-xs text-[#9ca3af] dark:text-slate-500">
                  {csvContent.split("\n").filter((l) => l.trim()).length - 1} rows detected · Click
                  to replace
                </p>
              </div>
            ) : (
              <div className="space-y-1">
                <svg
                  width="32"
                  height="32"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  className="mx-auto text-[#9ca3af] dark:text-slate-500"
                >
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="17 8 12 3 7 8" />
                  <line x1="12" y1="3" x2="12" y2="15" />
                </svg>
                <p className="text-sm text-[#374151] dark:text-slate-300">
                  Drag & drop a CSV file, or{" "}
                  <span className="text-teal-500 font-medium">browse</span>
                </p>
                <p className="text-xs text-[#9ca3af] dark:text-slate-500">
                  Columns: Date, Amount, Description, Department, Location
                </p>
              </div>
            )}
          </div>

          {/* Download template */}
          <button
            type="button"
            onClick={downloadTemplate}
            className="text-xs text-teal-600 dark:text-teal-400 hover:underline"
          >
            Download CSV template
          </button>
        </div>
      )}

      {/* ── STEP 2: Map Column Headers ── */}
      {step === "map" && (
        <div className="space-y-5">
          <h3 className="text-sm font-semibold text-[#111827] dark:text-slate-200">
            Map Column Headers
          </h3>

          <div className="space-y-5">
            {/* Date row */}
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:gap-4">
              <span className="w-full shrink-0 text-sm text-[#374151] sm:w-20 sm:pb-2.5 sm:text-right dark:text-slate-300">
                Date
              </span>
              <CustomSelect
                value={columnMapping.date}
                onChange={(v) => setColumnMapping((prev) => ({ ...prev, date: v }))}
                options={headerOptions}
                width="w-full sm:w-[240px]"
              />
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                className="hidden shrink-0 text-[#9ca3af] sm:mb-2.5 sm:block"
              >
                <path d="M5 12h14" />
                <path d="m12 5 7 7-7 7" />
              </svg>
              <div className="min-w-0 shrink-0">
                <span className="text-xs text-[#6b7280] dark:text-slate-500 block mb-1">
                  Date Format
                </span>
                <div className="flex items-center gap-2">
                  <CustomSelect
                    value={dateFormat}
                    onChange={setDateFormat}
                    options={DATE_FORMATS}
                    width="w-full sm:w-[180px]"
                  />
                  <div className="group relative">
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      width="18"
                      height="18"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="#9ca3af"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="cursor-help"
                    >
                      <circle cx="12" cy="12" r="10" />
                      <path d="M12 16v-4" />
                      <path d="M12 8h.01" />
                    </svg>
                    <div className="absolute bottom-full right-0 mb-2 px-3 py-1.5 text-xs text-white bg-[#1f2937] rounded-md w-48 leading-relaxed opacity-0 pointer-events-none group-hover:opacity-100 transition-opacity z-50">
                      Any separator can be used with the selected format.
                      <div className="absolute top-full right-4 border-4 border-transparent border-t-[#1f2937]" />
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Amount row */}
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:gap-4">
              <span className="w-full shrink-0 text-sm text-[#374151] sm:w-20 sm:pb-2.5 sm:text-right dark:text-slate-300">
                Amount
              </span>
              <CustomSelect
                value={columnMapping.amount}
                onChange={(v) => setColumnMapping((prev) => ({ ...prev, amount: v }))}
                options={headerOptions}
                width="w-full sm:w-[240px]"
              />
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                className="hidden shrink-0 text-[#9ca3af] sm:mb-2.5 sm:block"
              >
                <path d="M5 12h14" />
                <path d="m12 5 7 7-7 7" />
              </svg>
              <div className="min-w-0 shrink-0">
                <span className="text-xs text-[#6b7280] dark:text-slate-500 block mb-1">
                  Signage of Bank Deposits
                </span>
                <CustomSelect
                  value={signage}
                  onChange={setSignage}
                  options={SIGNAGE_OPTIONS}
                  width="w-full sm:w-[180px]"
                />
              </div>
            </div>

            {/* Simple fields */}
            {(["description", "department", "location"] as const).map((field) => (
              <div key={field} className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
                <span className="w-full shrink-0 text-sm text-[#374151] sm:w-20 sm:text-right dark:text-slate-300">
                  {FIELD_LABELS[field]}
                </span>
                <CustomSelect
                  value={columnMapping[field]}
                  onChange={(v) => setColumnMapping((prev) => ({ ...prev, [field]: v }))}
                  options={headerOptions}
                  width="w-full sm:w-[240px]"
                />
              </div>
            ))}
          </div>

          {validateMutation.error && (
            <p className="text-xs text-red-500 mt-3">
              {validateMutation.error instanceof Error
                ? validateMutation.error.message
                : "Validation error"}
            </p>
          )}
        </div>
      )}

      {/* ── STEP 3: Review & Correct ── */}
      {step === "review" && (
        <div className="flex flex-col">
          {/* Tabs */}
          <div className="scroll-x -mx-4 shrink-0 px-4">
            <ReviewTabs active={reviewTab} counts={reviewCounts} onChange={setReviewTab} />
          </div>

          {/* Summary Bar */}
          <div className="-mx-4 flex shrink-0 flex-col gap-2 border-b border-[#e5e7eb] bg-[#f9fafb] px-4 py-3 sm:flex-row sm:items-center sm:justify-between dark:border-slate-700 dark:bg-slate-800/50">
            <div className="flex flex-wrap items-center gap-4">
              <div className="flex items-center gap-1.5">
                <div className="w-2 h-2 rounded-full bg-emerald-500" />
                <span className="text-xs text-[#374151] dark:text-slate-300">
                  {reviewCounts.valid} valid
                </span>
              </div>
              {reviewCounts.invalid > 0 && (
                <div className="flex items-center gap-1.5">
                  <div className="w-2 h-2 rounded-full bg-red-500" />
                  <span className="text-xs text-red-500">{reviewCounts.invalid} invalid</span>
                </div>
              )}
              <span className="text-xs text-[#9ca3af] dark:text-slate-500">
                {selectedValidCount} selected for import
              </span>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  // Re-validate edited rows
                  const edited = reviewRows.filter((r) => r.edited);
                  if (edited.length > 0) {
                    // Re-validate the entire set
                    setReviewRows((prev) =>
                      prev.map((r) => {
                        if (!r.edited) return r;
                        // Basic client-side validation
                        const errors: string[] = [];
                        if (!r.date) errors.push("Date is required");
                        if (!r.amount || Number.isNaN(Number.parseFloat(r.amount)))
                          errors.push("Valid amount is required");
                        if (!r.description) errors.push("Description is required");
                        return {
                          ...r,
                          valid: errors.length === 0,
                          errors: errors.length > 0 ? errors : undefined,
                          edited: false,
                        };
                      }),
                    );
                  }
                }}
                className="h-11 rounded-lg border border-teal-500/30 px-3 text-sm font-medium text-teal-600 transition-colors hover:bg-teal-500/5 dark:text-teal-400"
              >
                Re-validate Edited
              </button>
            </div>
          </div>

          {/* Table — bounded so the sticky header has something to stick to at every size. */}
          <div className="scroll-x -mx-4 max-h-[60dvh] overflow-y-auto px-4">
            <table className="w-full text-xs min-w-[34rem]">
              <thead className="bg-[#f9fafb] dark:bg-slate-800 sticky top-0 z-10">
                <tr>
                  <th className="px-3 py-2.5 text-center w-10">
                    <input
                      type="checkbox"
                      checked={
                        filteredReviewRows.length > 0 && filteredReviewRows.every((r) => r.selected)
                      }
                      onChange={toggleSelectAll}
                      className="h-5 w-5 cursor-pointer accent-teal-500"
                    />
                  </th>
                  <th className="px-3 py-2.5 text-left text-[#6b7280] dark:text-slate-400 font-semibold w-12">
                    #
                  </th>
                  <th className="px-3 py-2.5 text-left text-[#6b7280] dark:text-slate-400 font-semibold w-28">
                    Date
                  </th>
                  <th className="px-3 py-2.5 text-right text-[#6b7280] dark:text-slate-400 font-semibold w-28">
                    Amount
                  </th>
                  <th className="px-3 py-2.5 text-left text-[#6b7280] dark:text-slate-400 font-semibold min-w-[200px]">
                    Description
                  </th>
                  <th className="px-3 py-2.5 text-left text-[#6b7280] dark:text-slate-400 font-semibold w-32">
                    Department
                  </th>
                  <th className="px-3 py-2.5 text-left text-[#6b7280] dark:text-slate-400 font-semibold w-32">
                    Location
                  </th>
                  <th className="px-3 py-2.5 text-center text-[#6b7280] dark:text-slate-400 font-semibold w-20">
                    Status
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#e5e7eb] dark:divide-slate-700">
                {filteredReviewRows.map((row) => {
                  const isEditing = (field: string) =>
                    editingCell?.row === row.row && editingCell.field === field;

                  const cellClass = (field: string) =>
                    `px-3 py-2 cursor-pointer transition-colors ${
                      isEditing(field) ? "bg-teal-50 dark:bg-teal-900/20" : ""
                    }`;

                  const renderCell = (field: string, value: string, align = "text-left") => {
                    if (isEditing(field)) {
                      return (
                        <td key={field} className={cellClass(field)}>
                          <input
                            type="text"
                            value={value}
                            onChange={(e) =>
                              updateRowField(row.row, field as keyof EditableRow, e.target.value)
                            }
                            onBlur={() => setEditingCell(null)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" || e.key === "Escape") setEditingCell(null);
                            }}
                            autoFocus
                            className={`w-full rounded border border-teal-500 bg-white px-1.5 py-0.5 text-base focus:outline-none sm:text-xs dark:bg-slate-800 dark:text-slate-300 ${align}`}
                          />
                        </td>
                      );
                    }
                    return (
                      <td
                        key={field}
                        className={`${cellClass(field)} ${align} text-[#374151] dark:text-slate-300 max-w-[200px] truncate`}
                        onClick={() => setEditingCell({ row: row.row, field })}
                        title={value || "Click to edit"}
                      >
                        {value || (
                          <span className="text-[#d1d5db] dark:text-slate-600 italic">—</span>
                        )}
                      </td>
                    );
                  };

                  return (
                    <tr
                      key={row.row}
                      className={`${
                        !row.valid
                          ? "bg-red-50/50 dark:bg-red-900/5"
                          : row.edited
                            ? "bg-amber-50/50 dark:bg-amber-900/5"
                            : ""
                      } hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors`}
                    >
                      <td className="px-3 py-2 text-center">
                        <input
                          type="checkbox"
                          checked={row.selected}
                          onChange={() => toggleRowSelection(row.row)}
                          className="h-5 w-5 cursor-pointer accent-teal-500"
                        />
                      </td>
                      <td className="px-3 py-2 text-[#9ca3af] dark:text-slate-500">{row.row}</td>
                      {renderCell("date", row.date)}
                      {renderCell("amount", row.amount, "text-right")}
                      {renderCell("description", row.description)}
                      {renderCell("department", row.department)}
                      {renderCell("location", row.location)}
                      <td className="px-3 py-2 text-center">
                        {row.valid ? (
                          <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-emerald-100 dark:bg-emerald-900/30">
                            <svg
                              width="12"
                              height="12"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="3"
                              className="text-emerald-600 dark:text-emerald-400"
                            >
                              <polyline points="20 6 9 17 4 12" />
                            </svg>
                          </span>
                        ) : (
                          <span
                            className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-red-100 dark:bg-red-900/30 cursor-help"
                            title={row.errors?.join(", ")}
                          >
                            <svg
                              width="12"
                              height="12"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="3"
                              className="text-red-500"
                            >
                              <line x1="18" y1="6" x2="6" y2="18" />
                              <line x1="6" y1="6" x2="18" y2="18" />
                            </svg>
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            {filteredReviewRows.length === 0 && (
              <div className="py-12 text-center text-sm text-[#9ca3af] dark:text-slate-500">
                {reviewTab === "invalid"
                  ? "🎉 No invalid rows — all data looks good!"
                  : "No rows to display"}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── STEP 4: Importing ── */}
      {step === "importing" && (
        <div className="flex flex-col items-center py-12 space-y-4">
          <div className="h-10 w-10 border-2 border-teal-500 border-t-transparent rounded-full animate-spin" />
          <p className="text-sm font-medium text-[#374151] dark:text-slate-300">
            Importing transactions…
          </p>
          <p className="text-xs text-[#9ca3af] dark:text-slate-500">This may take a moment</p>
        </div>
      )}

      {/* ── STEP 4: Complete ── */}
      {step === "complete" && importResult && (
        <div className="flex flex-col items-center py-10 space-y-5">
          <div className="w-14 h-14 rounded-full bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center">
            <svg
              width="28"
              height="28"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="text-emerald-600 dark:text-emerald-400"
            >
              <polyline points="20 6 9 17 4 12" />
            </svg>
          </div>
          <div className="text-center space-y-1">
            <p className="text-base font-semibold text-[#374151] dark:text-slate-300">
              Import Complete
            </p>
            <p className="text-sm text-[#9ca3af] dark:text-slate-500">
              <span className="text-emerald-600 dark:text-emerald-400 font-medium">
                {importResult.imported}
              </span>{" "}
              transactions submitted to Inbox
              {importResult.failed > 0 && (
                <span className="text-red-500 ml-1">· {importResult.failed} failed</span>
              )}
            </p>
          </div>
        </div>
      )}
    </Modal>
  );
};
