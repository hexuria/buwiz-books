/**
 * Reconciliation Detail Page — three-column layout
 * Left: Document Viewer (PDF bank statement)
 * Center: Transaction List (metric cards + filters + statement lines + ledger transactions)
 * Right: 4-tab Sidebar (Summary, Flag, Comments, Activity)
 *
 * Bidirectional hover linking between statement lines and ledger transactions
 */
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useState, useMemo, useCallback, useEffect, useRef } from "react";
import { useSession } from "../lib/auth-client";
import { AppErrorBoundary } from "../components/error/AppErrorBoundary";

import { listParties } from "./api/-parties";
import { listAccounts } from "./api/-accounts";

import { rehydrateJobWatchers, startFieldScan, useOcrJobs } from "../lib/reconciliation-ocr-store";
import { OcrProgress } from "../components/reconciliations/OcrProgress";
import type { LedgerTransaction } from "./api/-reconciliations";
import { ReconciliationSidebar } from "../components/reconciliations/ReconciliationSidebar";
import { ReconfigureModal } from "../components/reconciliations/ReconfigureModal";
import { RemoveStatementModal } from "../components/reconciliations/RemoveStatementModal";

import ReconciliationSearchBar from "../components/reconciliations/ReconciliationSearchBar";
import LedgerFilters, {
  type SourceType,
  type MatchedStatus,
} from "../components/ledger/LedgerFilters";
import InlineEditBar from "../components/ledger/InlineEditBar";
import { useToast } from "../components/ui/Toast";

import type { ComboboxOption } from "../components/ui/Combobox";
import type { TransactionType, JournalStatus } from "../db/validation/journals";
import SummaryRow from "../components/reconciliations/ReconSummary";
import StatementLinesList from "../components/reconciliations/StatementLinesList";
import LedgerTransactionsList from "../components/reconciliations/LedgerTransactionsList";
import type { ReconInlineEdits } from "../components/reconciliations/LedgerTransactionsList";
import { formatPeriodLabel } from "../components/reconciliations/reconHelpers";
import { useReconciliationData } from "../hooks/useReconciliationData";
import { useReconciliationMutations } from "../hooks/useReconciliationMutations";
import ConfirmModal from "../components/shared/ConfirmModal";
import { PasswordPromptModal } from "../components/shared/PasswordPromptModal";

const ReconciliationDocumentViewer = lazy(
  () => import("../components/reconciliations/ReconciliationDocumentViewer"),
);

// ============================================================================
// Route
// ============================================================================

export const Route = createFileRoute("/reconciliations_/$reconciliationId")({
  component: ReconciliationRouteComponent,
});

function ReconciliationRouteComponent() {
  return (
    <AppErrorBoundary contextLabel="Reconciliation">
      <ReconciliationDetailPage />
    </AppErrorBoundary>
  );
}

// ============================================================================
// Constants
// ============================================================================

const STATUS_LABELS: Record<string, { label: string; color: string; bg: string }> = {
  finalized: {
    label: "Finalized",
    color: "text-green-50 dark:text-green-50",
    bg: "bg-green-50/15 dark:bg-green-50/15",
  },
  in_progress: {
    label: "In Progress",
    color: "text-orange-50 dark:orange-blue-50",
    bg: "bg-orange-50/15 dark:bg-orange-50/15",
  },
  draft: {
    label: "Draft",
    color: "text-blue-50 dark:text-blue-50",
    bg: "bg-blue-50/15 dark:bg-blue-50/15",
  },
  not_started: {
    label: "Not Started",
    color: "text-red-50 dark:text-red-50",
    bg: "bg-red-50/15 dark:bg-red-50/15",
  },
};

type TransactionFilter = "all" | "matched" | "unmatched" | "ignored";
type TransactionView = "statement" | "ledger";
type ReconStatusFilter = "all" | "reconciled" | "unsettled";

// ============================================================================
// Helpers
// ============================================================================

// ============================================================================
// Page
// ============================================================================

