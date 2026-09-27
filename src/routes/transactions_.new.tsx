/**
 * New Transaction Page — Full-page, transaction creator
 * Supports 4 types: Journal, Pay In, Pay Out, Transfer
 * Each type has a dedicated form layout accessible via left sidebar tabs.
 *
 * The editor itself (state, tab conversion, validation, and the card) is shared with the Inbox
 * reading pane: `useTransactionEditor` plus the pieces in components/transactions/editor. This
 * route owns the page chrome around it — the save split-button, attachments, AI assistant,
 * activity log — and what a save means here: submit to the Inbox, then close, stay, or start over.
 */
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { lazy, Suspense, useState, useRef, useEffect } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { JournalLineInput } from "../db/validation/journals";
import { createTransaction } from "./api/-transactions";
import { useIsCompactNav } from "../hooks/useBreakpoint";
import { useToast } from "../components/ui/Toast";

// Shared modules (extracted)
import type { TabType } from "../components/transactions/shared/types";
import { emptyJournalLine, emptyPayForLine } from "../components/transactions/shared/helpers";
import AttachmentsPanel from "../components/transactions/AttachmentsPanel";
import type { StagedDocument } from "../components/transactions/AttachmentsPanel";
import { newTransactionDraft } from "../components/transactions/editor/transaction-draft";
import { useTransactionEditor } from "../components/transactions/editor/useTransactionEditor";
import {
  TransactionCategoryModal,
  TransactionEntryCard,
  TransactionTypeTabs,
} from "../components/transactions/editor/TransactionEditorParts";
import { AppErrorBoundary } from "../components/error/AppErrorBoundary";
import { Modal } from "../components/ui/Modal";
import { keys } from "../lib/query-keys";
import { callServerFn } from "../lib/server-fn-client";

const AIChatPanel = lazy(() => import("../components/transactions/AIChatPanel"));

// ============================================================================
// Route
// ============================================================================

export const Route = createFileRoute("/transactions_/new")({
  component: NewTransactionRoute,
});

function NewTransactionRoute() {
  return (
    <AppErrorBoundary contextLabel="New Transaction">
      <NewTransactionPage />
    </AppErrorBoundary>
  );
}

// ============================================================================
// Component
// ============================================================================

function NewTransactionPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  // ── Editor state (tab, shared fields, per-tab lines, data, validation) ──
  const [initialDraft] = useState(newTransactionDraft);
  const editor = useTransactionEditor({ initialDraft });
  const {
    activeTab,
    setActiveTab,
    date,
    setDate,
    referenceNumber,
    setReferenceNumber,
    memo,
    setMemo,
    validationErrors,
    setValidationErrors,
    validate,
    journalLines,
    setJournalLines,
    payPartyId,
    payCategoryId,
    setPayCategoryId,
    payForLines,
    setPayForLines,
    transferFromCategory,
    transferToCategory,
    transferAmount,
    setTransferAmount,
    flatAccounts,
    partyOptions,
    departmentOptions,
    locationOptions,
    handleAIApply,
  } = editor;

  // ── Save split-button dropdown ──
  const [saveMenuOpen, setSaveMenuOpen] = useState(false);
  const [showActivityLog, setShowActivityLog] = useState(false);

  // The Activity Log has two presentations: a docked column at `lg`, and this modal below it.
  // Its trigger is `lg:hidden`, so the modal is unopenable on desktop — but a viewport that
  // *grows* past `lg` while it is open leaves the modal floating over the column it duplicates.
  const isCompactLayout = useIsCompactNav();
  useEffect(() => {
    if (!isCompactLayout) setShowActivityLog(false);
  }, [isCompactLayout]);
  const [sidebarTab, setSidebarTab] = useState<"attachments" | "ai" | "activity">("attachments");
  const [stagedDocuments, setStagedDocuments] = useState<StagedDocument[]>([]);
  const saveMenuRef = useRef<HTMLDivElement>(null);
  const submissionIdempotencyKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!saveMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (saveMenuRef.current && !saveMenuRef.current.contains(e.target as Node)) {
        setSaveMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [saveMenuOpen]);

  // ── Auto-stage document from URL params (from document detail page) ──
  // Also handle reconciliation prefill params
  const [_reconReturnId, setReconReturnId] = useState<string | null>(null);
  const [aiInitialPrompt, setAiInitialPrompt] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const docId = params.get("docId");
    const docName = params.get("docName");
    if (docId) {
      setStagedDocuments((prev) => {
        if (prev.some((d) => d.documentId === docId)) return prev;
        return [
          ...prev,
          {
            documentId: docId,
            filename: docName || "Attached Document",
            contentType: "",
            fileSizeBytes: 0,
          },
        ];
      });
      // Switch to attachments tab to show the staged doc
      setSidebarTab("attachments");
    }

    // ── Reconciliation prefill params ──
    const reconType = params.get("type") as TabType | null;
    const reconDate = params.get("date");
    const reconDesc = params.get("description");
    const reconAmount = params.get("amount");
    const reconId = params.get("reconId");
    const reconAiPrompt = params.get("aiPrompt");

    if (reconType) setActiveTab(reconType);
    if (reconDate) setDate(reconDate);
    if (reconDesc) setMemo(reconDesc);
    if (reconId) setReconReturnId(reconId);

    // Pre-fill pay-for lines for pay_out / pay_in
    if ((reconType === "pay_out" || reconType === "pay_in") && reconAmount) {
      setPayForLines([
        {
          key: crypto.randomUUID(),
          description: reconDesc || "",
          categoryId: "",
          departmentId: "",
          locationId: "",
          amount: reconAmount,
        },
      ]);
    }

    // Set AI prompt for auto-submission (switches sidebar to AI tab)
    if (reconAiPrompt) {
      setAiInitialPrompt(reconAiPrompt);
      setSidebarTab("ai");
    }
  }, []);

  // ── Resolve categoryName URL param to account ID once flatAccounts loads ──
  const categoryNameResolved = useRef(false);
  useEffect(() => {
    if (categoryNameResolved.current || flatAccounts.length === 0) return;
    const params = new URLSearchParams(window.location.search);
    const catName = params.get("categoryName");
    if (!catName) return;
    categoryNameResolved.current = true;
    const match = flatAccounts.find((a) => a.name.toLowerCase() === catName.toLowerCase());
    if (match) {
      setPayCategoryId(match.id);
    }
  }, [flatAccounts]);

  // ── Mutation ──
  const createMutation = useMutation({
    mutationFn: (data: {
      idempotencyKey: string;
      transactionDate: string;
      transactionType: TabType;
      memo?: string;
      partyId?: string;
      referenceNumber?: string;
      documentIds?: string[];
      lines: JournalLineInput[];
    }) =>
      callServerFn(createTransaction, {
        data,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: keys.inbox.all() });
    },
  });

  // ── Submit handler ──
  const handleSave = (mode: "close" | "save" | "new" = "close") => {
    if (!validate()) return;
    const idempotencyKey =
      submissionIdempotencyKeyRef.current ??
      (submissionIdempotencyKeyRef.current = crypto.randomUUID());

    const onSuccessNav = async (result?: { inboxItem: { id: string } }) => {
      submissionIdempotencyKeyRef.current = null;
      await queryClient.invalidateQueries({ queryKey: keys.inbox.all() });
      showToast?.("Transaction submitted to Inbox for review.", { icon: "success" });
      if (mode === "new") {
        // Reset form
        setMemo("");
        setReferenceNumber("");
        setJournalLines([emptyJournalLine(), emptyJournalLine()]);
        setPayForLines([emptyPayForLine()]);
        setTransferAmount("");
        setValidationErrors(new Set());
        setStagedDocuments([]);
      } else {
        navigate({
          to: "/inbox" as string & {},
          search: { selected: result?.inboxItem.id },
        });
      }
    };
    const documentIds = stagedDocuments.map((document) => document.documentId);

    if (activeTab === "journal") {
      const lines: JournalLineInput[] = journalLines
        .filter((l) => l.categoryId && (l.debit || l.credit))
        .map((l, i) => ({
          accountId: l.categoryId,
          debit: l.debit ? Number.parseFloat(l.debit).toFixed(2) : undefined,
          credit: l.credit ? Number.parseFloat(l.credit).toFixed(2) : undefined,
          lineDescription: l.description || undefined,
          partyId: l.partyId || undefined,
          departmentId: l.departmentId || undefined,
          locationId: l.locationId || undefined,
          sortOrder: i,
        }));

      createMutation.mutate(
        {
          idempotencyKey,
          transactionDate: date,
          transactionType: "journal",
          memo: memo || undefined,
          referenceNumber: referenceNumber || undefined,
          documentIds,
          lines,
        },
        { onSuccess: (data) => onSuccessNav(data) },
      );
    } else if (activeTab === "pay_in" || activeTab === "pay_out") {
      const lines: JournalLineInput[] = [];
      let totalAmount = 0;

      payForLines.forEach((l, i) => {
        const amt = Number.parseFloat(l.amount) || 0;
        if (amt <= 0 || !l.categoryId) return;
        totalAmount += amt;
        lines.push({
          accountId: l.categoryId,
          ...(activeTab === "pay_in" ? { credit: amt.toFixed(2) } : { debit: amt.toFixed(2) }),
          lineDescription: l.description || undefined,
          sortOrder: i + 1,
        });
      });

      if (payCategoryId && totalAmount > 0) {
        lines.unshift({
          accountId: payCategoryId,
          ...(activeTab === "pay_in"
            ? { debit: totalAmount.toFixed(2) }
            : { credit: totalAmount.toFixed(2) }),
          sortOrder: 0,
        });
      }

      createMutation.mutate(
        {
          idempotencyKey,
          transactionDate: date,
          transactionType: activeTab,
          memo: memo || undefined,
          partyId: payPartyId || undefined,
          referenceNumber: referenceNumber || undefined,
          documentIds,
          lines,
        },
        { onSuccess: (data) => onSuccessNav(data) },
      );
    } else if (activeTab === "transfer") {
      const amt = (Number.parseFloat(transferAmount) || 0).toFixed(2);
      const lines: JournalLineInput[] = [];
      if (transferToCategory) {
        lines.push({ accountId: transferToCategory, debit: amt, sortOrder: 0 });
      }
      if (transferFromCategory) {
        lines.push({ accountId: transferFromCategory, credit: amt, sortOrder: 1 });
      }

      createMutation.mutate(
        {
          idempotencyKey,
          transactionDate: date,
          transactionType: "transfer",
          memo: memo || undefined,
          referenceNumber: referenceNumber || undefined,
          documentIds,
          lines,
        },
        { onSuccess: (data) => onSuccessNav(data) },
      );
    }
  };

  const handleCancel = () => {
    window.history.back();
  };

  // ── Render ──
  const mainContent = (
    <div className="flex h-screen bg-[#f0f2f5] dark:bg-slate-950">
      {/* ── Left Sidebar — Tabs ── */}
      <TransactionTypeTabs editor={editor} />

      {/* ── Main Content ── */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Top bar */}
        <div className="flex items-center justify-between gap-3 px-6 py-3 bg-white dark:bg-slate-900 border-b border-[#e2e8f0] dark:border-slate-700">
          {/* Activity Log toggle — mobile only */}
          <button
            type="button"
            className="lg:hidden w-9 h-9 touch-target rounded-lg flex items-center justify-center text-[#64748b] dark:text-slate-400 hover:bg-[#f1f5f9] dark:hover:bg-slate-800 hover:text-[var(--color-app-header-teal)] transition-colors cursor-pointer"
            onClick={() => setShowActivityLog(true)}
            title="Activity Log"
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <path d="M15 3v18" />
            </svg>
          </button>
          {/* Back arrow — uses browser history */}
          <button
            type="button"
            onClick={handleCancel}
            className="w-9 h-9 touch-target rounded-lg flex items-center justify-center text-[#64748b] dark:text-slate-400 hover:bg-[#f1f5f9] dark:hover:bg-slate-800 hover:text-[#1e293b] dark:hover:text-slate-200 transition-colors"
            title="Go back"
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M19 12H5" />
              <polyline points="12 19 5 12 12 5" />
            </svg>
          </button>
          <div className="flex items-center gap-3">
            {validationErrors.size > 0 && (
              <span className="text-xs font-medium text-red-500 dark:text-red-400 animate-in fade-in duration-200">
                Please select a category for each line with an amount
              </span>
            )}
            {createMutation.isError && (
              <span className="text-xs font-medium text-red-500 dark:text-red-400 animate-in fade-in duration-200">
                Failed to save — {(createMutation.error as Error)?.message || "please try again"}
              </span>
            )}

            <div className="relative flex items-stretch" ref={saveMenuRef}>
              <button
                type="button"
                onClick={() => handleSave("close")}
                disabled={createMutation.isPending}
                className="flex items-center gap-2 px-5 py-2.5 rounded-l-lg bg-[var(--color-app-header-teal)] hover:bg-[#248f82] disabled:opacity-50 text-white text-[13px] font-medium transition-colors"
              >
                {createMutation.isPending ? "Saving..." : "Save & Close"}
              </button>
              <button
                type="button"
                onClick={() => setSaveMenuOpen((v) => !v)}
                className="flex items-center justify-center w-10 rounded-r-lg bg-[var(--color-app-header-teal)] hover:bg-[#248f82] text-white transition-colors border-l border-white/25"
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                >
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>
              {saveMenuOpen && (
                <div className="absolute right-0 top-full mt-1 w-40 bg-white dark:bg-slate-900 border border-[#e5e7eb] dark:border-slate-700 rounded-lg shadow-lg z-50 py-1">
                  <button
                    type="button"
                    onClick={() => {
                      setSaveMenuOpen(false);
                      handleSave("save");
                    }}
                    className="w-full text-left px-3 py-2 text-xs text-[#374151] dark:text-slate-300 hover:bg-[#f9fafb] dark:hover:bg-slate-800 rounded-t-lg transition-colors"
                  >
                    Save
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setSaveMenuOpen(false);
                      handleSave("new");
                    }}
                    className="w-full text-left px-3 py-2 text-xs text-[#374151] dark:text-slate-300 hover:bg-[#f9fafb] dark:hover:bg-slate-800 rounded-b-lg transition-colors"
                  >
                    Save & New
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Scrollable form area */}
        <div className="flex-1 p-6 pb-0">
          <div className="flex gap-6 h-[calc(100vh-5rem-50px)]">
            {/* Main form card */}
            <TransactionEntryCard editor={editor} />

            {/* ── Right sidebar — Tabbed (AI Chat / Activity Log) ── */}
            <div className="hidden lg:flex lg:flex-col w-[360px] shrink-0">
              <div className="bg-white dark:bg-[#1e293b] rounded-2xl shadow-[0_4px_24px_rgba(0,0,0,0.08)] flex flex-col h-full overflow-hidden">
                {/* Tab bar — green gradient matching entity sidebar */}
                <div className="flex justify-evenly bg-gradient-to-r from-[#1a6b3c] to-[#27ae60] dark:from-[#145a30] dark:to-[#1e8c4c] shrink-0 px-4 py-3 gap-2">
                  <button
                    type="button"
                    onClick={() => setSidebarTab("attachments")}
                    className={`w-22 h-11 flex items-center justify-center rounded-full transition-colors cursor-pointer relative ${
                      sidebarTab === "attachments"
                        ? "bg-white/20 text-white"
                        : "text-white/50 hover:text-white hover:bg-white/10"
                    }`}
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
                    >
                      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                    </svg>
                    {stagedDocuments.length > 0 && (
                      <span className="absolute -top-0.5 -right-0.5 w-4 h-4 rounded-full bg-white text-[#1a6b3c] text-[9px] font-bold flex items-center justify-center">
                        {stagedDocuments.length}
                      </span>
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => setSidebarTab("ai")}
                    className={`w-22 h-11 flex items-center justify-center rounded-full transition-colors cursor-pointer ${
                      sidebarTab === "ai"
                        ? "bg-white/20 text-white"
                        : "text-white/50 hover:text-white hover:bg-white/10"
                    }`}
                  >
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3z" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    onClick={() => setSidebarTab("activity")}
                    className={`w-22 h-11 flex items-center justify-center rounded-full transition-colors cursor-pointer ${
                      sidebarTab === "activity"
                        ? "bg-white/20 text-white"
                        : "text-white/50 hover:text-white hover:bg-white/10"
                    }`}
                  >
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                    >
                      <circle cx="12" cy="12" r="10" />
                      <polyline points="12 6 12 12 16 14" />
                    </svg>
                  </button>
                </div>

                {/* Tab content */}
                <div className="flex-1 overflow-y-auto p-3">
                  {/* All panels rendered simultaneously — hidden via display:none to preserve state */}
                  <div style={{ display: sidebarTab === "attachments" ? "block" : "none" }}>
                    <AttachmentsPanel
                      stagedDocuments={stagedDocuments}
                      onDocumentsChange={setStagedDocuments}
                      accounts={flatAccounts}
                      parties={partyOptions.map((p) => ({ id: p.value, name: p.label }))}
                      departments={departmentOptions.map((d) => ({
                        id: d.value,
                        name: d.label,
                      }))}
                      locations={locationOptions.map((l) => ({ id: l.value, name: l.label }))}
                      currentDate={date}
                      onApply={handleAIApply}
                      onEntitiesResolved={async () => {
                        await Promise.all([
                          queryClient.invalidateQueries({ queryKey: ["financial-accounts"] }),
                          queryClient.invalidateQueries({ queryKey: ["accounts"] }),
                          queryClient.invalidateQueries({ queryKey: ["parties"] }),
                        ]);
                      }}
                    />
                  </div>
                  <div style={{ display: sidebarTab === "ai" ? "block" : "none" }}>
                    <AppErrorBoundary contextLabel="AI Assistant">
                      <Suspense
                        fallback={
                          <div className="rounded-2xl border border-slate-200 bg-white/80 px-4 py-6 text-sm text-slate-500 dark:border-slate-700 dark:bg-slate-900/80 dark:text-slate-300">
                            Loading AI assistant…
                          </div>
                        }
                      >
                        <AIChatPanel
                          accounts={flatAccounts}
                          parties={partyOptions.map((p) => ({ id: p.value, name: p.label }))}
                          departments={departmentOptions.map((d) => ({
                            id: d.value,
                            name: d.label,
                          }))}
                          locations={locationOptions.map((l) => ({ id: l.value, name: l.label }))}
                          currentDate={date}
                          onApply={handleAIApply}
                          initialPrompt={aiInitialPrompt}
                        />
                      </Suspense>
                    </AppErrorBoundary>
                  </div>
                  <div style={{ display: sidebarTab === "activity" ? "block" : "none" }}>
                    <div>
                      <div className="flex items-center justify-center mb-3">
                        <svg
                          width="18"
                          height="18"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="#94a3b8"
                          strokeWidth="1.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <circle cx="12" cy="12" r="10" />
                          <polyline points="12 6 12 12 16 14" />
                        </svg>
                      </div>
                      <h3 className="text-sm font-semibold text-[#1e293b] dark:text-white text-center mb-3">
                        Activity Log
                      </h3>
                      <div className="flex items-start gap-2">
                        <div className="w-6 h-6 rounded-full bg-[var(--color-app-header-teal)] flex items-center justify-center text-white text-[10px] font-bold shrink-0">
                          U
                        </div>
                        <div>
                          <p className="text-xs text-[#1e293b] dark:text-white">
                            <span className="font-medium">User</span>{" "}
                            <span className="text-[#94a3b8] dark:text-slate-500">Just now</span>
                          </p>
                          <p className="text-[11px] text-[#64748b] dark:text-slate-400">
                            Creating transaction.
                          </p>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Mobile Activity Log — the docked column is `lg:` only, so below that it is
              presented as its own screen. */}
          <Modal
            open={showActivityLog}
            onClose={() => setShowActivityLog(false)}
            title="Activity Log"
            mobile="fullscreen"
            size="sm"
          >
            <div className="flex items-start gap-2">
              <div className="w-6 h-6 rounded-full bg-[var(--color-app-header-teal)] flex items-center justify-center text-white text-[10px] font-bold shrink-0">
                U
              </div>
              <div>
                <p className="text-sm text-[#1e293b] dark:text-white">
                  <span className="font-medium">User</span>{" "}
                  <span className="text-[#94a3b8] dark:text-slate-500">Just now</span>
                </p>
                <p className="text-xs text-[#64748b] dark:text-slate-400">Creating transaction.</p>
              </div>
            </div>
          </Modal>
        </div>
      </div>
    </div>
  );

  // ── Category creation modal (portal, outside component tree) ──
  const modalElement = <TransactionCategoryModal editor={editor} />;

  return (
    <>
      {mainContent}
      {modalElement}
    </>
  );
}
