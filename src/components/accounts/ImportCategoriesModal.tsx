/**
 * Import Categories Modal
 * Supports CSV template import
 */
import React, { useState, useCallback } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  validateCsvImport,
  importCategories,
  csvRowSchema,
} from "../../routes/api/-accounts-import";
import type { z } from "zod";
import { Modal } from "../ui/Modal";
import { TableScroll } from "../ui/DataTable";

interface ImportCategoriesModalProps {
  isOpen: boolean;
  onClose: () => void;
}

type ValidationRow = {
  row: number;
  valid: boolean;
  data?: z.infer<typeof csvRowSchema>;
  errors?: string[];
};

type ValidationResult = {
  total: number;
  valid: number;
  invalid: number;
  rows: ValidationRow[];
};

const secondaryButton =
  "inline-flex items-center justify-center gap-2 h-11 px-5 text-sm font-semibold rounded-lg cursor-pointer transition-all bg-white dark:bg-slate-700 text-[var(--color-app-text-navy)] dark:text-slate-200 border border-gray-200 dark:border-slate-600 hover:bg-[#f5f6f9] dark:hover:bg-slate-600";
const primaryButton =
  "inline-flex items-center justify-center gap-2 h-11 px-5 text-sm font-semibold rounded-lg cursor-pointer transition-all border-none bg-[var(--color-app-header-teal)] text-white hover:bg-[#248f82] disabled:opacity-50";

