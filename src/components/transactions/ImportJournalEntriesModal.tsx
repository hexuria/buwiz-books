/**
 * Import Journal Entries — 3-Step Wizard
 * Step 1: Upload CSV (drag-and-drop + template download)
 * Step 2: Preview validated groups (full-screen, expandable rows, tabs)
 * Step 3: Import (progress + completion + error modal)
 *
 * Mirrors the ImportBankTransactionsModal wizard pattern.
 */
import React, { useCallback, useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  validateJournalEntryCsv,
  importJournalEntries,
} from "../../routes/api/-transactions-import";
import type { ValidatedJournalGroup } from "../../routes/api/-transactions-import";
import { useToast } from "../ui/Toast";
import { CustomSelect } from "../ui/CustomSelect";
import { Modal } from "../ui/Modal";
import { keys } from "../../lib/query-keys";

// ============================================================================
// Types
// ============================================================================

interface ImportJournalEntriesModalProps {
  isOpen: boolean;
  onClose: () => void;
}

type WizardStep = "upload" | "map" | "preview" | "importing" | "complete";
type ReviewTab = "all" | "valid" | "invalid";

interface ImportResultEntry {
  referenceNumber: string;
  success: boolean;
  transactionNumber?: string;
  error?: string;
}

interface ImportResult {
  imported: number;
  failed: number;
  total: number;
  results: ImportResultEntry[];
}

interface JournalColumnMapping {
  referenceNumber: string;
  date: string;
  categoryName: string;
  categoryNumber: string;
  department: string;
  location: string;
  party: string;
  debitAmount: string;
  creditAmount: string;
  memo: string;
  description: string;
}

// ============================================================================
// Constants
// ============================================================================

const REQUIRED_JOURNAL_FIELDS = ["referenceNumber", "date", "categoryName"] as const;

const JOURNAL_FIELD_LABELS: Record<string, string> = {
  referenceNumber: "Reference #",
  date: "Date",
  categoryName: "Category Name",
  categoryNumber: "Category Number",
  department: "Department",
  location: "Location",
  party: "Party",
  debitAmount: "Debit Amount",
  creditAmount: "Credit Amount",
  memo: "Memo",
  description: "Description",
};

const DATE_FORMATS = [
  { value: "MM/DD/YYYY", label: "MM/DD/YYYY" },
  { value: "M/D/YYYY", label: "M/D/YYYY" },
  { value: "MM/DD/YY", label: "MM/DD/YY" },
  { value: "M/D/YY", label: "M/D/YY" },
  { value: "YYYY/MM/DD", label: "YYYY/MM/DD" },
  { value: "YYYY/M/D", label: "YYYY/M/D" },
];

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

function autoDetectJournalMapping(headers: string[]): JournalColumnMapping {
  const lower = headers.map((h) => h.toLowerCase().trim());
  const find = (candidates: string[]): string => {
    for (const c of candidates) {
      const idx = lower.findIndex((h) => h === c || h.includes(c));
      if (idx !== -1) return headers[idx];
    }
    return "";
  };
  return {
    referenceNumber: find(["reference number", "reference", "ref", "ref #", "ref#"]),
    date: find(["date", "transaction date", "txn date"]),
    categoryName: find(["category name", "category", "account name", "account"]),
    categoryNumber: find(["category number", "account number", "account #", "acct #"]),
    department: find(["department", "dept", "division"]),
    location: find(["location", "branch", "office", "site"]),
    party: find(["party", "vendor", "customer", "payee"]),
    debitAmount: find(["debit amount", "debit", "dr"]),
    creditAmount: find(["credit amount", "credit", "cr"]),
    memo: find(["memo", "note"]),
    description: find(["description", "details", "narrative"]),
  };
}

const EMPTY_MAPPING: JournalColumnMapping = {
  referenceNumber: "",
  date: "",
  categoryName: "",
  categoryNumber: "",
  department: "",
  location: "",
  party: "",
  debitAmount: "",
  creditAmount: "",
  memo: "",
  description: "",
};