function ReconciliationDetailPage() {
  const { data: session } = useSession();
  const { reconciliationId } = Route.useParams() as { reconciliationId: string };
  const navigate = useNavigate();

  // Hover linking state
  const [hoveredStatementLineId, setHoveredStatementLineId] = useState<string | null>(null);
  const [hoveredLedgerTxnId, setHoveredLedgerTxnId] = useState<string | null>(null);
  const [selectedStatementLineId, setSelectedStatementLineId] = useState<string | null>(null);

  // Panel State (responsive defaults: hide on small screens)
  const [showLeftPanel, setShowLeftPanel] = useState(
    () => typeof window !== "undefined" && window.innerWidth >= 1024,
  );
  const [showRightPanel, setShowRightPanel] = useState(
    () => typeof window !== "undefined" && window.innerWidth >= 1280,
  );
  const centerRef = useRef<HTMLDivElement>(null);
  const [centerNarrow, setCenterNarrow] = useState(false);

  useEffect(() => {
    const el = centerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      if (entry) setCenterNarrow(entry.contentRect.width < 650);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Re-attach to field scans that were still running when this page was last
  // closed. Without this a reload orphaned the job: it finished server-side
  // with nothing watching, and the UI never learned the outcome.
  // Uses the hook rather than the destructured client below, which is not yet
  // initialised at this point in the component body.
  const rootQueryClient = useQueryClient();
  useEffect(() => {
    rehydrateJobWatchers(rootQueryClient);
  }, [rootQueryClient]);

  // Auto-close panels when resizing below breakpoints
  useEffect(() => {
    const onResize = () => {
      if (window.innerWidth < 1024) setShowLeftPanel(false);
      if (window.innerWidth < 1280) setShowRightPanel(false);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Edit mode
  const [pageMode, setPageMode] = useState<"view" | "edit">("view");
  const [pendingEdits, setPendingEdits] = useState<Map<string, ReconInlineEdits>>(new Map());
  const isEditMode = pageMode === "edit";

  // Reconcile mode: which ledger txn is being manually matched to a bounding box
  const [reconcileTargetTxnId, setReconcileTargetTxnId] = useState<string | null>(null);
  const { showToast } = useToast();

  // ── Escape key to cancel reconcile mode ──────────────────
  useEffect(() => {
    if (!reconcileTargetTxnId) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setReconcileTargetTxnId(null);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [reconcileTargetTxnId]);

  // Reconfigure modal
  const [showReconfigureModal, setShowReconfigureModal] = useState(false);
  // Delete confirmation
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showFinalizeConfirm, setShowFinalizeConfirm] = useState(false);

  // Center panel filters
  const [txnFilter, _setTxnFilter] = useState<TransactionFilter>("all");
  const [txnView, _setTxnView] = useState<TransactionView>("ledger");
  const [searchQuery, setSearchQuery] = useState("");
  const [reconStatusFilter, setReconStatusFilter] = useState<ReconStatusFilter>("all");
  const [statementImageUrl, setStatementImageUrl] = useState<string | null>(null);
  const [statementPage, setStatementPage] = useState(1);

  // Advanced Filters State
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [typeFilter, setTypeFilter] = useState<TransactionType[]>([]);
  const [statusFilter, setStatusFilter] = useState<JournalStatus[]>([]);
  const [sourceFilter, setSourceFilter] = useState<SourceType[]>([]);
  const [matchedFilter, setMatchedFilter] = useState<MatchedStatus[]>([]);
  const [partyFilter, setPartyFilter] = useState<string[]>([]);
  const [departmentFilter, setDepartmentFilter] = useState<string[]>([]);
  const [locationFilter, setLocationFilter] = useState<string[]>([]);
  const [amountMin, setAmountMin] = useState("");
  const [amountMax, setAmountMax] = useState("");

  // Search states for filter dropdowns
  const [partySearch, setPartySearch] = useState("");
  const [departmentSearch, setDepartmentSearch] = useState("");
  const [locationSearch, setLocationSearch] = useState("");

  type ServerFnCaller = (opts: { data: unknown }) => Promise<any>;

  // ── Data hook: queries, derived lookups, filtered lists, metrics ──
  const {
    detailQuery,
    activityQuery,
    suggestionsQuery,
    recon,
    isFinalized,
    periodPartyOptions,
    periodDepartmentOptions,
    periodLocationOptions,
    filteredPartyOptions,
    filteredDepartmentOptions,
    filteredLocationOptions,
    journalToStatementMap,
    unmatchedLedgerByAmount,
    statementLinePageMap,
    linkedLedgerTxnId,
    linkedStatementLineId,
    filteredStatementLines,
    filteredLedgerByStatus,
    metrics,
    showNotFoundOverlay,
  } = useReconciliationData({
    reconciliationId,
    hasSession: !!session?.user,
    hoveredStatementLineId,
    hoveredLedgerTxnId,
    txnFilter,
    searchQuery,
    reconStatusFilter,
    selectedStatementLineId,
    typeFilter,
    statusFilter,
    matchedFilter,
    partyFilter,
    departmentFilter,
    locationFilter,
    amountMin,
    amountMax,
    partySearch,
    departmentSearch,
    locationSearch,
  });

  const [lastMatchedLineId, setLastMatchedLineId] = useState<string | null>(null);

  // ── Upload state (declared before mutations hook which references setters) ──
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [validationWarnings, setValidationWarnings] = useState<string[]>([]);
  // ── Locked statement PDF prompt (covers both first-upload and re-extract) ──
  const [passwordPrompt, setPasswordPrompt] = useState<
    | {
        mode: "upload";
        status: "password_required" | "wrong_password";
        lastInput: {
          reconciliationId: string;
          base64Content: string;
          mimeType: string;
          fileName: string;
        };
      }
    | { mode: "rerun"; status: "password_required" | "wrong_password" }
    | null
  >(null);
  const [isUnlocking, setIsUnlocking] = useState(false);

  // ── Mutations hook ─────────────────────────────────────────
  const {
    matchMutation,
    finalizeMutation,
    reopenMutation,
    removeStatementMutation,
    resolveFlagMutation,
    reconfigureMutation,
    deleteMutation,
    uploadStatementMutation,
    rerunExtractionMutation,
    statementPipelinePending,
    applySuggestionMutation,
    dismissSuggestionMutation,
    generateStatementMutation,
    updateBatchMutation,
    queryClient,
  } = useReconciliationMutations(reconciliationId, {
    clearReconcileTarget: () => setReconcileTargetTxnId(null),
    setLastMatchedLineId,
    setShowFinalizeConfirm,
    setShowReconfigureModal,
    setShowDeleteConfirm,
    setStatementImageUrl,
    setUploadError,
    setValidationWarnings,
    onStatementPasswordRequired: (status, lastInput) =>
      setPasswordPrompt({ mode: "upload", status, lastInput }),
    onRerunPasswordRequired: (status) => setPasswordPrompt({ mode: "rerun", status }),
  });

  // Retry a locked-PDF upload or re-extraction with the entered password.
  const handleSubmitStatementPassword = useCallback(
    ({ password, saveToAccountId }: { password: string; saveToAccountId?: string }) => {
      if (!passwordPrompt) return;
      setIsUnlocking(true);
      const opts = {
        onSettled: () => setIsUnlocking(false),
        onSuccess: (result: any) => {
          // The hook re-opens the prompt on another wrong_password; close it
          // only when the operation actually succeeded.
          if (!result || result.status === "ok") setPasswordPrompt(null);
        },
      };
      if (passwordPrompt.mode === "rerun") {
        rerunExtractionMutation.mutate({ password, savePassword: !!saveToAccountId }, opts);
      } else {
        uploadStatementMutation.mutate(
          { ...passwordPrompt.lastInput, password, savePassword: !!saveToAccountId },
          opts,
        );
      }
    },
    [passwordPrompt, uploadStatementMutation, rerunExtractionMutation],
  );

  const handleRerunExtraction = useCallback(() => {
    setUploadError(null);
    rerunExtractionMutation.mutate(undefined);
  }, [rerunExtractionMutation]);

  const handleGenerateStatement = useCallback(() => {
    generateStatementMutation.mutate();
  }, [generateStatementMutation]);

  // ── Run AI OCR on attached document (background) ──
  const ocrJobs = useOcrJobs();
  const isRunningOcr = ocrJobs.some(
    (j) => j.reconciliationId === reconciliationId && j.status === "processing",
  );

  // ── File reading helper ──
  const handleUploadStatement = useCallback(
    (file: File) => {
      setUploadError(null);
      setValidationWarnings([]);
      const reader = new FileReader();
      reader.onload = () => {
        const base64 = (reader.result as string).split(",")[1];
        uploadStatementMutation.mutate({
          reconciliationId,
          base64Content: base64,
          mimeType: file.type,
          fileName: file.name,
        });
      };
      reader.onerror = () => setUploadError("Failed to read file");
      reader.readAsDataURL(file);
    },
    [reconciliationId, uploadStatementMutation],
  );

  // ── Hydrate interactive viewer from server data on load ──
  useEffect(() => {
    if (recon?.statementPreviewImageUrl) {
      setStatementImageUrl(recon.statementPreviewImageUrl);
    }
  }, [recon?.statementPreviewImageUrl]);

  const handleRunOcr = useCallback(() => {
    const docId = recon?.statementDocumentId;
    if (!docId) return;
    startFieldScan(reconciliationId, docId, queryClient, true);
  }, [reconciliationId, recon?.statementDocumentId, queryClient]);

  const [showRemoveStatementConfirm, setShowRemoveStatementConfirm] = useState(false);

  const handleRemoveStatement = useCallback(() => {
    setShowRemoveStatementConfirm(true);
  }, []);

  const confirmRemoveStatement = useCallback(() => {
    removeStatementMutation.mutate();
    setShowRemoveStatementConfirm(false);
  }, [removeStatementMutation]);

  const handleResolveFlag = useCallback(
    (flagId: string, action: string) => {
      resolveFlagMutation.mutate({ flagId, action });
    },
    [resolveFlagMutation],
  );

  // ── Create transaction from unmatched statement line ──
  /** Handle line selection: In Edit mode, always toggle. In View mode, redirect if matched, toggle if unmatched */
  const handleLineSelect = useCallback(
    (id: string | null) => {
      if (!recon) return;
      if (isFinalized) return;
      if (!id) {
        setSelectedStatementLineId(null);
        return;
      }

      // Always toggle selection – navigation is handled by the chevron button
      setSelectedStatementLineId((prev) => (prev === id ? null : id));
    },
    [isFinalized],
  );

  const handleCreateTransactionFromStatement = useCallback(
    (statementLineId: string) => {
      if (!recon) return;

      let description = "";
      let date = "";
      let rawAmount = 0;

      const dbLine = recon.statementLines.find((sl) => sl.id === statementLineId);
      if (dbLine) {
        description = dbLine.description;
        date = dbLine.transactionDate;
        rawAmount = Number.parseFloat(dbLine.amount);
      } else {
        const box = (recon.statementLineBoundingBoxes ?? []).find(
          (b: any) => b.id === statementLineId,
        );
        if (!box) return;

        description = box.label || "";
        const amountText = (box.text || "").replace(/[,$]/g, "");
        rawAmount = Number.parseFloat(amountText) || 0;

        const matchByDesc = recon.statementLines.find((sl) =>
          sl.description.toLowerCase().includes(description.toLowerCase()),
        );
        date = matchByDesc?.transactionDate || recon.periodStart;
      }

      const absAmount = Math.abs(rawAmount).toFixed(2);
      const txnType = rawAmount < 0 ? "pay_out" : "pay_in";
      const bankLabel = recon.bankAccountName || "Bank Account";

      const verb = txnType === "pay_out" ? "Paid" : "Received";
      const aiPrompt = `${verb} $${absAmount} ${txnType === "pay_out" ? "to" : "from"} "${description}" on ${date} from ${bankLabel}`;

      const params = new URLSearchParams({
        type: txnType,
        date,
        description,
        amount: absAmount,
        categoryName: bankLabel,
        reconId: reconciliationId,
        aiPrompt,
      });

      navigate({ to: `/transactions/new?${params.toString()}` as string & {} });
    },
    [recon, reconciliationId, navigate],
  );

  // ── Reconcile Mode: match a bounding box to a ledger transaction ──
  const handleReconcileFromBbox = useCallback(
    (statementLineId: string) => {
      if (!reconcileTargetTxnId) return;

      const sl = recon?.statementLines.find((l) => l.id === statementLineId);
      if (sl?.matchStatus === "matched") {
        showToast("This statement line is already matched to a transaction", { icon: "error" });
        return;
      }

      matchMutation.mutate({
        reconciliationId,
        statementLineId,
        journalLineId: reconcileTargetTxnId,
        action: "match",
      });
    },
    [reconcileTargetTxnId, reconciliationId, matchMutation, recon, showToast],
  );

  // ── Edit mode: data fetching ─────────────────────────────

  const { data: allParties = [] } = useQuery({
    queryKey: ["parties"],
    queryFn: () => (listParties as ServerFnCaller)({ data: {} }),
    enabled: isEditMode,
  });

  const { data: flatAccounts = [] } = useQuery({
    queryKey: ["accounts", "flat"],
    queryFn: () =>
      (listAccounts as ServerFnCaller)({
        data: { includeChildren: false, status: ["active"], types: [], subtypes: [] },
      }),
    enabled: isEditMode,
  });

  const _partyOptions: ComboboxOption[] = useMemo(
    () =>
      (allParties as Array<{ id: string; name: string }>).map((p) => ({
        value: p.id,
        label: p.name,
      })),
    [allParties],
  );

  const _categoryOptions: ComboboxOption[] = useMemo(
    () =>
      (flatAccounts as Array<{ id: string; name: string; accountNumber?: string }>).map((c) => ({
        value: c.id,
        label: c.accountNumber ? `${c.accountNumber} - ${c.name}` : c.name,
      })),
    [flatAccounts],
  );

  /** Record an inline field change */
  const _handleFieldChange = useCallback(
    (txnId: string, field: keyof ReconInlineEdits, value: string) => {
      setPendingEdits((prev) => {
        const next = new Map(prev);
        const existing = next.get(txnId) ?? {};
        next.set(txnId, { ...existing, [field]: value });
        return next;
      });
    },
    [],
  );

  /** Cancel all pending edits */
  const handleInlineCancel = useCallback(() => {
    setPendingEdits(new Map());
  }, []);

  /** Apply all pending edits */
  const handleInlineApply = useCallback(async () => {
    if (pendingEdits.size === 0) return;
    const entries = Array.from(pendingEdits.entries());
    try {
      for (const [txnId, edits] of entries) {
        const { categoryAccountId, ...fieldUpdates } = edits;
        const txn = recon?.ledgerTransactions.find((t) => t.id === txnId);
        await updateBatchMutation.mutateAsync({
          ids: [txnId],
          updates: {
            ...fieldUpdates,
            ...(categoryAccountId ? { accountId: categoryAccountId } : {}),
          },
          lineAccountId: txn?.accountId,
        });
      }

      const partyLookup = new Map(
        (allParties as Array<{ id: string; name: string }>).map((p) => [p.id, p.name]),
      );
      const categoryLookup = new Map(
        (flatAccounts as Array<{ id: string; name: string }>).map((c) => [c.id, c.name]),
      );

      queryClient.setQueriesData(
        { queryKey: ["reconciliations", "detail", reconciliationId] },
        (old: any) => {
          if (!old) return old;
          return {
            ...old,
            ledgerTransactions: old.ledgerTransactions.map((t: LedgerTransaction) => {
              const edit = pendingEdits.get(t.id);
              if (!edit) return t;
              return {
                ...t,
                ...(edit.partyId
                  ? {
                      partyId: edit.partyId,
                      partyName: partyLookup.get(edit.partyId) ?? t.partyName,
                    }
                  : {}),
                ...(edit.categoryAccountId
                  ? {
                      categoryAccountId: edit.categoryAccountId,
                      categoryName: categoryLookup.get(edit.categoryAccountId) ?? t.categoryName,
                    }
                  : {}),
              };
            }),
          };
        },
      );

      setPendingEdits(new Map());

      setTimeout(() => {
        queryClient.invalidateQueries({
          queryKey: ["reconciliations", "detail", reconciliationId],
        });
      }, 800);
    } catch {
      // Error handled by mutation onError
    }
  }, [
    pendingEdits,
    recon,
    allParties,
    flatAccounts,
    updateBatchMutation,
    queryClient,
    reconciliationId,
  ]);

  // Cross-hover: auto-switch doc viewer page + auto-scroll transaction list
  useEffect(() => {
    // Use either direct statement hover OR bridged ledger hover
    const activeLineId = hoveredStatementLineId || linkedStatementLineId;
    if (!activeLineId) return;
    // Auto-switch page on doc viewer
    const page = statementLinePageMap.get(activeLineId);
    if (page != null) {
      const targetPage = page + 1; // 1-indexed
      if (targetPage !== statementPage) {
        setStatementPage(targetPage);
      }
    }
    // Auto-scroll the transaction row into view
    const row = document.querySelector(`[data-statement-line-id="${activeLineId}"]`);
    if (row) {
      row.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [hoveredStatementLineId, linkedStatementLineId, statementLinePageMap, statementPage]);

  if (!session?.user) return null;

  if (detailQuery.isLoading) {
    return (
      <div className="flex flex-col h-screen bg-gradient-to-br from-[#edf5f0] via-[#f0f7f2] to-[#f8fbf9] dark:from-[#0c1a12] dark:via-[#0f1f16] dark:to-[#0f172a]">
        <div className="shrink-0 h-14 bg-gradient-to-r from-[#1a6b3c] to-[#27ae60] dark:from-[#145a30] dark:to-[#1e8c4c] animate-pulse" />
        <div className="flex-1 flex gap-1 p-1">
          <div className="flex-1 bg-white/60 dark:bg-white/5 rounded-xl animate-pulse" />
          <div className="flex-1 bg-white/60 dark:bg-white/5 rounded-xl animate-pulse" />
          <div className="w-80 bg-white/60 dark:bg-white/5 rounded-xl animate-pulse" />
        </div>
      </div>
    );
  }

  if (!recon) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="text-center">
          <h2 className="text-lg font-semibold text-gray-800 dark:text-white">
            Reconciliation not found
          </h2>
          <Link
            to={"/reconciliations" as string & {}}
            className="text-sm text-emerald-600 dark:text-emerald-400 mt-2 inline-block"
          >
            ← Back to Reconciliations
          </Link>
        </div>
      </div>
    );
  }

  const statusConfig = STATUS_LABELS[recon.status] ?? STATUS_LABELS.not_started;
  const periodLabel = formatPeriodLabel(recon.periodStart, recon.periodEnd);

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-[#f0f2f5] dark:bg-[#0b1015]">
      {/* ── Top Navigation Bar (light) ──────────────────────── */}
      <header className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 bg-white dark:bg-[#111820] border-b border-gray-200/60 dark:border-white/5 shrink-0">
        <Link
          to={"/reconciliations" as string & {}}
          className="flex items-center gap-1.5 text-[13px] text-gray-500 dark:text-white/50 hover:text-gray-800 dark:hover:text-white transition-colors"
          title="Back to Reconciliations"
        >
          <svg
            width="32"
            height="32"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </Link>

        {/* View / Edit toggle */}
        <div className="flex items-center bg-gray-100 dark:bg-white/5 rounded-lg p-0.5 gap-0.5">
          <button
            type="button"
            onClick={() => {
              setPageMode("view");
              setPendingEdits(new Map());
              setReconcileTargetTxnId(null);
            }}
            className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-md text-[12px] font-medium transition-all ${
              pageMode === "view"
                ? "bg-white dark:bg-white/10 text-gray-800 dark:text-white shadow-sm"
                : "text-gray-400 dark:text-white/30 hover:text-gray-600 dark:hover:text-white/50"
            }`}
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
            View
          </button>
          <button
            type="button"
            onClick={() => !isFinalized && setPageMode("edit")}
            disabled={isFinalized}
            className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-md text-[12px] font-medium transition-all ${
              pageMode === "edit"
                ? "bg-white dark:bg-white/10 text-gray-800 dark:text-white shadow-sm"
                : "text-gray-400 dark:text-white/30 hover:text-gray-600 dark:hover:text-white/50"
            } ${isFinalized ? "opacity-40 cursor-not-allowed" : ""}`}
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
              <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
            </svg>
            Edit
          </button>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {/* Remove Statement Confirmation Modal */}
          <RemoveStatementModal
            isOpen={showRemoveStatementConfirm}
            onClose={() => setShowRemoveStatementConfirm(false)}
            onConfirm={confirmRemoveStatement}
            isPending={removeStatementMutation.isPending}
          />

          {/* Reconfigure Modal */}
          <button
            type="button"
            onClick={() => setShowReconfigureModal(true)}
            className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium text-gray-500 dark:text-white/40 hover:bg-gray-100 dark:hover:bg-white/5 transition-colors"
          >
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
            </svg>
            Reconfigure
          </button>

          {!isFinalized && (
            <button
              type="button"
              onClick={() => setShowFinalizeConfirm(true)}
              className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-[#1a6b3c] text-white text-[12px] font-medium hover:bg-[#15572f] transition-colors"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <polyline points="20 6 9 17 4 12" />
              </svg>
              Finalize…
            </button>
          )}
          {isFinalized && (
            <button
              type="button"
              onClick={() => reopenMutation.mutate()}
              disabled={reopenMutation.isPending}
              className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg border border-amber-400 text-amber-700 dark:text-amber-300 text-[12px] font-medium hover:bg-amber-50 dark:hover:bg-amber-500/10 transition-colors disabled:opacity-50"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <polyline points="1 4 1 10 7 10" />
                <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
              </svg>
              {reopenMutation.isPending ? "Reopening…" : "Reopen"}
            </button>
          )}

          {/* Delete (non-finalized only) */}
          {!isFinalized && (
            <button
              type="button"
              onClick={() => setShowDeleteConfirm(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10 text-[12px] font-medium transition-colors"
              title="Delete Reconciliation"
            >
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
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
              </svg>
              Delete
            </button>
          )}
        </div>
      </header>

      {/* ── Three-Panel Layout ──────────────────────────────── */}
      <div className="flex-1 flex gap-4 overflow-hidden p-2 md:p-4 relative">
        {/* Left Panel: Document Viewer */}
        {showLeftPanel && (
          <>
            {/* Backdrop for floating panel on small screens */}
            <div
              className="fixed inset-0 bg-black/40 z-30 lg:hidden"
              onClick={() => setShowLeftPanel(false)}
              onKeyDown={() => {}}
              role="presentation"
            />
            <div className="fixed inset-y-0 left-0 z-40 w-[90vw] max-w-[500px] lg:relative lg:inset-auto lg:z-auto lg:w-auto flex flex-col bg-white dark:bg-[#111820] rounded-xl overflow-hidden shadow-sm lg:flex-1 lg:min-w-[450px] lg:max-w-none lg:shrink-0">
              <Suspense
                fallback={
                  <div className="px-4 py-6 text-sm text-slate-500 dark:text-white/60">
                    Loading statement viewer…
                  </div>
                }
              >
                <ReconciliationDocumentViewer
                  imageUrl={statementImageUrl || recon.statementPreviewImageUrl || null}
                  pdfDataUrl={recon.statementPdfUrl}
                  boundingBoxes={(() => {
                    // Use server-mapped statementLineBoundingBoxes (derived from document ocrBoundingBoxes)
                    const bboxes = (recon.statementLineBoundingBoxes ?? []) as Array<{
                      id: string;
                      label: string;
                      text?: string;
                      bbox: [number, number, number, number];
                      page: number;
                      fieldType: string;
                    }>;

                    // Map transaction boxes with match status
                    const transactionBoxes = bboxes.filter((b) => b.fieldType === "transaction");

                    const mappedBoxes = transactionBoxes.map((b) => {
                      const sl = recon.statementLines.find((s) => s.id === b.id);
                      const isMatched = sl
                        ? sl.matchStatus === "matched" || sl.matchStatus === "ignored"
                        : false;

                      return {
                        statementLineId: b.id,
                        label: b.label,
                        amount: b.text,
                        bbox: b.bbox,
                        page: b.page,
                        isMatched,
                        originalId: b.id,
                      };
                    });

                    // Filter out ghost boxes (unmatched overlapping matched)
                    const matchedBoxes = mappedBoxes.filter((b) => b.isMatched);

                    return mappedBoxes.filter((b) => {
                      if (b.isMatched) return true;

                      const isGhost = matchedBoxes.some((m) => {
                        if (m.page !== b.page) return false;
                        const [ymin1, xmin1, ymax1, xmax1] = b.bbox;
                        const [ymin2, xmin2, ymax2, xmax2] = m.bbox;

                        const intersects = !(
                          xmin1 > xmax2 ||
                          xmax1 < xmin2 ||
                          ymin1 > ymax2 ||
                          ymax1 < ymin2
                        );
                        if (!intersects) return false;

                        const xOverlap = Math.max(
                          0,
                          Math.min(xmax1, xmax2) - Math.max(xmin1, xmin2),
                        );
                        const yOverlap = Math.max(
                          0,
                          Math.min(ymax1, ymax2) - Math.max(ymin1, ymin2),
                        );
                        const overlapArea = xOverlap * yOverlap;
                        const bArea = (xmax1 - xmin1) * (ymax1 - ymin1);

                        return overlapArea > bArea * 0.3;
                      });

                      return !isGhost;
                    });
                  })()}
                  imageUrls={recon.statementPageImageUrls}
                  activeLineId={
                    hoveredStatementLineId || selectedStatementLineId || linkedStatementLineId
                  }
                  onLineHover={setHoveredStatementLineId}
                  onLineSelect={handleLineSelect}
                  currentPage={statementPage}
                  totalPages={recon.statementPageCount || 1}
                  onPageChange={setStatementPage}
                  onUploadStatement={isFinalized ? undefined : handleUploadStatement}
                  isUploading={uploadStatementMutation.isPending || statementPipelinePending}
                  uploadError={uploadError}
                  validationWarnings={validationWarnings}
                  reconcileMode={!!reconcileTargetTxnId}
                  onReconcileSelect={handleReconcileFromBbox}
                  onCreateFromBbox={(slId) => handleCreateTransactionFromStatement(slId)}
                  onQuickMatchFromBbox={(statementLineId, journalLineId) => {
                    matchMutation.mutate({
                      reconciliationId,
                      statementLineId,
                      journalLineId,
                      action: "match",
                    });
                  }}
                  matchCandidateMap={unmatchedLedgerByAmount}
                  matchingLineId={lastMatchedLineId}
                  onGenerateStatement={
                    isFinalized || !import.meta.env.DEV ? undefined : handleGenerateStatement
                  }
                  isGenerating={generateStatementMutation.isPending}
                  onRemoveStatement={isFinalized ? undefined : handleRemoveStatement}
                  isRemoving={removeStatementMutation.isPending}
                  onRunOcr={isFinalized ? undefined : handleRunOcr}
                  isRunningOcr={isRunningOcr}
                  onRerunExtraction={isFinalized ? undefined : handleRerunExtraction}
                  isRerunningExtraction={
                    rerunExtractionMutation.isPending || statementPipelinePending
                  }
                />
              </Suspense>
            </div>
          </>
        )}

        {/* Center Panel: layout */}
        <div ref={centerRef} className="flex flex-col overflow-hidden flex-1 min-h-0">
          {/* ── Dark Teal Sub-Header ── */}
          <div className="bg-gradient-to-r from-[#1a6b3c] to-[#27ae60] dark:from-[#145a30] dark:to-[#1e8c4c] px-3 md:px-5 py-2.5 md:py-3.5 rounded-t-xl">
            {/* Row 1: Left Toggle + Title + Right Toggle */}
            <div className="flex items-center gap-2 md:gap-3">
              {/* Left Toggle */}
              <button
                type="button"
                onClick={() => setShowLeftPanel(!showLeftPanel)}
                className={`touch-target w-9 h-9 rounded-lg flex items-center justify-center shrink-0 transition-all ${
                  showLeftPanel
                    ? "bg-white/15 text-white shadow-sm"
                    : "bg-transparent text-white/50 hover:bg-white/10 hover:text-white"
                }`}
                title={showLeftPanel ? "Hide Document Viewer" : "Show Document Viewer"}
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
                  <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                  <line x1="9" y1="3" x2="9" y2="21" />
                </svg>
              </button>

              {/* Title + Status (inline on md+) */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <h1 className="text-[13px] md:text-[15px] font-semibold text-white truncate">
                    {recon.bankAccountName}
                  </h1>

                  {!centerNarrow && (
                    <span
                      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium shrink-0 ${statusConfig.bg} ${statusConfig.color}`}
                    >
                      {statusConfig.label}
                    </span>
                  )}
                </div>
              </div>

              {/* Period Label (visible when wide) */}
              {!centerNarrow && (
                <span className="inline-flex items-center gap-1.5 bg-white/15 text-white px-3 py-1.5 h-9 rounded-lg text-[13px] font-medium">
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
                    <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
                    <line x1="16" y1="2" x2="16" y2="6" />
                    <line x1="8" y1="2" x2="8" y2="6" />
                    <line x1="3" y1="10" x2="21" y2="10" />
                  </svg>
                  {periodLabel}
                </span>
              )}

              {/* Right Toggle */}
              <button
                type="button"
                onClick={() => setShowRightPanel((prev) => !prev)}
                className={`touch-target w-9 h-9 rounded-lg flex items-center justify-center shrink-0 transition-all ${
                  showRightPanel
                    ? "bg-white/15 text-white shadow-sm"
                    : "bg-transparent text-white/50 hover:bg-white/10 hover:text-white"
                }`}
                title={showRightPanel ? "Hide Sidebar" : "Show Sidebar"}
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
                  <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                  <line x1="15" y1="3" x2="15" y2="21" />
                </svg>
              </button>
            </div>

            {/* Row 2: Status + Period Label (mobile only) */}
            {centerNarrow && (
              <div className="flex items-center gap-2 mt-2">
                <span
                  className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium shrink-0 ${statusConfig.bg} ${statusConfig.color}`}
                >
                  {statusConfig.label}
                </span>
                <span className="ml-auto inline-flex items-center gap-1.5 bg-white/15 text-white px-3 py-1.5 h-9 rounded-lg text-[13px] font-medium">
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
                    <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
                    <line x1="16" y1="2" x2="16" y2="6" />
                    <line x1="8" y1="2" x2="8" y2="6" />
                    <line x1="3" y1="10" x2="21" y2="10" />
                  </svg>
                  {periodLabel}
                </span>
              </div>
            )}
          </div>

          {/* ── White card body overlapping sub-header ── */}
          <div className="flex-1 flex flex-col bg-white dark:bg-[#111820] rounded-b-xl overflow-hidden shadow-sm -mt-1 min-h-0">
            {/* Summary Row: Charges/Payments for credit cards, Deposits/Withdrawals for bank */}
            <SummaryRow recon={recon} isNarrow={centerNarrow} />

            {/* Search / Filter Bar */}
            <div className="relative z-10">
              <ReconciliationSearchBar
                searchQuery={searchQuery}
                onSearchChange={setSearchQuery}
                matchedCount={metrics.matched}
                unmatchedCount={metrics.unmatched}
                onToggleFilters={() => setFiltersOpen(!filtersOpen)}
                statusFilter={reconStatusFilter}
                onToggleStatusFilter={(status) => {
                  const next = (reconStatusFilter === status ? "all" : status) as ReconStatusFilter;
                  setReconStatusFilter(next);
                  // Don't sync statusFilter — reconStatusFilter handles statement line filtering directly
                }}
                hasActiveFilters={
                  typeFilter.length > 0 ||
                  statusFilter.length > 0 ||
                  sourceFilter.length > 0 ||
                  matchedFilter.length > 0 ||
                  partyFilter.length > 0 ||
                  departmentFilter.length > 0 ||
                  locationFilter.length > 0 ||
                  amountMin !== "" ||
                  amountMax !== ""
                }
                onAddTransaction={() => {
                  const params = new URLSearchParams();
                  // Pre-fill the Ledger Account if mapped, otherwise Bank Account
                  if (recon.ledgerAccountId) {
                    params.set("accountId", recon.ledgerAccountId);
                  } else if (recon.bankAccountId) {
                    params.set("accountId", recon.bankAccountId);
                  }
                  navigate({ to: `/transactions/new?${params.toString()}` as string & {} });
                }}
                filterChips={[
                  ...typeFilter.map((t) => ({
                    id: `type-${t}`,
                    label:
                      t === "pay_in"
                        ? "Pay In"
                        : t === "pay_out"
                          ? "Pay Out"
                          : t === "journal"
                            ? "Journal"
                            : t,
                    group: "type",
                  })),
                  ...sourceFilter.map((s) => ({ id: `source-${s}`, label: s, group: "source" })),
                  ...matchedFilter.map((m) => ({
                    id: `matched-${m}`,
                    label: m === "matched" ? "Matched" : "Unmatched",
                    group: "matched",
                  })),
                  ...partyFilter.map((p) => ({
                    id: `party-${p}`,
                    label: periodPartyOptions.find((o) => o.id === p)?.name ?? p,
                    group: "party",
                  })),
                  ...departmentFilter.map((d) => ({
                    id: `dept-${d}`,
                    label: periodDepartmentOptions.find((o) => o.id === d)?.name ?? d,
                    group: "department",
                  })),
                  ...locationFilter.map((l) => ({
                    id: `loc-${l}`,
                    label: periodLocationOptions.find((o) => o.id === l)?.name ?? l,
                    group: "location",
                  })),
                  ...(amountMin
                    ? [{ id: "amount-min", label: `Min: $${amountMin}`, group: "amount" }]
                    : []),
                  ...(amountMax
                    ? [{ id: "amount-max", label: `Max: $${amountMax}`, group: "amount" }]
                    : []),
                ]}
                onRemoveChip={(id) => {
                  if (id.startsWith("type-")) {
                    const val = id.replace("type-", "") as TransactionType;
                    setTypeFilter((prev) => prev.filter((t) => t !== val));
                  } else if (id.startsWith("status-")) {
                    const val = id.replace("status-", "") as JournalStatus;
                    setStatusFilter((prev) => prev.filter((s) => s !== val));
                  } else if (id.startsWith("source-")) {
                    const val = id.replace("source-", "") as SourceType;
                    setSourceFilter((prev) => prev.filter((s) => s !== val));
                  } else if (id.startsWith("matched-")) {
                    const val = id.replace("matched-", "") as MatchedStatus;
                    setMatchedFilter((prev) => prev.filter((m) => m !== val));
                  } else if (id.startsWith("party-")) {
                    const val = id.replace("party-", "");
                    setPartyFilter((prev) => prev.filter((p) => p !== val));
                  } else if (id.startsWith("dept-")) {
                    const val = id.replace("dept-", "");
                    setDepartmentFilter((prev) => prev.filter((d) => d !== val));
                  } else if (id.startsWith("loc-")) {
                    const val = id.replace("loc-", "");
                    setLocationFilter((prev) => prev.filter((l) => l !== val));
                  } else if (id === "amount-min") {
                    setAmountMin("");
                  } else if (id === "amount-max") {
                    setAmountMax("");
                  }
                }}
                onClearAll={() => {
                  setTypeFilter([]);
                  setStatusFilter([]);
                  setSourceFilter([]);
                  setMatchedFilter([]);
                  setPartyFilter([]);
                  setDepartmentFilter([]);
                  setLocationFilter([]);
                  setAmountMin("");
                  setAmountMax("");
                  setSearchQuery("");
                  setFiltersOpen(false);
                }}
              />

              <LedgerFilters
                isOpen={filtersOpen}
                onClose={() => setFiltersOpen(false)}
                typeFilter={typeFilter}
                statusFilter={statusFilter}
                sourceFilter={sourceFilter}
                matchedFilter={matchedFilter}
                amountMin={amountMin}
                amountMax={amountMax}
                partyFilter={partyFilter}
                partyOptions={filteredPartyOptions}
                partySearch={partySearch}
                onPartySearchChange={setPartySearch}
                onToggleParty={(id) => {
                  setPartyFilter((prev) =>
                    prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id],
                  );
                }}
                departmentFilter={departmentFilter}
                departmentOptions={filteredDepartmentOptions}
                departmentSearch={departmentSearch}
                onDepartmentSearchChange={setDepartmentSearch}
                onToggleDepartment={(id) => {
                  setDepartmentFilter((prev) =>
                    prev.includes(id) ? prev.filter((d) => d !== id) : [...prev, id],
                  );
                }}
                locationFilter={locationFilter}
                locationOptions={filteredLocationOptions}
                locationSearch={locationSearch}
                onLocationSearchChange={setLocationSearch}
                onToggleLocation={(id: string) => {
                  setLocationFilter((prev) =>
                    prev.includes(id) ? prev.filter((l) => l !== id) : [...prev, id],
                  );
                }}
                onToggleType={(type: TransactionType) => {
                  setTypeFilter((prev) =>
                    prev.includes(type) ? prev.filter((t) => t !== type) : [...prev, type],
                  );
                }}
                onToggleStatus={(status: JournalStatus) => {
                  setStatusFilter((prev) => {
                    const next = prev.includes(status)
                      ? prev.filter((s) => s !== status)
                      : [...prev, status];

                    return next;
                  });
                }}
                onToggleSource={(source: SourceType) => {
                  setSourceFilter((prev) =>
                    prev.includes(source) ? prev.filter((s) => s !== source) : [...prev, source],
                  );
                }}
                onToggleMatched={(status: MatchedStatus) => {
                  setMatchedFilter((prev) =>
                    prev.includes(status) ? prev.filter((s) => s !== status) : [...prev, status],
                  );
                }}
                onAmountChange={(min: string, max: string) => {
                  setAmountMin(min);
                  setAmountMax(max);
                }}
                onClearAll={() => {
                  setTypeFilter([]);
                  setStatusFilter([]);
                  setSourceFilter([]);
                  setMatchedFilter([]);
                  setAmountMin("");
                  setAmountMax("");
                  setPartyFilter([]);
                  setDepartmentFilter([]);
                  setLocationFilter([]);
                }}
              />
            </div>

            {/* View toggle (moved/styled or removed if not needed, keeping basic toggle for now if user wants persistence of view mode)
                  The "View" toggle is inside the search bar row on the far right, 
                  but our new ReconciliationSearchBar has a Plus button there. 
                  The previous code had "View" and "Edit" buttons in the HEADER. 
                  Wait, the previous code had "Statement" vs "Ledger" toggle pills in the search bar.
                  The user request screenshot DOES show the pill toggle for "13" (Counter) and "1" (Counter) but doesn't explicitly show "Statement/Ledger" text toggle.
                  However, functionality-wise we need to toggle between Statement and Ledger.
                  The "Counter" pills are just counters.
                  I should probably keep the Statement/Ledger toggle somewhere?
                  Actually, the user said "use the search and filter from /transactions instead".
                  But /transactions doesn't have "Statement" view.
                  I will assume the tabs are implicitly handled or I should add them back if needed.
                  The new design has "Shield" (Matched) and "Clock" (Unmatched). 
                  Clicking them could filter the view.
                  But we still need to switch between viewing Statement Lines vs Ledger Lines?
                  Both panels can be shown both side-by-side or toggled.
                  In this layout, it's a list.
                  I'll re-add the "Statement / Ledger" toggle below the search bar or integrated if strictly needed.
                  BUT the user didn't ask for it. They asked for the Search/Filter bar.
                  I will ADD the toggles back below the bar or inside the header if they are missing?
                  No, the previous code had them IN the bar.
                  I'll place them just below the search bar for now, or inside the search bar if I modify it.
                  Let's stick to the REQUESTED changes: "use the search and filter from /transactions instead... use this svg icons ... and ... icons on those section".
                  I'll just put the `ReconciliationSearchBar` and `LedgerFilters`.
                  Hide the explicit text toggle if it does not fit the search bar layout, OR 
                  I can add it as an extra element in the toolbar if helpful.
                  Actually, without the toggle, the user can't switch/see Ledger lines?
                  The user might expect the "Shield" to show matched and "Clock" to show unmatched for STATEMENT lines?
                  I'll keep `txnView` state but maybe defaults to 'statement'.
                  I'll add the View Toggle back as a small floating element or just below?
                  Better: Add it to the header?
                  The header already has "View / Edit" mode.
                  Let's look at the screenshot. The screenshot has "13 [shield]" and "1 [clock]" and a filter icon and a plus icon.
                  It DOES NOT show "Statement | Ledger" toggle in that bar.
                  It might be that the view is implied or switched elsewhere.
                  I will leave the toggle out of the *search bar* to match the visual, 
                  but I might need to place it elsewhere if I want to retain functionality.
                  I'll place it in the right side of the Custom Toolbar or just keep it hidden/default for now to match the screenshot EXACTLY.
              */}

            {/* Transaction list */}
            <div className="flex-1 overflow-y-auto relative min-h-0">
              {/* Not Found blur overlay — shown when hovering unmatched statement line */}
              {showNotFoundOverlay && (
                <div className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-white/80 dark:bg-[#111820]/85 backdrop-blur-md transition-all">
                  <div className="w-16 h-16 rounded-full bg-gray-100 dark:bg-white/10 flex items-center justify-center mb-4">
                    <svg
                      width="28"
                      height="28"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="text-gray-400 dark:text-gray-500"
                    >
                      <circle cx="11" cy="11" r="8" />
                      <line x1="21" y1="21" x2="16.65" y2="16.65" />
                    </svg>
                  </div>
                  <div className="text-lg font-semibold text-gray-900 dark:text-white mb-1">
                    Not Found
                  </div>
                  <div className="text-sm text-gray-500 dark:text-gray-400">
                    No matching ledger transaction
                  </div>
                </div>
              )}
              {/* InlineEditBar overlay */}
              {isEditMode && pendingEdits.size > 0 && (
                <div className="sticky top-0 z-20">
                  <InlineEditBar
                    editCount={pendingEdits.size}
                    isApplying={updateBatchMutation.isPending}
                    onCancel={handleInlineCancel}
                    onApply={handleInlineApply}
                  />
                </div>
              )}

              {txnView === "statement" ? (
                <StatementLinesList
                  lines={filteredStatementLines}
                  flags={recon.flags}
                  hoveredId={hoveredStatementLineId}
                  linkedId={linkedStatementLineId}
                  selectedId={selectedStatementLineId}
                  onHover={setHoveredStatementLineId}
                  onSelect={handleLineSelect}
                  isFinalized={isFinalized}
                  isEditMode={isEditMode}
                  onCreateTransaction={handleCreateTransactionFromStatement}
                  unmatchedLedgerByAmount={unmatchedLedgerByAmount}
                  onNavigateToTransaction={(journalHeaderId) => {
                    navigate({ to: `/transactions/${journalHeaderId}` as string & {} });
                  }}
                  onQuickMatch={(statementLineId, journalLineId) => {
                    matchMutation.mutate({
                      reconciliationId,
                      statementLineId,
                      journalLineId,
                      action: "match",
                    });
                  }}
                  onUnmatch={(statementLineId) => {
                    matchMutation.mutate({
                      reconciliationId,
                      statementLineId,
                      journalLineId: null,
                      action: "unmatch",
                    });
                  }}
                />
              ) : (
                <LedgerTransactionsList
                  transactions={filteredLedgerByStatus}
                  hoveredId={hoveredLedgerTxnId}
                  linkedId={linkedLedgerTxnId}
                  onHover={setHoveredLedgerTxnId}
                  onMatch={(journalLineId) => {
                    if (!selectedStatementLineId) return;
                    matchMutation.mutate({
                      reconciliationId,
                      statementLineId: selectedStatementLineId,
                      journalLineId,
                      action: "match",
                    });
                  }}
                  onUnmatch={(statementLineId) => {
                    matchMutation.mutate({
                      reconciliationId,
                      statementLineId,
                      journalLineId: null,
                      action: "unmatch",
                    });
                  }}
                  onStatusClick={(txn) => {
                    // Handle interactive status toggle in Edit Mode
                    if (txn.isMatched) {
                      // Find the statement line that matches this ledger txn
                      const stmtLineId = journalToStatementMap.get(txn.id);
                      if (stmtLineId) {
                        matchMutation.mutate({
                          reconciliationId,
                          statementLineId: stmtLineId,
                          journalLineId: null,
                          action: "unmatch",
                        });
                      }
                    } else if (selectedStatementLineId) {
                      // If statement line is selected, try to match to this unchecked transaction
                      matchMutation.mutate({
                        reconciliationId,
                        statementLineId: selectedStatementLineId,
                        journalLineId: txn.id,
                        action: "match",
                      });
                    }
                  }}
                  selectedStatementLineId={selectedStatementLineId}
                  isFinalized={isFinalized}
                  isEditMode={isEditMode}
                  pendingEdits={pendingEdits}
                  reconcileTargetTxnId={reconcileTargetTxnId}
                  onReconcileStart={(txnId) => setReconcileTargetTxnId(txnId)}
                  onReconcileCancel={() => setReconcileTargetTxnId(null)}
                />
              )}
            </div>
          </div>
        </div>

        {/* Right Panel: 4-tab Sidebar */}
        {showRightPanel && (
          <>
            {/* Backdrop for floating sidebar on small screens */}
            <div
              className="fixed inset-0 bg-black/40 z-30 xl:hidden"
              onClick={() => setShowRightPanel(false)}
              onKeyDown={() => {}}
              role="presentation"
            />
            <div className="fixed inset-y-0 right-0 z-40 w-[90vw] max-w-[365px] xl:relative xl:inset-auto xl:z-auto xl:w-[365px] flex flex-col bg-white dark:bg-[#111820] rounded-xl overflow-hidden shadow-sm xl:shrink-0">
              <ReconciliationSidebar
                reconciliation={recon}
                summary={recon.summary}
                flags={recon.flags}
                activityLog={activityQuery.data ?? []}
                isFinalized={isFinalized}
                onResolveFlag={handleResolveFlag}
                onCreateTransaction={(statementLineId) => {
                  if (statementLineId) {
                    handleCreateTransactionFromStatement(statementLineId);
                  } else {
                    // Fallback: find first unmatched statement line
                    const unmatchedLine = recon.statementLines.find(
                      (l) => l.matchStatus === "unmatched",
                    );
                    if (unmatchedLine) {
                      handleCreateTransactionFromStatement(unmatchedLine.id);
                    }
                  }
                }}
                unmatchedStatementCount={
                  recon.statementLines.filter((l) => l.matchStatus === "unmatched").length
                }
                matchCandidateCount={
                  recon.statementLines.filter((l) => {
                    if (l.matchStatus !== "unmatched") return false;
                    const key = Math.abs(Number.parseFloat(l.amount)).toFixed(2);
                    return unmatchedLedgerByAmount.has(key);
                  }).length
                }
                onLinkTransaction={() => {
                  // Auto-match the first unmatched statement line that has a match candidate
                  for (const line of recon.statementLines) {
                    if (line.matchStatus !== "unmatched") continue;
                    const key = Math.abs(Number.parseFloat(line.amount)).toFixed(2);
                    const candidate = unmatchedLedgerByAmount.get(key);
                    if (candidate) {
                      matchMutation.mutate({
                        reconciliationId,
                        statementLineId: line.id,
                        journalLineId: candidate.id,
                        action: "match",
                      });
                      return;
                    }
                  }
                }}
                suggestions={suggestionsQuery.data ?? []}
                onApplySuggestion={(id) => applySuggestionMutation.mutate(id)}
                onDismissSuggestion={(id) => dismissSuggestionMutation.mutate(id)}
                onUploadStatement={handleUploadStatement}
                // agentResult={agentResult}
                onRemoveStatement={handleRemoveStatement}
              />
            </div>
          </>
        )}
      </div>

      {/* ── Reconfigure Modal ── */}
      <ReconfigureModal
        isOpen={showReconfigureModal}
        onClose={() => setShowReconfigureModal(false)}
        onSubmit={(data) => {
          reconfigureMutation.mutate({
            id: reconciliationId,
            periodStart: recon.periodStart,
            periodEnd: data.periodEnd,
            statementEndingBalance: data.statementEndingBalance || undefined,
            charges: data.deposits || undefined,
            payments: data.withdrawals || undefined,
          });
        }}
        isPending={reconfigureMutation.isPending}
        bankAccountName={recon.bankAccountName}
        bankAccountNumber={recon.bankAccountNumber}
        accountType={recon.accountType}
        currentPeriodEnd={recon.periodEnd}
        currentStatementEndingBalance={recon.statementEndingBalance}
        statementImageUrl={statementImageUrl || recon.statementPreviewImageUrl}
      />

      {/* ── Locked Statement PDF Password Prompt ── */}
      {passwordPrompt && (
        <PasswordPromptModal
          fileName={
            passwordPrompt.mode === "upload" ? passwordPrompt.lastInput.fileName : undefined
          }
          isSubmitting={isUnlocking}
          error={
            passwordPrompt.status === "wrong_password"
              ? "Incorrect password. Please try again."
              : null
          }
          saveOption={{
            kind: "fixed",
            accountId: recon.bankAccountId,
            accountLabel: recon.bankAccountName || "this bank account",
          }}
          onSubmit={handleSubmitStatementPassword}
          onCancel={() => setPasswordPrompt(null)}
        />
      )}

      {/* ── Delete Confirmation Dialog ── */}
      {/* Finalize confirmation modal */}
      {showFinalizeConfirm && (
        <ConfirmModal
          title="Finalize Reconciliation"
          subtitle="Once finalized, this reconciliation becomes read-only. All matches and flags will be locked. You can reopen it later if needed."
          message={
            <>
              {/* Summary stats */}
              <div className="bg-zinc-50 dark:bg-zinc-800 rounded-lg p-4 mb-4 space-y-2">
                <div className="flex justify-between text-sm">
                  <span className="text-zinc-500 dark:text-zinc-400">Statement Lines</span>
                  <span className="font-medium text-zinc-900 dark:text-zinc-100">
                    {metrics.matched} of {metrics.totalStatement} matched
                  </span>
                </div>
                {metrics.ignored > 0 && (
                  <div className="flex justify-between text-sm">
                    <span className="text-zinc-500 dark:text-zinc-400">Ignored</span>
                    <span className="font-medium text-zinc-500">{metrics.ignored}</span>
                  </div>
                )}
                <div className="flex justify-between text-sm">
                  <span className="text-zinc-500 dark:text-zinc-400">Ledger Transactions</span>
                  <span className="font-medium text-zinc-900 dark:text-zinc-100">
                    {metrics.ledgerMatched} of {metrics.totalLedger} reconciled
                  </span>
                </div>
              </div>

              {/* Warning if unmatched items */}
              {metrics.unmatched > 0 && (
                <div className="flex items-start gap-2 bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/20 rounded-lg p-3 mb-4">
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    className="text-amber-600 dark:text-amber-400 mt-0.5 shrink-0"
                  >
                    <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                    <line x1="12" y1="9" x2="12" y2="13" />
                    <line x1="12" y1="17" x2="12.01" y2="17" />
                  </svg>
                  <span className="text-sm text-amber-800 dark:text-amber-300">
                    {metrics.unmatched} statement line{metrics.unmatched !== 1 ? "s" : ""} still
                    unmatched. You can still finalize, but these items won&apos;t be reconciled.
                  </span>
                </div>
              )}

              {finalizeMutation.isError && (
                <p className="text-sm text-red-600 mb-4">
                  {(finalizeMutation.error as Error)?.message ?? "Failed to finalize"}
                </p>
              )}
            </>
          }
          confirmLabel={finalizeMutation.isPending ? "Finalizing…" : "Finalize"}
          cancelLabel="Cancel"
          onConfirm={() => finalizeMutation.mutate()}
          onCancel={() => setShowFinalizeConfirm(false)}
          isLoading={finalizeMutation.isPending}
          destructive={false}
          icon={
            <svg
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <polyline points="20 6 9 17 4 12" />
            </svg>
          }
        />
      )}

      {showDeleteConfirm && (
        <ConfirmModal
          title="Delete Reconciliation"
          subtitle="Are you sure you want to delete this reconciliation? This will permanently remove all statement lines, matches, and flags. This action cannot be undone."
          message={
            deleteMutation.isError && (
              <p className="text-sm text-red-600 mb-4">
                {(deleteMutation.error as Error)?.message ?? "Failed to delete"}
              </p>
            )
          }
          confirmLabel={deleteMutation.isPending ? "Deleting…" : "Delete"}
          cancelLabel="Cancel"
          onConfirm={() => deleteMutation.mutate()}
          onCancel={() => setShowDeleteConfirm(false)}
          isLoading={deleteMutation.isPending}
          destructive={true}
        />
      )}

      {/* Floating OCR progress card */}
      <OcrProgress />
    </div>
  );
}

// ============================================================================
// Extracted Components — see /src/components/reconciliations/
// SummaryRow + SummaryCard  → ReconSummary.tsx
// StatementLinesList        → StatementLinesList.tsx
// LedgerTransactionsList    → LedgerTransactionsList.tsx
// formatPeriodLabel, formatMoney → reconHelpers.ts
// ============================================================================