export const ImportCategoriesModal: React.FC<ImportCategoriesModalProps> = ({
  isOpen,
  onClose,
}) => {
  const queryClient = useQueryClient();
  const [step, setStep] = useState<"upload" | "preview" | "importing" | "complete">("upload");
  const [csvContent, setCsvContent] = useState<string>("");
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [importResult, setImportResult] = useState<{
    imported: number;
    skipped: number;
    failed: number;
  } | null>(null);

  // Handle file drop
  const handleFileDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file && file.name.endsWith(".csv")) {
      const reader = new FileReader();
      reader.onload = (event) => {
        setCsvContent(event.target?.result as string);
      };
      reader.readAsText(file);
    }
  }, []);

  // Handle file select
  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (event) => {
        setCsvContent(event.target?.result as string);
      };
      reader.readAsText(file);
    }
  }, []);

  // Validate CSV
  const validateMutation = useMutation({
    mutationFn: async (content: string) => {
      return validateCsvImport({ data: { content } });
    },
    onSuccess: (data) => {
      setValidation(data as ValidationResult);
      setStep("preview");
    },
  });

  // Import categories
  const importMutation = useMutation({
    mutationFn: async (rows: ValidationRow["data"][]) => {
      const validRows = rows.filter((r): r is z.infer<typeof csvRowSchema> => r != null);
      return importCategories({ data: { rows: validRows } });
    },
    onSuccess: (data) => {
      setImportResult(data as typeof importResult);
      setStep("complete");
      queryClient.invalidateQueries({ queryKey: ["accounts"] });
    },
  });

  const handleValidate = () => {
    if (csvContent) {
      validateMutation.mutate(csvContent);
    }
  };

  const handleImport = () => {
    if (validation) {
      const validRows = validation.rows.filter((r) => r.valid && r.data).map((r) => r.data!);
      setStep("importing");
      importMutation.mutate(validRows);
    }
  };

  const handleClose = () => {
    setStep("upload");
    setCsvContent("");
    setValidation(null);
    setImportResult(null);
    onClose();
  };

  const downloadTemplate = useCallback(() => {
    const header =
      "Category Name,Category Number,Parent Name,Parent Category Number,Type,Status,Description";
    const exampleRow =
      "Office Supplies,61100,Operating Expenses,,Operating Expenses,Active,General office supply purchases";
    const csv = `${header}\n${exampleRow}\n`;
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "Category_Import_Template.csv";
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  // The importing step has no actions of its own — the original rendered no
  // button row there either, so the footer disappears with it.
  let footer: React.ReactNode = null;
  if (step === "upload") {
    footer = (
      <>
        <button type="button" className={secondaryButton} onClick={handleClose}>
          Cancel
        </button>
        <button
          type="button"
          className={primaryButton}
          onClick={handleValidate}
          disabled={!csvContent || validateMutation.isPending}
        >
          {validateMutation.isPending ? "Validating..." : "Validate"}
        </button>
      </>
    );
  } else if (step === "preview" && validation) {
    footer = (
      <>
        <button type="button" className={secondaryButton} onClick={() => setStep("upload")}>
          Back
        </button>
        <button
          type="button"
          className={primaryButton}
          onClick={handleImport}
          disabled={validation.valid === 0}
        >
          Import {validation.valid} Categories
        </button>
      </>
    );
  } else if (step === "complete" && importResult) {
    footer = (
      <button type="button" className={primaryButton} onClick={handleClose}>
        Done
      </button>
    );
  }

  return (
    <Modal
      open={isOpen}
      onClose={handleClose}
      title="Import Categories"
      mobile="fullscreen"
      size="md"
      footer={footer}
    >
      {/* Step 1: Upload */}
      {step === "upload" && (
        <>
          <div
            className="border-2 border-dashed border-gray-300 dark:border-slate-600 rounded-xl p-6 sm:p-8 text-center cursor-pointer"
            onDrop={handleFileDrop}
            onDragOver={(e) => e.preventDefault()}
          >
            <div className="text-3xl mb-2">📄</div>
            <p className="text-[#6b7c93] mb-2 text-sm">
              Drag and drop your CSV file here, or click to browse
            </p>
            <input
              type="file"
              accept=".csv"
              onChange={handleFileSelect}
              className="hidden"
              id="csv-upload"
            />
            <label htmlFor="csv-upload" className={secondaryButton}>
              Browse Files
            </label>
          </div>
          <p className="text-center text-xs text-[#6b7c93] mt-2">
            CSV format template found{" "}
            <button
              type="button"
              className="touch-target text-[var(--color-app-header-teal)] underline cursor-pointer bg-transparent border-none p-0 text-xs font-medium"
              onClick={downloadTemplate}
            >
              here
            </button>
          </p>

          {csvContent && (
            <div className="mt-4">
              <p className="text-[#2a9d8f] font-medium">
                ✓ File loaded ({csvContent.split("\n").length - 1} rows)
              </p>
            </div>
          )}
        </>
      )}

      {/* Step 2: Preview */}
      {step === "preview" && validation && (
        <>
          <div className="flex gap-4 mb-4">
            <div className="py-3 px-4 bg-emerald-100 rounded-lg flex-1 text-center">
              <div className="text-2xl font-semibold text-emerald-900">{validation.valid}</div>
              <div className="text-xs text-emerald-700">Valid</div>
            </div>
            <div className="py-3 px-4 bg-red-100 rounded-lg flex-1 text-center">
              <div className="text-2xl font-semibold text-red-900">{validation.invalid}</div>
              <div className="text-xs text-red-600">Invalid</div>
            </div>
          </div>

          <div className="max-h-[300px] overflow-y-auto text-sm">
            <TableScroll minWidth={544}>
              <table className="w-full border-collapse">
                <thead>
                  <tr className="border-b border-gray-200 dark:border-slate-700">
                    <th className="p-2 text-left">Row</th>
                    <th className="p-2 text-left">Name</th>
                    <th className="p-2 text-left">Type</th>
                    <th className="p-2 text-left">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {validation.rows.slice(0, 10).map((row) => (
                    <tr key={row.row} className="border-b border-gray-100 dark:border-slate-800">
                      <td className="p-2">
                        {row.valid ? "✓" : "✗"} {row.row}
                      </td>
                      <td className="p-2">{row.data?.categoryName || "-"}</td>
                      <td className="p-2">{row.data?.type || "-"}</td>
                      <td className={`p-2 ${row.valid ? "text-emerald-600" : "text-red-600"}`}>
                        {row.valid ? "Valid" : row.errors?.join(", ")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableScroll>
            {validation.total > 10 && (
              <p className="text-center text-[#6b7c93] mt-2">
                ... and {validation.total - 10} more rows
              </p>
            )}
          </div>
        </>
      )}

      {/* Step 3: Importing */}
      {step === "importing" && (
        <div className="text-center p-8">
          <div className="app-spinner mx-auto mb-4" />
          <p className="text-[#6b7c93]">Importing categories...</p>
        </div>
      )}

      {/* Step 4: Complete */}
      {step === "complete" && importResult && (
        <div className="text-center">
          <div className="text-5xl mb-2">🎉</div>
          <h3 className="text-[#32497f] dark:text-slate-100 mb-2">Import Complete!</h3>
          <div className="flex flex-wrap gap-x-4 gap-y-1 justify-center text-sm">
            <span className="text-emerald-600">✓ {importResult.imported} imported</span>
            <span className="text-[#6b7c93]">○ {importResult.skipped} skipped</span>
            {importResult.failed > 0 && (
              <span className="text-red-600">✗ {importResult.failed} failed</span>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
};