// ============================================================================
// Sub-Components
// ============================================================================

/** Step indicator bar */
const StepIndicator: React.FC<{ step: WizardStep }> = ({ step }) => {
  const steps = [
    { key: "upload", label: "Upload", num: 1 },
    { key: "map", label: "Map Columns", num: 2 },
    { key: "preview", label: "Preview", num: 3 },
  ] as const;

  const currentIdx = step === "upload" ? 0 : step === "map" ? 1 : step === "preview" ? 2 : 3;

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

/** Tab bar for review step */
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

/** Import errors modal — shown when import has failures */
const ImportErrorsModal: React.FC<{
  errors: ImportResultEntry[];
  onClose: () => void;
}> = ({ errors, onClose }) => {
  return (
    <Modal
      open
      onClose={onClose}
      title="Import Errors"
      description="The following entries could not be imported:"
      mobile="fullscreen"
      size="md"
      footer={
        <button
          type="button"
          onClick={onClose}
          className="h-11 rounded-lg bg-slate-600 px-4 text-sm font-medium text-white transition-colors hover:bg-slate-700"
        >
          Close
        </button>
      }
    >
      <div className="scroll-x max-h-72 overflow-y-auto rounded-lg border border-[#e5e7eb] dark:border-slate-700">
        <table className="w-full text-xs min-w-[34rem]">
          <thead className="bg-[#f9fafb] dark:bg-slate-800 sticky top-0">
            <tr>
              <th className="px-3 py-2 text-left text-[#6b7280] dark:text-slate-400 font-medium">
                Ref #
              </th>
              <th className="px-3 py-2 text-left text-[#6b7280] dark:text-slate-400 font-medium">
                Error
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#e5e7eb] dark:divide-slate-700">
            {errors.map((err) => (
              <tr key={err.referenceNumber} className="bg-red-50 dark:bg-red-900/10">
                <td className="px-3 py-2 text-[#374151] dark:text-slate-300 font-medium whitespace-nowrap">
                  {err.referenceNumber}
                </td>
                <td className="px-3 py-2 text-red-600 dark:text-red-400">
                  {err.error || "Unknown error"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Modal>
  );
};

// ============================================================================
// Main Component
// ============================================================================

export const ImportJournalEntriesModal: React.FC<ImportJournalEntriesModalProps> = ({
  isOpen,
  onClose,
}) => {
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { showToast } = useToast();

  // ── Wizard State ──
  const [step, setStep] = useState<WizardStep>("upload");

  // Step 1 state
  const [csvContent, setCsvContent] = useState<string>("");

  // Map step state
  const [csvHeaders, setCsvHeaders] = useState<string[]>([]);
  const [csvRows, setCsvRows] = useState<Record<string, string>[]>([]);
  const [columnMapping, setColumnMapping] = useState<JournalColumnMapping>(EMPTY_MAPPING);
  const [dateFormat, setDateFormat] = useState<string>("MM/DD/YYYY");
  const [fileName, setFileName] = useState<string>("");

  // Step 2 state
  const [validationResult, setValidationResult] = useState<{
    fileHash: string;
    totalRows: number;
    totalGroups: number;
    validGroups: number;
    invalidGroups: number;
    rowErrors: string[];
    groups: ValidatedJournalGroup[];
  } | null>(null);
  const [reviewTab, setReviewTab] = useState<ReviewTab>("all");
  const [selectedGroups, setSelectedGroups] = useState<Set<string>>(new Set());
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  // Step 3 state
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [showErrorModal, setShowErrorModal] = useState(false);

  // ── Derived data ──
  const reviewCounts = useMemo(() => {
    const groups = validationResult?.groups ?? [];
    const all = groups.length;
    const valid = groups.filter((g) => g.valid).length;
    const invalid = all - valid;
    return { all, valid, invalid };
  }, [validationResult]);

  const filteredGroups = useMemo(() => {
    const groups = validationResult?.groups ?? [];
    if (reviewTab === "valid") return groups.filter((g) => g.valid);
    if (reviewTab === "invalid") return groups.filter((g) => !g.valid);
    return groups;
  }, [validationResult, reviewTab]);

  const selectedValidCount = useMemo(() => {
    const groups = validationResult?.groups ?? [];
    return groups.filter((g) => g.valid && selectedGroups.has(g.referenceNumber)).length;
  }, [validationResult, selectedGroups]);

  const failedResults = useMemo(
    () => importResult?.results.filter((r) => !r.success) ?? [],
    [importResult],
  );

  // ── Validate mutation ──
  const validateMutation = useMutation({
    mutationFn: async (content: string) => {
      return validateJournalEntryCsv({ data: { content, sourceContent: csvContent } });
    },
    onSuccess: (result) => {
      const vr = result as {
        fileHash: string;
        totalRows: number;
        totalGroups: number;
        validGroups: number;
        invalidGroups: number;
        rowErrors: string[];
        groups: ValidatedJournalGroup[];
      };
      setValidationResult(vr);
      // Auto-select all valid groups
      const validRefs = new Set(vr.groups.filter((g) => g.valid).map((g) => g.referenceNumber));
      setSelectedGroups(validRefs);
      setReviewTab("all");
      setStep("preview");
    },
  });

  // ── Import mutation ──
  const importMutation = useMutation({
    mutationFn: async (groups: ValidatedJournalGroup[]) => {
      const validGroups = groups
        .filter((g) => g.valid && selectedGroups.has(g.referenceNumber))
        .map((g) => ({
          referenceNumber: g.referenceNumber,
          groupOrdinal: g.groupOrdinal,
          rows: g.rows,
        }));
      return importJournalEntries({
        data: { fileHash: validationResult?.fileHash ?? "", groups: validGroups },
      });
    },
    onSuccess: (result) => {
      const ir = result as ImportResult;
      setImportResult(ir);
      setStep("complete");
      queryClient.invalidateQueries({ queryKey: keys.inbox.all() });

      // Toast notifications
      if (ir.imported > 0) {
        showToast(
          `${ir.imported} journal entr${ir.imported !== 1 ? "ies" : "y"} submitted to Inbox`,
          { icon: "upload" },
        );
      }
      if (ir.failed > 0) {
        showToast(`${ir.failed} entr${ir.failed !== 1 ? "ies" : "y"} failed to import`, {
          icon: "error",
        });
      }
    },
  });

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
    const header =
      "Reference Number,Date,Category Name,Category Number,Department,Location,Party,Debit Amount,Credit Amount,Memo,Description";
    const row1 = "JE-001,01/15/2026,Office Supplies,61100,Admin,,,,500.00,,Office supply purchase";
    const row2 = "JE-001,01/15/2026,Cash,10100,Admin,,,500.00,,,Payment from cash";
    const csv = `${header}\n${row1}\n${row2}\n`;
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "Journal_Entry_Import_Template.csv";
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  // ── Step transition: Upload → Map ──
  const goToMapStep = useCallback(() => {
    const { headers, rows } = parseCsvClient(csvContent);
    setCsvHeaders(headers);
    setCsvRows(rows);
    setColumnMapping(autoDetectJournalMapping(headers));
    setStep("map");
  }, [csvContent]);

  const headerOptions = useMemo(
    () => [{ value: "", label: "— Skip —" }, ...csvHeaders.map((h) => ({ value: h, label: h }))],
    [csvHeaders],
  );

  const canValidate = useMemo(() => {
    return (
      columnMapping.referenceNumber !== "" &&
      columnMapping.date !== "" &&
      columnMapping.categoryName !== ""
    );
  }, [columnMapping]);

  // ── Validate: remap CSV using column mapping then send to server ──
  const handleValidate = useCallback(() => {
    const mappedHeader =
      "Reference Number,Date,Category Name,Category Number,Department,Location,Party,Debit Amount,Credit Amount,Memo,Description";
    const mappedRows = csvRows.map((row) => {
      const fields = [
        row[columnMapping.referenceNumber] ?? "",
        row[columnMapping.date] ?? "",
        `"${(row[columnMapping.categoryName] ?? "").replace(/"/g, '""')}"`,
        row[columnMapping.categoryNumber] ?? "",
        row[columnMapping.department] ?? "",
        row[columnMapping.location] ?? "",
        row[columnMapping.party] ?? "",
        row[columnMapping.debitAmount] ?? "",
        row[columnMapping.creditAmount] ?? "",
        `"${(row[columnMapping.memo] ?? "").replace(/"/g, '""')}"`,
        `"${(row[columnMapping.description] ?? "").replace(/"/g, '""')}"`,
      ];
      return fields.join(",");
    });
    const content = `${mappedHeader}\n${mappedRows.join("\n")}`;
    validateMutation.mutate(content);
  }, [csvRows, columnMapping, validateMutation]);

  // ── Import ──
  const handleImport = useCallback(() => {
    if (validationResult) {
      setStep("importing");
      importMutation.mutate(validationResult.groups);
    }
  }, [validationResult, importMutation]);

  // ── Group selection ──
  const toggleGroupSelection = useCallback((refNum: string) => {
    setSelectedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(refNum)) {
        next.delete(refNum);
      } else {
        next.add(refNum);
      }
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback(() => {
    const filteredRefs = filteredGroups.filter((g) => g.valid).map((g) => g.referenceNumber);
    const allSelected = filteredRefs.every((ref) => selectedGroups.has(ref));
    setSelectedGroups((prev) => {
      const next = new Set(prev);
      for (const ref of filteredRefs) {
        if (allSelected) {
          next.delete(ref);
        } else {
          next.add(ref);
        }
      }
      return next;
    });
  }, [filteredGroups, selectedGroups]);

  // ── Expand/collapse groups ──
  const toggleExpand = useCallback((refNum: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(refNum)) {
        next.delete(refNum);
      } else {
        next.add(refNum);
      }
      return next;
    });
  }, []);

  // ── Reset & Close ──
  const handleClose = useCallback(() => {
    setStep("upload");
    setCsvContent("");
    setFileName("");
    setCsvHeaders([]);
    setCsvRows([]);
    setColumnMapping(EMPTY_MAPPING);
    setDateFormat("MM/DD/YYYY");
    setValidationResult(null);
    setReviewTab("all");
    setSelectedGroups(new Set());
    setExpandedGroups(new Set());
    setImportResult(null);
    setShowErrorModal(false);
    onClose();
  }, [onClose]);

  if (!isOpen) return null;

  const isPreviewStep = step === "preview";

  return (
    <Modal
      open={isOpen}
      onClose={handleClose}
      title="Import Journal Entries"
      mobile="fullscreen"
      size={isPreviewStep ? "full" : step === "map" ? "lg" : "md"}
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
                  disabled={!csvContent}
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
                    setStep("upload");
                    setCsvHeaders([]);
                    setCsvRows([]);
                    setColumnMapping(EMPTY_MAPPING);
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
                  onClick={handleValidate}
                  disabled={!canValidate || validateMutation.isPending}
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

            {step === "preview" && (
              <>
                <button
                  type="button"
                  onClick={() => {
                    setStep("map");
                    setValidationResult(null);
                    setSelectedGroups(new Set());
                    setExpandedGroups(new Set());
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
                  className="h-11 rounded-full bg-teal-500 px-6 text-sm font-medium text-white transition-colors hover:bg-teal-600 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Import {selectedValidCount} Entr{selectedValidCount !== 1 ? "ies" : "y"}
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
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                  <line x1="16" y1="13" x2="8" y2="13" />
                  <line x1="16" y1="17" x2="8" y2="17" />
                </svg>
                <p className="text-sm text-[#374151] dark:text-slate-300">
                  Drag & drop a CSV file, or{" "}
                  <span className="text-teal-500 font-medium">browse</span>
                </p>
                <p className="text-xs text-[#9ca3af] dark:text-slate-500">
                  Rows grouped by Reference Number · Debits = Credits per entry
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

          {/* Validation error */}
          {validateMutation.error && (
            <p className="text-xs text-red-500">
              {validateMutation.error instanceof Error
                ? validateMutation.error.message
                : "Validation error"}
            </p>
          )}
        </div>
      )}

      {/* ── STEP 2: Map Columns ── */}
      {step === "map" && (
        <div className="space-y-5">
          <div>
            <h3 className="text-sm font-semibold text-[#111827] dark:text-slate-200">
              Map Column Headers
            </h3>
            <p className="text-[11px] text-[#9ca3af] dark:text-slate-500 mt-0.5">
              Match your CSV columns to the required journal entry fields. Fields marked{" "}
              <span className="text-red-500">*</span> are required.
            </p>
          </div>

          <div className="space-y-5">
            {/* Fields before Date — simple label + dropdown */}
            {(["referenceNumber", "categoryName", "categoryNumber"] as const).map((field) => (
              <div key={field} className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
                <div className="w-full shrink-0 sm:w-28 sm:text-right">
                  <span className="text-sm text-[#374151] dark:text-slate-300 leading-tight">
                    {JOURNAL_FIELD_LABELS[field]}
                  </span>
                  {(REQUIRED_JOURNAL_FIELDS as readonly string[]).includes(field) && (
                    <span className="block text-xs text-red-400">Required</span>
                  )}
                </div>
                <CustomSelect
                  value={columnMapping[field as keyof JournalColumnMapping]}
                  onChange={(v) =>
                    setColumnMapping((prev) => ({
                      ...prev,
                      [field]: v,
                    }))
                  }
                  options={headerOptions}
                  width="w-full sm:w-[240px]"
                />
              </div>
            ))}

            {/* Date row — label LEFT + dropdown → arrow → companion label ABOVE dropdown */}
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:gap-4">
              <div className="w-full shrink-0 sm:w-28 sm:pb-2.5 sm:text-right">
                <span className="text-sm text-[#374151] dark:text-slate-300 leading-tight">
                  Date
                </span>
                <span className="block text-xs text-red-400">Required</span>
              </div>
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

            {/* Fields after Date — simple label + dropdown */}
            {(
              [
                "party",
                "creditAmount",
                "debitAmount",
                "memo",
                "description",
                "department",
                "location",
              ] as const
            ).map((field) => (
              <div key={field} className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
                <div className="w-full shrink-0 sm:w-28 sm:text-right">
                  <span className="text-sm text-[#374151] dark:text-slate-300 leading-tight">
                    {JOURNAL_FIELD_LABELS[field]}
                  </span>
                  {(REQUIRED_JOURNAL_FIELDS as readonly string[]).includes(field) && (
                    <span className="block text-xs text-red-400">Required</span>
                  )}
                </div>
                <CustomSelect
                  value={columnMapping[field as keyof JournalColumnMapping]}
                  onChange={(v) =>
                    setColumnMapping((prev) => ({
                      ...prev,
                      [field]: v,
                    }))
                  }
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

      {/* ── STEP 3: Preview (full-screen) ── */}
      {step === "preview" && validationResult && (
        <div className="flex flex-col">
          {/* Summary bar */}
          <div className="-mx-4 flex flex-wrap items-center gap-4 border-b border-[#e5e7eb] bg-[#f9fafb] px-4 py-3 dark:border-slate-700 dark:bg-slate-800/50">
            <div className="flex items-center gap-1.5">
              <div className="w-2 h-2 rounded-full bg-emerald-500" />
              <span className="text-sm text-[#374151] dark:text-slate-300">
                {validationResult.validGroups} valid
              </span>
            </div>
            {validationResult.invalidGroups > 0 && (
              <div className="flex items-center gap-1.5">
                <div className="w-2 h-2 rounded-full bg-red-500" />
                <span className="text-sm text-red-500">
                  {validationResult.invalidGroups} invalid
                </span>
              </div>
            )}
            <span className="text-xs text-[#9ca3af] dark:text-slate-500">
              {validationResult.totalRows} total rows · {validationResult.totalGroups} entries
            </span>
          </div>

          {/* Row-level errors */}
          {validationResult.rowErrors.length > 0 && (
            <div className="mt-3 bg-red-50 dark:bg-red-900/10 border border-red-200 dark:border-red-800 rounded-lg p-3">
              <p className="text-xs font-medium text-red-600 dark:text-red-400 mb-1">Row Errors</p>
              <ul className="text-xs text-red-500 space-y-0.5">
                {validationResult.rowErrors.slice(0, 5).map((err, i) => (
                  <li key={i}>{err}</li>
                ))}
                {validationResult.rowErrors.length > 5 && (
                  <li className="text-[#9ca3af]">
                    …and {validationResult.rowErrors.length - 5} more
                  </li>
                )}
              </ul>
            </div>
          )}

          {/* Review Tabs */}
          <div className="scroll-x -mx-4 px-4 pt-3">
            <ReviewTabs active={reviewTab} counts={reviewCounts} onChange={setReviewTab} />
          </div>

          {/* Review table */}
          {/* Bounded so the sticky header has something to stick to at every size. */}
          <div className="scroll-x -mx-4 max-h-[60dvh] overflow-y-auto px-4 py-3">
            <table className="w-full text-xs min-w-[34rem]">
              <thead className="bg-[#f9fafb] dark:bg-slate-800 sticky top-0 z-10">
                <tr>
                  <th className="px-3 py-2 text-left w-10">
                    <input
                      type="checkbox"
                      checked={
                        filteredGroups.filter((g) => g.valid).length > 0 &&
                        filteredGroups
                          .filter((g) => g.valid)
                          .every((g) => selectedGroups.has(g.referenceNumber))
                      }
                      onChange={toggleSelectAll}
                      className="h-5 w-5 rounded border-slate-300 accent-teal-500 dark:border-slate-600"
                    />
                  </th>
                  <th className="px-3 py-2 text-left w-8" />
                  <th className="px-3 py-2 text-left text-[#6b7280] dark:text-slate-400 font-medium">
                    Ref #
                  </th>
                  <th className="px-3 py-2 text-left text-[#6b7280] dark:text-slate-400 font-medium">
                    Date
                  </th>
                  <th className="px-3 py-2 text-center text-[#6b7280] dark:text-slate-400 font-medium">
                    Lines
                  </th>
                  <th className="px-3 py-2 text-right text-[#6b7280] dark:text-slate-400 font-medium">
                    Debits
                  </th>
                  <th className="px-3 py-2 text-right text-[#6b7280] dark:text-slate-400 font-medium">
                    Credits
                  </th>
                  <th className="px-3 py-2 text-center text-[#6b7280] dark:text-slate-400 font-medium">
                    Status
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#e5e7eb] dark:divide-slate-700">
                {filteredGroups.map((group) => {
                  const isExpanded = expandedGroups.has(group.referenceNumber);
                  const isSelected = selectedGroups.has(group.referenceNumber);
                  const firstDate = group.rows[0]?.date ?? "";

                  return (
                    <React.Fragment key={group.referenceNumber}>
                      {/* Group row */}
                      <tr
                        className={`transition-colors ${
                          group.valid
                            ? isSelected
                              ? "bg-teal-50/50 dark:bg-teal-900/10"
                              : "hover:bg-[#f9fafb] dark:hover:bg-slate-800/50"
                            : "bg-red-50 dark:bg-red-900/10"
                        }`}
                      >
                        <td className="px-3 py-2">
                          <input
                            type="checkbox"
                            checked={isSelected}
                            disabled={!group.valid}
                            onChange={() => toggleGroupSelection(group.referenceNumber)}
                            className="h-5 w-5 rounded border-slate-300 accent-teal-500 disabled:opacity-30 dark:border-slate-600"
                          />
                        </td>
                        <td className="px-3 py-2">
                          <button
                            type="button"
                            onClick={() => toggleExpand(group.referenceNumber)}
                            aria-label={`Toggle lines for ${group.referenceNumber}`}
                            className="touch-target text-[#9ca3af] dark:text-slate-500 hover:text-[#374151] dark:hover:text-slate-300 transition-colors"
                          >
                            <svg
                              width="14"
                              height="14"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              className={`transition-transform ${isExpanded ? "rotate-90" : ""}`}
                            >
                              <polyline points="9 18 15 12 9 6" />
                            </svg>
                          </button>
                        </td>
                        <td className="px-3 py-2 text-[#374151] dark:text-slate-300 font-medium">
                          {group.referenceNumber}
                        </td>
                        <td className="px-3 py-2 text-[#6b7280] dark:text-slate-400">
                          {firstDate}
                        </td>
                        <td className="px-3 py-2 text-center text-[#9ca3af] dark:text-slate-500">
                          {group.lineCount}
                        </td>
                        <td className="px-3 py-2 text-right text-[#374151] dark:text-slate-300">
                          ${group.totalDebits.toFixed(2)}
                        </td>
                        <td className="px-3 py-2 text-right text-[#374151] dark:text-slate-300">
                          ${group.totalCredits.toFixed(2)}
                        </td>
                        <td className="px-3 py-2 text-center">
                          {group.valid ? (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400">
                              <svg
                                width="10"
                                height="10"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="3"
                              >
                                <polyline points="20 6 9 17 4 12" />
                              </svg>
                              Valid
                            </span>
                          ) : (
                            <span
                              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400 cursor-help"
                              title={group.errors?.join("\n")}
                            >
                              <svg
                                width="10"
                                height="10"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="3"
                              >
                                <line x1="18" y1="6" x2="6" y2="18" />
                                <line x1="6" y1="6" x2="18" y2="18" />
                              </svg>
                              Error
                            </span>
                          )}
                        </td>
                      </tr>

                      {/* Expanded line details */}
                      {isExpanded &&
                        group.rows.map((row, idx) => {
                          const debit = row.debitAmount
                            ? Number.parseFloat(row.debitAmount.replace(/[,$]/g, ""))
                            : 0;
                          const credit = row.creditAmount
                            ? Number.parseFloat(row.creditAmount.replace(/[,$]/g, ""))
                            : 0;
                          return (
                            <tr
                              key={`${group.referenceNumber}-${idx}`}
                              className="bg-slate-50 dark:bg-slate-800/30"
                            >
                              <td className="px-3 py-1.5" />
                              <td className="px-3 py-1.5">
                                <div className="w-3 h-3 border-l-2 border-b-2 border-slate-300 dark:border-slate-600 ml-1" />
                              </td>
                              <td
                                className="px-3 py-1.5 text-[#6b7280] dark:text-slate-400"
                                colSpan={2}
                              >
                                <span className="font-medium text-[#374151] dark:text-slate-300">
                                  {row.categoryName}
                                </span>
                                {row.categoryNumber && (
                                  <span className="ml-1.5 text-[10px] text-[#9ca3af] dark:text-slate-500">
                                    #{row.categoryNumber}
                                  </span>
                                )}
                                {row.department && (
                                  <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400">
                                    {row.department}
                                  </span>
                                )}
                                {row.location && (
                                  <span className="ml-1 text-[10px] px-1.5 py-0.5 rounded bg-purple-50 dark:bg-purple-900/20 text-purple-600 dark:text-purple-400">
                                    {row.location}
                                  </span>
                                )}
                              </td>
                              <td className="px-3 py-1.5 text-center text-[10px] text-[#9ca3af] dark:text-slate-500">
                                {row.description || row.memo || "—"}
                              </td>
                              <td className="px-3 py-1.5 text-right text-[#374151] dark:text-slate-300 tabular-nums">
                                {debit > 0 ? `$${debit.toFixed(2)}` : "—"}
                              </td>
                              <td className="px-3 py-1.5 text-right text-[#374151] dark:text-slate-300 tabular-nums">
                                {credit > 0 ? `$${credit.toFixed(2)}` : "—"}
                              </td>
                              <td className="px-3 py-1.5" />
                            </tr>
                          );
                        })}

                      {/* Error details row (if invalid and expanded) */}
                      {isExpanded && !group.valid && group.errors && (
                        <tr className="bg-red-50/50 dark:bg-red-900/5">
                          <td className="px-3 py-1.5" />
                          <td className="px-3 py-1.5" />
                          <td colSpan={6} className="px-3 py-1.5">
                            <div className="flex items-start gap-1.5 text-red-600 dark:text-red-400">
                              <svg
                                width="12"
                                height="12"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                                className="mt-0.5 shrink-0"
                              >
                                <circle cx="12" cy="12" r="10" />
                                <line x1="12" y1="8" x2="12" y2="12" />
                                <line x1="12" y1="16" x2="12.01" y2="16" />
                              </svg>
                              <div className="text-[10px] space-y-0.5">
                                {group.errors.map((err, i) => (
                                  <p key={i}>{err}</p>
                                ))}
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>

            {validationResult.validGroups === 0 && (
              <p className="text-xs text-red-500 text-center py-8">
                No valid entries to import. Please fix errors and re-upload.
              </p>
            )}
          </div>
        </div>
      )}

      {/* ── STEP 3a: Importing ── */}
      {step === "importing" && (
        <div className="flex flex-col items-center py-8 space-y-3">
          <div className="h-8 w-8 border-2 border-teal-500 border-t-transparent rounded-full animate-spin" />
          <p className="text-sm text-[#374151] dark:text-slate-300">Importing journal entries…</p>
          <p className="text-xs text-[#9ca3af] dark:text-slate-500">This may take a moment</p>
        </div>
      )}

      {/* ── STEP 3b: Complete ── */}
      {step === "complete" && importResult && (
        <div className="flex flex-col items-center py-6 space-y-4">
          <div
            className={`w-12 h-12 rounded-full flex items-center justify-center ${
              importResult.failed > 0
                ? "bg-amber-100 dark:bg-amber-900/30"
                : "bg-emerald-100 dark:bg-emerald-900/30"
            }`}
          >
            {importResult.failed > 0 ? (
              <svg
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="text-amber-600 dark:text-amber-400"
              >
                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                <line x1="12" y1="9" x2="12" y2="13" />
                <line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
            ) : (
              <svg
                width="24"
                height="24"
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
            )}
          </div>
          <div className="text-center space-y-1">
            <p className="text-sm font-medium text-[#374151] dark:text-slate-300">
              {importResult.failed > 0 ? "Import Completed with Errors" : "Import Complete"}
            </p>
            <p className="text-xs text-[#9ca3af] dark:text-slate-500">
              {importResult.imported} journal entr
              {importResult.imported !== 1 ? "ies" : "y"} submitted to Inbox
              {importResult.failed > 0 && `, ${importResult.failed} failed`}
            </p>
          </div>

          {/* View Errors button */}
          {failedResults.length > 0 && (
            <button
              type="button"
              onClick={() => setShowErrorModal(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-red-600 dark:text-red-400 border border-red-200 dark:border-red-800 rounded-lg hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
              View {failedResults.length} Error{failedResults.length !== 1 ? "s" : ""}
            </button>
          )}
        </div>
      )}

      {/* Error Modal */}
      {showErrorModal && failedResults.length > 0 && (
        <ImportErrorsModal errors={failedResults} onClose={() => setShowErrorModal(false)} />
      )}
    </Modal>
  );
};
