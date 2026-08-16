/**
 * Transaction Detail Page — /transactions/$transactionId
 * Displays a single transaction with View/Edit toggle and right sidebar.
 * Uses extracted form components with readOnly prop for View mode.
 */
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { HeaderDiff, LineEntry, HeaderSnapshotField } from "@/types/transaction-audit";
import {
  getTransaction,
  updateTransaction,
  listActivityLogs,
  getSimilarTransactions,
  deleteTransactionsBatch,
} from "./api/-transactions";
import { usePermission } from "../lib/use-permission";
import {
  listDocumentAttachments,
  uploadDocument,
  attachDocument,
  listDocuments,
  getDocumentUrl,
  updateDocument,
  detachDocument,
  deleteDocument,
} from "./api/-documents";
import { unmatchTransaction } from "./api/-match-transactions";
import { useToast } from "../components/ui/Toast";
import { CommentThread } from "../components/comments/CommentThread";
import { getPartyTransactionSummary } from "./api/-parties";
import { listDepartments, listLocations } from "./api/-dimensions";
import { listParties, createParty } from "./api/-parties";
import { useTransactionAccounts } from "../hooks/useTransactionAccounts";
import { getReadPartyTypes, getMutatePartyTypes, toPartyApiFilter } from "../lib/party-scoping";
import type { PartyType } from "../lib/party-scoping";
import { ICON_PATHS } from "../components/accounts/icons";
import MultiAvatar from "../components/transactions/shared/MultiAvatar";
import type { AvatarItem } from "../components/transactions/shared/MultiAvatar";
import { formatPartyNames } from "../components/transactions/shared/formatPartyNames";
import ConfirmModal from "../components/shared/ConfirmModal";
// Shared modules
import type { TabType, JournalLine, PayForLine } from "../components/transactions/shared/types";
import Combobox from "../components/ui/Combobox";
import DayPicker from "../components/ui/DayPicker";
import type { ComboboxOption } from "../components/ui/Combobox";
import { TABS, TYPE_LABELS } from "../components/transactions/shared/constants";
import {
  formatCurrency,
  formatDate,
  formatRelativeTime,
  createKey,
  emptyJournalLine,
  emptyPayForLine,
} from "../components/transactions/shared/helpers";
import JournalForm from "../components/transactions/forms/JournalForm";
import PayForm from "../components/transactions/forms/PayForm";
import TransferForm from "../components/transactions/forms/TransferForm";
import { createLogger } from "../lib/logger";
import { callServerFn } from "../lib/server-fn-client";
import { useEscapeKey } from "../hooks/useOverlayBehavior";
import { useIsCompactNav } from "../hooks/useBreakpoint";

const logger = createLogger("ui.transaction-detail");

type TransactionRecord = Awaited<ReturnType<typeof getTransaction>>;
type SimilarTransactionRecord = Awaited<ReturnType<typeof getSimilarTransactions>>[number];
type PartyRecord = Awaited<ReturnType<typeof listParties>>[number];
type DimensionRecord = Awaited<ReturnType<typeof listDepartments>>[number];
type UnmatchRequest = {
  mergeId: string;
  reason: string;
  idempotencyKey: string;
};
type UnmatchResult = {
  success: boolean;
  mergeId: string;
  canonicalTransactionId: string;
  restoredTransactionId: string;
  state: string;
  replayed: boolean;
};
type UnmatchServerFn = (opts: { data: UnmatchRequest }) => Promise<UnmatchResult>;

// ============================================================================
// Route
// ============================================================================

export const Route = createFileRoute("/transactions_/$transactionId")({
  component: TransactionDetailPage,
});

// ============================================================================
// Component
// ============================================================================

function TransactionDetailPage() {
  const { transactionId } = Route.useParams();

  // ── Mode toggle ──
  const [mode, setMode] = useState<"view" | "edit">("view");
  const [sidebarTab, setSidebarTab] = useState<"comments" | "insights" | "activity">("activity");
  const [showSidebar, setShowSidebar] = useState(false);
  // The sidebar is a docked column at `lg` and an overlay below it, so it shares one DOM tree and
  // cannot be a <Modal>. Escape still has to dismiss it while it is presenting as an overlay —
  // but only then: at `lg` the column is permanent, and binding Escape to a flag that no longer
  // controls visibility leaves a key that silently does nothing.
  const isCompactLayout = useIsCompactNav();
  const closeSidebar = useCallback(() => setShowSidebar(false), []);
  useEscapeKey(isCompactLayout && showSidebar, closeSidebar);
  useEffect(() => {
    if (!isCompactLayout) setShowSidebar(false);
  }, [isCompactLayout]);
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const navigate = useNavigate();
  const { canAccess: canDelete } = usePermission("journal", "delete");
  const { canAccess: canUnmatch } = usePermission("journal", "unmatch");
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [unmatchMergeId, setUnmatchMergeId] = useState<string | null>(null);
  const [unmatchReason, setUnmatchReason] = useState("");
  const unmatchIdempotencyKeyRef = useRef<string | null>(null);

  // ── Edit state ──
  const [editType, setEditType] = useState<TabType | null>(null);
  const [editMemo, setEditMemo] = useState("");
  const [editDate, setEditDate] = useState("");
  const [editPartyId, setEditPartyId] = useState("");
  const [editRefNumber, setEditRefNumber] = useState("");
  const [editJournalLines, setEditJournalLines] = useState<JournalLine[]>([]);

  // ── Journal party names (for multi-avatar in edit mode) ──
  const [journalPartyNames, setJournalPartyNames] = useState<Record<string, string>>({});
  const handleJournalPartyNameChange = useCallback((lineKey: string, name: string) => {
    setJournalPartyNames((prev) => (prev[lineKey] === name ? prev : { ...prev, [lineKey]: name }));
  }, []);
  const [editPayCategoryId, setEditPayCategoryId] = useState("");
  const [editPayLines, setEditPayLines] = useState<PayForLine[]>([]);
  const [editTransferFrom, setEditTransferFrom] = useState("");
  const [editTransferTo, setEditTransferTo] = useState("");
  const [editTransferAmount, setEditTransferAmount] = useState("");
  const [editTransferFromParty, setEditTransferFromParty] = useState("");
  const [editTransferToParty, setEditTransferToParty] = useState("");
  const [editAmount, setEditAmount] = useState("");
  const [partyQuery, setPartyQuery] = useState("");
  const [showTypeDropdown, setShowTypeDropdown] = useState(false);
  const typeDropdownRef = useRef<HTMLDivElement>(null);

  // Close type dropdown on outside click
  useEffect(() => {
    if (!showTypeDropdown) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (typeDropdownRef.current && !typeDropdownRef.current.contains(e.target as Node)) {
        setShowTypeDropdown(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showTypeDropdown]);

  // ── Transaction data ──
  const { data: transaction, isLoading } = useQuery<TransactionRecord>({
    queryKey: ["transaction", transactionId],
    queryFn: () =>
      callServerFn(getTransaction, { data: { id: transactionId } }) as Promise<TransactionRecord>,
    refetchOnMount: "always",
  });

  // ── Activity logs ──
  const { data: activityLogEntries = [] } = useQuery({
    queryKey: ["activity-logs", "transaction", transactionId],
    queryFn: () =>
      callServerFn(listActivityLogs, {
        data: { entityType: "transaction", entityId: transactionId },
      }),
    enabled: !!transactionId,
  });

  // ── Account data ──
  const { flatAccounts, typedOverrides } = useTransactionAccounts();

  // ── Departments ──
  const { data: departmentsRaw = [] } = useQuery({
    queryKey: ["departments"],
    queryFn: () => callServerFn(listDepartments, { data: {} }),
    structuralSharing: false,
  });

  const departmentOptions: ComboboxOption[] = useMemo(
    () =>
      departmentsRaw
        .filter((d: DimensionRecord) => d.isActive !== false)
        .map((d: DimensionRecord) => ({ value: d.id, label: d.name })),
    [departmentsRaw],
  );

  // ── Locations ──
  const { data: locationsRaw = [] } = useQuery({
    queryKey: ["locations"],
    queryFn: () => callServerFn(listLocations, { data: {} }),
    structuralSharing: false,
  });

  const locationOptions: ComboboxOption[] = useMemo(
    () =>
      locationsRaw
        .filter((l: DimensionRecord) => l.isActive !== false)
        .map((l: DimensionRecord) => ({ value: l.id, label: l.name })),
    [locationsRaw],
  );

  // ── Party Insights ──
  const currentYear = new Date().getFullYear();
  const prevYear = currentYear - 1;
  const { data: partySummary } = useQuery({
    queryKey: ["partyTransactionSummary", transaction?.partyId, currentYear],
    queryFn: () =>
      callServerFn(getPartyTransactionSummary, {
        data: { partyId: transaction?.partyId ?? "", year: currentYear },
      }),
    enabled: !!transaction?.partyId,
  });
  const { data: prevYearSummary } = useQuery({
    queryKey: ["partyTransactionSummary", transaction?.partyId, prevYear],
    queryFn: () =>
      callServerFn(getPartyTransactionSummary, {
        data: { partyId: transaction?.partyId ?? "", year: prevYear },
      }),
    enabled: !!transaction?.partyId,
  });

  // ── Similar Transactions ──
  const { data: similarTransactions } = useQuery({
    queryKey: ["similarTransactions", transactionId],
    queryFn: () => callServerFn(getSimilarTransactions, { data: { transactionId } }),
    enabled: !!transactionId,
  });

  // ── Determine read-only ──
  const isVoided = transaction?.status === "voided";
  const isLocked = transaction?.isLocked === true;
  const closedThrough = transaction?.closedThrough as string | null;
  const readOnly = mode === "view" || isVoided || isLocked;

  // ── Build journal lines from transaction data ──
  const journalLines: JournalLine[] = useMemo(() => {
    if (!transaction?.lines) return [emptyJournalLine(), emptyJournalLine()];
    return transaction.lines.map((line, idx) => ({
      key: `existing-${line.id || idx}`,
      description: line.lineDescription || "",
      categoryId: line.accountId || "",
      partyId: line.partyId || "",
      departmentId: line.departmentId || "",
      locationId: line.locationId || "",
      debit: line.debit || "",
      credit: line.credit || "",
    }));
  }, [transaction]);

  // ── Build pay-for lines ──
  const { payForLines, payCategoryId } = useMemo(() => {
    if (
      !transaction?.lines ||
      (transaction.transactionType !== "pay_in" && transaction.transactionType !== "pay_out")
    ) {
      return { payForLines: [emptyPayForLine()] as PayForLine[], payCategoryId: "" };
    }

    const isPayIn = transaction.transactionType === "pay_in";
    const categoryLine = transaction.lines.find((l) =>
      isPayIn
        ? l.debit && Number.parseFloat(l.debit) > 0
        : l.credit && Number.parseFloat(l.credit) > 0,
    );
    const payLines = transaction.lines
      .filter((l) => l !== categoryLine)
      .map((l, idx) => ({
        key: `pay-${l.id || idx}`,
        description: l.lineDescription || "",
        categoryId: l.accountId || "",
        departmentId: l.departmentId || "",
        locationId: l.locationId || "",
        amount: isPayIn ? l.credit || "" : l.debit || "",
      }));

    return {
      payForLines: payLines.length > 0 ? payLines : [emptyPayForLine()],
      payCategoryId: categoryLine?.accountId || "",
    };
  }, [transaction]);

  // ── Build transfer data ──
  const transferData = useMemo(() => {
    if (!transaction?.lines || transaction.transactionType !== "transfer") {
      return { fromCategory: "", toCategory: "", amount: "" };
    }
    const debitLine = transaction.lines.find((l) => l.debit && Number.parseFloat(l.debit) > 0);
    const creditLine = transaction.lines.find((l) => l.credit && Number.parseFloat(l.credit) > 0);
    return {
      toCategory: debitLine?.accountId || "",
      fromCategory: creditLine?.accountId || "",
      amount: debitLine?.debit || creditLine?.credit || "",
    };
  }, [transaction]);

  // Aggregate preferred party types from ALL line categories in the current transaction.
  // This mirrors the logic in transactions_.new.tsx for Pay In / Pay Out forms,
  // but also covers journal mode where each line can have its own category.
  const currentLines = mode === "edit" ? editJournalLines : journalLines;
  const currentPayLines = mode === "edit" ? editPayLines : payForLines;
  const activeType: TabType =
    mode === "edit" && editType
      ? editType
      : ((transaction?.transactionType as TabType) ?? "journal");

  const partyTypeFilter = useMemo(() => {
    // Determine which lines to inspect based on transaction type
    const linesToInspect =
      activeType === "pay_in" || activeType === "pay_out" ? currentPayLines : currentLines;

    const linesWithCategory = linesToInspect.filter((line) => line.categoryId);
    if (linesWithCategory.length === 0) return "all" as const;

    const allTypes = new Set<PartyType>();
    for (const line of linesWithCategory) {
      const acct = flatAccounts.find((a) => a.id === line.categoryId);
      if (!acct) continue;
      // Walk up parent chain to resolve subtype if not directly set
      let subtype = acct.subtype ?? null;
      if (!subtype) {
        let parentAcct = flatAccounts.find((a) => a.id === acct.parentId);
        while (parentAcct && !subtype) {
          subtype = parentAcct.subtype ?? null;
          parentAcct = flatAccounts.find((a) => a.id === parentAcct!.parentId);
        }
      }
      const accountReadTypes = acct.readPartyTypes ?? null;
      const preferred = getReadPartyTypes(subtype, activeType, typedOverrides, accountReadTypes);
      for (const t of preferred) allTypes.add(t);
    }

    if (allTypes.size === 0) return "all" as const;
    return toPartyApiFilter(Array.from(allTypes));
  }, [currentLines, currentPayLines, activeType, flatAccounts, typedOverrides]);

  // Aggregated MUTATE party types — determines create label + party type for inline creation
  const aggregatedMutateTypes = useMemo((): PartyType[] | null => {
    if (activeType !== "pay_in" && activeType !== "pay_out") return null;
    const linesWithCategory = currentPayLines.filter((line) => line.categoryId);
    if (linesWithCategory.length === 0) return null;
    const allTypes = new Set<PartyType>();
    for (const line of linesWithCategory) {
      const acct = flatAccounts.find((a) => a.id === line.categoryId);
      if (!acct) continue;
      let subtype = acct.subtype ?? null;
      if (!subtype) {
        let parentAcct = flatAccounts.find((a) => a.id === acct.parentId);
        while (parentAcct && !subtype) {
          subtype = parentAcct.subtype ?? null;
          parentAcct = flatAccounts.find((a) => a.id === parentAcct!.parentId);
        }
      }
      const accountMutateTypes = acct.mutatePartyTypes ?? null;
      const preferred = getMutatePartyTypes(
        subtype,
        activeType,
        typedOverrides,
        accountMutateTypes,
      );
      for (const t of preferred) allTypes.add(t);
    }
    return allTypes.size > 0 ? Array.from(allTypes) : null;
  }, [currentPayLines, activeType, flatAccounts, typedOverrides]);

  // ── Party query for combobox ──
  const { data: partiesRaw = [] } = useQuery({
    queryKey: ["parties", partyQuery, partyTypeFilter],
    queryFn: () =>
      callServerFn(listParties, {
        data: { search: partyQuery, type: partyTypeFilter, limit: 30 },
      }),
    structuralSharing: false,
  });

  const partyOptions: ComboboxOption[] = useMemo(() => {
    const opts = partiesRaw.map((p: PartyRecord) => ({ value: p.id, label: p.name }));

    // Ensure the transaction's existing primary party is always available
    if (transaction?.partyId && transaction?.partyName) {
      if (!opts.some((o) => o.value === transaction.partyId)) {
        opts.unshift({ value: transaction.partyId, label: transaction.partyName });
      }
    }

    return opts;
  }, [partiesRaw, transaction]);

  // ── Initialize edit state from transaction data ──
  const initEditState = useCallback(() => {
    if (!transaction) return;
    const t = transaction;
    setEditType(t.transactionType as TabType);
    setEditMemo(t.memo || "");
    setEditDate(t.transactionDate || "");
    setEditAmount(t.totalAmount ? String(t.totalAmount) : "0");
    setEditPartyId(t.partyId || "");
    setEditRefNumber(t.referenceNumber || "");
    setEditJournalLines(journalLines);
    setEditPayCategoryId(payCategoryId);
    setEditPayLines(payForLines);
    setEditTransferFrom(transferData.fromCategory);
    setEditTransferTo(transferData.toCategory);
    setEditTransferAmount(transferData.amount);
    setEditTransferFromParty("");
    setEditTransferToParty("");
  }, [transaction, journalLines, payCategoryId, payForLines, transferData]);

  useEffect(() => {
    if (mode === "edit") initEditState();
  }, [mode, initEditState]);

  // Sync header editAmount → single pay-for line amount
  // When user edits the big amount in the header and there's one pay line,
  // propagate the value so buildLinesForSave sends the correct amount.
  useEffect(() => {
    if (
      mode !== "edit" ||
      !editType ||
      (editType !== "pay_in" && editType !== "pay_out") ||
      editPayLines.length !== 1
    )
      return;
    const current = editPayLines[0].amount;
    if (editAmount && editAmount !== current) {
      setEditPayLines((prev) => [{ ...prev[0], amount: editAmount }, ...prev.slice(1)]);
    }
  }, [editAmount, mode, editType]);

  // Derive reactive header amount from line data
  const editHeaderAmount = useMemo(() => {
    if (mode !== "edit" || !editType) return "";
    if (editType === "transfer") return editAmount;
    if (editType === "journal") {
      const totalDebit = editJournalLines.reduce(
        (s, l) => s + (Number.parseFloat(l.debit) || 0),
        0,
      );
      const totalCredit = editJournalLines.reduce(
        (s, l) => s + (Number.parseFloat(l.credit) || 0),
        0,
      );
      // Balanced total = the paired portion
      return Math.min(totalDebit, totalCredit).toString();
    }
    // pay_in → credit total, pay_out → debit total
    // In the unified model, pay lines store a single "amount" which maps to
    // credit (pay_in) or debit (pay_out) depending on type.
    const total = editPayLines.reduce((s, l) => s + (Number.parseFloat(l.amount) || 0), 0);
    return total.toString();
  }, [mode, editType, editAmount, editJournalLines, editPayLines]);

  // ── Save mutation ──
  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!transaction || !editType) return;
      const lines = buildLinesForSave(editType);
      return (updateTransaction as (opts: { data: unknown }) => Promise<any>)({
        data: {
          id: transaction.id,
          transactionType: editType,
          transactionDate: editDate,
          memo: editMemo,
          partyId: editPartyId || null,
          referenceNumber: editRefNumber || null,
          lines,
        },
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["transaction", transactionId] });
      queryClient.invalidateQueries({ queryKey: ["transactions"] });
      queryClient.invalidateQueries({ queryKey: ["activity-logs", "transaction", transactionId] });
      setMode("view");
      showToast?.("Transaction saved successfully.", { icon: "success" });
    },
    onError: (err: any) => {
      showToast?.(err.message || "Failed to save transaction", { icon: "error" });
    },
  });

  // ── Unmatch mutation ──
  const unmatchMutation = useMutation({
    mutationFn: (data: UnmatchRequest) =>
      callServerFn(unmatchTransaction as unknown as UnmatchServerFn, { data }),
    onSuccess: (result) => {
      const affectedTransactionIds = new Set([
        transactionId,
        result.canonicalTransactionId,
        result.restoredTransactionId,
      ]);
      for (const affectedTransactionId of affectedTransactionIds) {
        queryClient.invalidateQueries({ queryKey: ["transaction", affectedTransactionId] });
        queryClient.invalidateQueries({
          queryKey: ["activity-logs", "transaction", affectedTransactionId],
        });
        queryClient.invalidateQueries({
          queryKey: ["transaction-attachments", affectedTransactionId],
        });
      }
      queryClient.invalidateQueries({ queryKey: ["transactions"] });
      queryClient.invalidateQueries({ queryKey: ["accountBalances"] });
      setUnmatchMergeId(null);
      setUnmatchReason("");
      unmatchIdempotencyKeyRef.current = null;
      showToast?.("Transactions separated without deleting either journal.", {
        icon: "success",
      });
    },
    onError: (err: any) => {
      showToast?.(err.message || "Unmatch failed", { icon: "error" });
    },
  });

  const openUnmatchDialog = () => {
    if (!canUnmatch || !transaction?.duplicateMerge) return;
    setUnmatchMergeId(transaction.duplicateMerge.id);
    setUnmatchReason("");
    unmatchIdempotencyKeyRef.current = crypto.randomUUID();
  };

  const closeUnmatchDialog = () => {
    if (unmatchMutation.isPending) return;
    setUnmatchMergeId(null);
    setUnmatchReason("");
    unmatchIdempotencyKeyRef.current = null;
  };

  const confirmUnmatch = () => {
    const reason = unmatchReason.trim();
    if (!unmatchMergeId || reason.length < 3) return;

    const idempotencyKey =
      unmatchIdempotencyKeyRef.current ?? (unmatchIdempotencyKeyRef.current = crypto.randomUUID());
    unmatchMutation.mutate({
      mergeId: unmatchMergeId,
      reason,
      idempotencyKey,
    });
  };

  // ── Delete mutation ──
  const deleteMutation = useMutation({
    mutationFn: async () =>
      (deleteTransactionsBatch as (opts: { data: unknown }) => Promise<any>)({
        data: { ids: [transactionId] },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["transactions"] });
      showToast?.("Transaction deleted", { icon: "success" });
      navigate({ to: "/transactions" as string & {} });
    },
    onError: (err: any) => {
      showToast?.(err.message || "Failed to delete transaction", { icon: "error" });
    },
  });

  // ── Build lines for save based on current edit type ──
  function buildLinesForSave(type: TabType) {
    if (type === "journal") {
      return editJournalLines
        .filter((l) => l.categoryId)
        .map((l, i) => ({
          accountId: l.categoryId,
          debit: l.debit || undefined,
          credit: l.credit || undefined,
          lineDescription: l.description || undefined,
          partyId: l.partyId || undefined,
          departmentId: l.departmentId || undefined,
          locationId: l.locationId || undefined,
          sortOrder: i,
        }));
    }
    if (type === "pay_in" || type === "pay_out") {
      const isPayIn = type === "pay_in";
      // Use editAmount (header value the user actually typed) for the category line,
      // fall back to sum of pay lines if editAmount isn't set.
      const lineTotal = editPayLines.reduce((s, l) => s + (Number.parseFloat(l.amount) || 0), 0);
      const total = editAmount ? Number.parseFloat(editAmount) || lineTotal : lineTotal;
      const categoryLine = {
        accountId: editPayCategoryId,
        debit: isPayIn ? String(total) : undefined,
        credit: isPayIn ? undefined : String(total),
        sortOrder: 0,
      };
      const payLines = editPayLines
        .filter((l) => l.categoryId && Number.parseFloat(l.amount) > 0)
        .map((l, i) => ({
          accountId: l.categoryId,
          debit: isPayIn ? undefined : l.amount,
          credit: isPayIn ? l.amount : undefined,
          lineDescription: l.description || undefined,
          departmentId: l.departmentId || undefined,
          locationId: l.locationId || undefined,
          sortOrder: i + 1,
        }));
      return [categoryLine, ...payLines];
    }
    // transfer
    return [
      { accountId: editTransferTo, debit: editTransferAmount, sortOrder: 0 },
      { accountId: editTransferFrom, credit: editTransferAmount, sortOrder: 1 },
    ];
  }

  // ── Type conversion logic ──
  // Uses a two-step canonical approach:
  //   Step 1: Convert current edit state → canonical journal lines
  //   Step 2: Derive target type state from canonical lines using debit/credit
  //
  // Accounting conventions:
  //   Pay Out  → Category = CREDIT line (source bank), Pay For = DEBIT lines (expenses)
  //   Pay In   → Category = DEBIT line (destination),  Pay For = CREDIT lines (revenue)
  //   Transfer → From = CREDIT line (source),          To = DEBIT line (destination)
  //   Journal  → All lines shown as-is
  function handleTypeChange(newType: TabType) {
    if (newType === editType) {
      setShowTypeDropdown(false);
      return;
    }
    const oldType = editType;
    setEditType(newType);
    setShowTypeDropdown(false);

    const memo = editMemo || "";

    // ── Step 1: Reconstruct canonical journal lines from current edit state ──
    let canonical: JournalLine[];

    if (oldType === "journal") {
      canonical = editJournalLines;
    } else if (oldType === "pay_in" || oldType === "pay_out") {
      const isPayIn = oldType === "pay_in";
      const total = editPayLines.reduce((s, l) => s + (Number.parseFloat(l.amount) || 0), 0);
      canonical = [
        {
          key: createKey(),
          description: memo,
          categoryId: editPayCategoryId,
          partyId: editPartyId,
          departmentId: "",
          locationId: "",
          debit: isPayIn ? String(total) : "",
          credit: isPayIn ? "" : String(total),
        },
        ...editPayLines.map((l) => ({
          key: createKey(),
          description: l.description || memo,
          categoryId: l.categoryId,
          partyId: editPartyId,
          departmentId: l.departmentId || "",
          locationId: l.locationId || "",
          debit: isPayIn ? "" : l.amount,
          credit: isPayIn ? l.amount : "",
        })),
      ];
    } else {
      // transfer → canonical
      canonical = [
        {
          key: createKey(),
          description: memo,
          categoryId: editTransferTo,
          partyId: editTransferToParty || editPartyId,
          departmentId: "",
          locationId: "",
          debit: editTransferAmount,
          credit: "",
        },
        {
          key: createKey(),
          description: memo,
          categoryId: editTransferFrom,
          partyId: editTransferFromParty || editPartyId,
          departmentId: "",
          locationId: "",
          debit: "",
          credit: editTransferAmount,
        },
      ];
    }

    // Sort canonical so debit lines come before credit lines (standard convention)
    canonical.sort((a, b) => {
      const aDebit = Number.parseFloat(a.debit) || 0;
      const bDebit = Number.parseFloat(b.debit) || 0;
      return bDebit - aDebit; // Larger debit first
    });

    // Always keep editJournalLines in sync as the canonical form
    setEditJournalLines(canonical);

    // ── Step 2: Derive target type state from canonical lines ──

    if (newType === "journal") {
      // Journal — canonical lines are already set above, nothing more to do
    } else if (newType === "pay_in" || newType === "pay_out") {
      // Pay In:  category = DEBIT line (bank receives money), pay for = CREDIT lines
      // Pay Out: category = CREDIT line (bank sends money),   pay for = DEBIT lines
      const isPayIn = newType === "pay_in";

      const categoryLine = canonical.find((l) =>
        isPayIn
          ? l.debit && Number.parseFloat(l.debit) > 0
          : l.credit && Number.parseFloat(l.credit) > 0,
      );
      const payLines = canonical.filter((l) => l !== categoryLine);

      setEditPayCategoryId(categoryLine?.categoryId || "");

      // Carry party from category line if editPartyId is empty
      if (!editPartyId && categoryLine?.partyId) {
        setEditPartyId(categoryLine.partyId);
      }

      setEditPayLines(
        payLines.length > 0
          ? payLines.map((l) => ({
              key: createKey(),
              description: l.description || memo,
              categoryId: l.categoryId,
              departmentId: l.departmentId || "",
              locationId: l.locationId || "",
              amount: isPayIn ? l.credit || l.debit : l.debit || l.credit,
            }))
          : [
              {
                key: createKey(),
                description: memo,
                categoryId: "",
                departmentId: "",
                locationId: "",
                amount: "",
              },
            ],
      );
    } else if (newType === "transfer") {
      // Transfer From = CREDIT line (source), Transfer To = DEBIT line (destination)
      const debitLine = canonical.find((l) => l.debit && Number.parseFloat(l.debit) > 0);
      const creditLine = canonical.find((l) => l.credit && Number.parseFloat(l.credit) > 0);

      setEditTransferFrom(creditLine?.categoryId || "");
      setEditTransferTo(debitLine?.categoryId || "");
      setEditTransferAmount(debitLine?.debit || creditLine?.credit || "");

      const fromParty = editPartyId || creditLine?.partyId || debitLine?.partyId || "";
      const toParty = editPartyId || debitLine?.partyId || creditLine?.partyId || "";
      setEditTransferFromParty(fromParty);
      setEditTransferToParty(toParty);

      if (!editPartyId && (debitLine?.partyId || creditLine?.partyId)) {
        setEditPartyId(debitLine?.partyId || creditLine?.partyId || "");
      }
    }
  }

  // ── Journal line management ──
  const handleUpdateJournalLine = useCallback(
    (key: string, field: keyof JournalLine, value: string) => {
      setEditJournalLines((prev) =>
        prev.map((l) => (l.key === key ? { ...l, [field]: value } : l)),
      );
    },
    [],
  );
  const handleAddJournalLine = useCallback(() => {
    setEditJournalLines((prev) => [...prev, emptyJournalLine()]);
  }, []);
  const handleRemoveJournalLine = useCallback((key: string) => {
    setEditJournalLines((prev) => prev.filter((l) => l.key !== key));
  }, []);
  const handleCopyJournalLine = useCallback((key: string) => {
    setEditJournalLines((prev) => {
      const idx = prev.findIndex((l) => l.key === key);
      if (idx === -1) return prev;
      const copy = { ...prev[idx], key: createKey() };
      const next = [...prev];
      next.splice(idx + 1, 0, copy);
      return next;
    });
  }, []);
  const handleAddJournalLineAfter = useCallback((afterKey: string) => {
    setEditJournalLines((prev) => {
      const idx = prev.findIndex((l) => l.key === afterKey);
      const next = [...prev];
      next.splice(idx + 1, 0, emptyJournalLine());
      return next;
    });
  }, []);

  // ── Pay line management ──
  const handleUpdatePayLine = useCallback((key: string, field: keyof PayForLine, value: string) => {
    setEditPayLines((prev) => prev.map((l) => (l.key === key ? { ...l, [field]: value } : l)));
  }, []);
  const handleAddPayLine = useCallback(() => {
    setEditPayLines((prev) => [...prev, emptyPayForLine()]);
  }, []);
  const handleRemovePayLine = useCallback((key: string) => {
    setEditPayLines((prev) => prev.filter((l) => l.key !== key));
  }, []);
  const handleCopyPayLine = useCallback((key: string) => {
    setEditPayLines((prev) => {
      const idx = prev.findIndex((l) => l.key === key);
      if (idx === -1) return prev;
      const copy = { ...prev[idx], key: createKey() };
      const next = [...prev];
      next.splice(idx + 1, 0, copy);
      return next;
    });
  }, []);
  const handleAddPayLineAfter = useCallback((afterKey: string) => {
    setEditPayLines((prev) => {
      const idx = prev.findIndex((l) => l.key === afterKey);
      const next = [...prev];
      next.splice(idx + 1, 0, emptyPayForLine());
      return next;
    });
  }, []);

  // Multi-avatar items — reactive for all transaction types
  const getInitials = (name: string): string | null => {
    const words = name.trim().split(/\s+/);
    if (words.length === 0) return null;
    if (words.length === 1) return words[0].charAt(0).toUpperCase();
    return (words[0].charAt(0) + words[words.length - 1].charAt(0)).toUpperCase();
  };

  const avatarItems: AvatarItem[] = useMemo(() => {
    // Pay In / Pay Out → single party
    if (activeType === "pay_in" || activeType === "pay_out") {
      const name =
        mode === "edit" && editPartyId
          ? partyOptions.find((p) => p.value === editPartyId)?.label
          : transaction?.partyName;
      if (name) return [{ initials: getInitials(name) }];
      return [];
    }
    // Transfer → up to 2 parties (from, to)
    if (activeType === "transfer") {
      const items: AvatarItem[] = [];
      if (mode === "edit") {
        if (editTransferFromParty) {
          const fromName = partyOptions.find((p) => p.value === editTransferFromParty)?.label;
          if (fromName) items.push({ initials: getInitials(fromName) });
        }
        if (editTransferToParty) {
          const toName = partyOptions.find((p) => p.value === editTransferToParty)?.label;
          if (toName) items.push({ initials: getInitials(toName) });
        }
      } else if (transaction?.partyName) {
        items.push({ initials: getInitials(transaction.partyName) });
      }
      return items;
    }
    // Journal → unique parties from per-line data
    if (activeType === "journal") {
      const lines = mode === "edit" ? editJournalLines : journalLines;
      const rawLines = transaction?.lines;
      const seen = new Set<string>();
      const items: AvatarItem[] = [];
      for (const line of lines) {
        // In view mode, partyId comes from raw server data
        const pid =
          mode === "edit"
            ? line.partyId
            : rawLines?.find((serverLine) => `existing-${serverLine.id}` === line.key)?.partyId;
        if (!pid || seen.has(pid)) continue;
        seen.add(pid);
        const name =
          mode === "edit"
            ? journalPartyNames[line.key] || partyOptions.find((p) => p.value === pid)?.label
            : partyOptions.find((p) => p.value === pid)?.label;
        items.push({ initials: name ? getInitials(name) : null });
      }
      // Fallback: use header party if no per-line parties
      if (items.length === 0 && transaction?.partyName) {
        items.push({ initials: getInitials(transaction.partyName) });
      }
      return items;
    }
    return [];
  }, [
    activeType,
    mode,
    editPartyId,
    editTransferFromParty,
    editTransferToParty,
    partyOptions,
    transaction,
    editJournalLines,
    journalLines,
    journalPartyNames,
  ]);

  // Collect full party names for header display (same sources as avatarItems)
  const partyDisplayName = useMemo(() => {
    const names: string[] = [];
    if (activeType === "pay_in" || activeType === "pay_out") {
      const name =
        mode === "edit" && editPartyId
          ? partyOptions.find((p) => p.value === editPartyId)?.label
          : transaction?.partyName;
      if (name) names.push(name);
    } else if (activeType === "transfer") {
      if (mode === "edit") {
        if (editTransferFromParty) {
          const n = partyOptions.find((p) => p.value === editTransferFromParty)?.label;
          if (n) names.push(n);
        }
        if (editTransferToParty) {
          const n = partyOptions.find((p) => p.value === editTransferToParty)?.label;
          if (n) names.push(n);
        }
      } else if (transaction?.partyName) {
        names.push(transaction.partyName);
      }
    } else if (activeType === "journal") {
      const lines = mode === "edit" ? editJournalLines : journalLines;
      const rawLines = transaction?.lines;
      const seen = new Set<string>();
      for (const line of lines) {
        const pid =
          mode === "edit"
            ? line.partyId
            : rawLines?.find((serverLine) => `existing-${serverLine.id}` === line.key)?.partyId;
        if (!pid || seen.has(pid)) continue;
        seen.add(pid);
        const name =
          mode === "edit"
            ? journalPartyNames[line.key] || partyOptions.find((p) => p.value === pid)?.label
            : partyOptions.find((p) => p.value === pid)?.label;
        if (name) names.push(name);
      }
      if (names.length === 0 && transaction?.partyName) {
        names.push(transaction.partyName);
      }
    }
    return formatPartyNames(names);
  }, [
    activeType,
    mode,
    editPartyId,
    editTransferFromParty,
    editTransferToParty,
    partyOptions,
    transaction,
    editJournalLines,
    journalLines,
    journalPartyNames,
  ]);

  // ── Loading state ──
  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center bg-[#f0f2f5] dark:bg-slate-950">
        <div className="flex flex-col items-center gap-3 animate-pulse">
          <div className="w-14 h-14 rounded-xl bg-[#e2e8f0] dark:bg-slate-800" />
          <div className="w-40 h-4 rounded bg-[#e2e8f0] dark:bg-slate-800" />
          <div className="w-24 h-3 rounded bg-[#e2e8f0] dark:bg-slate-800" />
        </div>
      </div>
    );
  }

  if (!transaction) {
    return (
      <div className="flex h-full items-center justify-center bg-[#f0f2f5] dark:bg-slate-950">
        <div className="text-center">
          <h2 className="text-xl font-semibold text-[#1e293b] dark:text-white mb-2">
            Transaction Not Found
          </h2>
          <p className="text-sm text-[#64748b] dark:text-slate-400 mb-4">
            The transaction you're looking for doesn't exist.
          </p>
          <button
            type="button"
            onClick={() => window.history.back()}
            className="px-4 py-2 rounded-lg bg-[var(--color-app-header-teal)] text-white text-sm font-medium hover:bg-[#248f82] transition-colors"
          >
            Go Back
          </button>
        </div>
      </div>
    );
  }

  const typeLabel = TYPE_LABELS[activeType] || activeType;

  const getTypeIcon = (t: TabType) =>
    t === "transfer"
      ? ICON_PATHS.ArrowSwitch
      : t === "pay_in"
        ? ICON_PATHS.CoinsHand
        : t === "pay_out"
          ? ICON_PATHS.CoinsHand02
          : ICON_PATHS.Journal;

  const typeIcon = getTypeIcon(activeType);

  const totalAmount = transaction.totalAmount
    ? formatCurrency(transaction.totalAmount)
    : formatCurrency(
        transaction.lines?.reduce(
          (sum: number, l: any) => sum + (Number.parseFloat(l.debit) || 0),
          0,
        ) || 0,
      );

  return (
    <div className="flex h-full bg-[#f0f2f5] dark:bg-slate-950">
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Top bar */}
        <div className="bg-white dark:bg-slate-900 border-b border-[#e2e8f0] dark:border-slate-700">
          <div className="flex items-center gap-3 px-6 py-3 max-w-[1400px] mx-auto">
            <button
              type="button"
              onClick={() => window.history.back()}
              className="w-12 h-12 rounded-lg flex items-center justify-center text-[#64748b] dark:text-slate-400 hover:bg-[#f1f5f9] dark:hover:bg-slate-800 hover:text-[var(--color-app-header-teal)] transition-colors shrink-0"
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
                <polyline points="15 18 9 12 15 6" />
              </svg>
            </button>

            {/* Center: View / Edit toggle or Locked indicator */}
            <div className="flex-1 flex justify-center">
              {!isVoided &&
                (isLocked ? (
                  <div className="relative group">
                    <div className="flex items-center gap-1.5 bg-slate-100 dark:bg-slate-800 text-slate-400 dark:text-slate-500 rounded-lg px-3.5 py-1.5 text-xs font-medium cursor-default select-none">
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        viewBox="0 0 16 16"
                        fill="currentColor"
                        className="w-4 h-4"
                      >
                        <path
                          fillRule="evenodd"
                          d="M8 1a3.5 3.5 0 0 0-3.5 3.5V7H3a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V8a1 1 0 0 0-1-1h-1.5V4.5A3.5 3.5 0 0 0 8 1Zm2 6V4.5a2 2 0 1 0-4 0V7h4Z"
                          clipRule="evenodd"
                        />
                      </svg>
                      Locked
                    </div>
                    {/* Tooltip */}
                    <div className="absolute top-full left-1/2 -translate-x-1/2 mt-2 px-3 py-1.5 bg-slate-800 dark:bg-slate-700 text-white text-[11px] rounded-md whitespace-nowrap opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-150 pointer-events-none z-50 shadow-lg">
                      Period locked through {closedThrough}. Open from Ledger page to edit.
                      <div className="absolute bottom-full left-1/2 -translate-x-1/2 border-4 border-transparent border-b-slate-800 dark:border-b-slate-700" />
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center bg-[#f1f5f9] dark:bg-slate-800 rounded-lg p-0.5">
                    <button
                      type="button"
                      onClick={() => setMode("view")}
                      className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
                        mode === "view"
                          ? "bg-white dark:bg-slate-700 text-[#1e293b] dark:text-white shadow-sm"
                          : "text-[#64748b] dark:text-slate-400 hover:text-[#1e293b] dark:hover:text-slate-200"
                      }`}
                    >
                      View
                    </button>
                    <button
                      type="button"
                      onClick={() => setMode("edit")}
                      className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
                        mode === "edit"
                          ? "bg-white dark:bg-slate-700 text-[#1e293b] dark:text-white shadow-sm"
                          : "text-[#64748b] dark:text-slate-400 hover:text-[#1e293b] dark:hover:text-slate-200"
                      }`}
                    >
                      Edit
                    </button>
                  </div>
                ))}
            </div>

            {/* Right: sidebar toggle + actions */}
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                className="lg:hidden w-9 h-9 touch-target rounded-lg flex items-center justify-center text-[#64748b] dark:text-slate-400 hover:bg-[#f1f5f9] dark:hover:bg-slate-800 transition-colors"
                onClick={() => setShowSidebar((v) => !v)}
                title={showSidebar ? "Close sidebar" : "Open sidebar"}
              >
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                >
                  <rect x="3" y="3" width="18" height="18" rx="2" />
                  <path d="M15 3v18" />
                </svg>
              </button>

              {mode === "edit" ? (
                <>
                  <button
                    type="button"
                    onClick={() => setMode("view")}
                    className="px-4 py-1.5 text-xs font-medium text-[#64748b] dark:text-slate-400 hover:text-[#1e293b] dark:hover:text-white bg-[#f1f5f9] dark:bg-slate-800 hover:bg-[#e2e8f0] dark:hover:bg-slate-700 rounded-lg transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => saveMutation.mutate()}
                    disabled={saveMutation.isPending}
                    className="px-4 py-1.5 text-xs font-medium text-white bg-[var(--color-app-header-teal)] hover:bg-[#248f82] rounded-lg transition-colors disabled:opacity-50"
                  >
                    {saveMutation.isPending ? "Saving..." : "Save"}
                  </button>
                </>
              ) : canDelete && !isVoided && !isLocked ? (
                <button
                  type="button"
                  onClick={() => setShowDeleteConfirm(true)}
                  className="px-4 py-1.5 text-xs font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 border border-red-200 dark:border-red-800/50 rounded-lg transition-colors"
                >
                  Delete
                </button>
              ) : null}
            </div>
          </div>
        </div>

        {/* Scrollable form area */}
        <div className="flex-1 p-6 pb-0 overflow-hidden">
          <div className="flex gap-6 h-[calc(100vh-5rem-50px)] max-w-[1400px] mx-auto">
            {/* Main card */}
            <div className="flex-1 min-w-0 bg-[#f8f9fb] dark:bg-slate-900 rounded-xl border border-[#e2e8f0] dark:border-slate-700 shadow-sm flex flex-col overflow-hidden border-t-0">
              {/* Card header */}
              <div className="relative px-6 pt-6 pb-12 flex flex-wrap items-start gap-5 transition-colors duration-300 bg-gradient-to-r from-[#1a6b3c] to-[#27ae60] dark:from-[#145a30] dark:to-[#1e8c4c] text-white">
                {/* Solid Header Content */}
                {/* Left Column: Avatar + Party/Ref */}
                <div className="flex items-center gap-5 flex-1 min-w-[280px]">
                  {/* Circle avatar — dynamic multi-avatar */}
                  <MultiAvatar items={avatarItems} fallbackIcon={typeIcon} />

                  <div className="flex flex-col gap-1 min-w-0">
                    {/* Party Name Selector/Display */}
                    <div className="relative">
                      {mode === "edit" && (activeType === "pay_in" || activeType === "pay_out") ? (
                        <Combobox
                          value={editPartyId}
                          onChange={setEditPartyId}
                          options={partyOptions}
                          placeholder="Select Party"
                          onSearch={setPartyQuery}
                          searchPlaceholder="Search parties..."
                          className="[&>button]:bg-black/20 [&>button]:border-transparent [&>button]:text-white [&>button]:text-xs [&>button]:font-medium [&>button]:hover:bg-black/30 [&>button]:py-0 [&>button]:px-2 [&>button]:rounded-md [&>button]:h-[36px] [&>button]:min-h-0 w-[200px]"
                          onCreate={
                            aggregatedMutateTypes
                              ? async (name: string) => {
                                  const partyType = aggregatedMutateTypes[0];
                                  if (!partyType) return;
                                  const newParty = await callServerFn(createParty, {
                                    data: { name, partyType },
                                  });
                                  if (newParty?.id) {
                                    setEditPartyId(newParty.id);
                                    setPartyQuery("");
                                  }
                                }
                              : undefined
                          }
                          createLabel={
                            aggregatedMutateTypes ? aggregatedMutateTypes.join(" or ") : undefined
                          }
                        />
                      ) : (
                        <h1
                          className="text-2xl font-bold text-white"
                          title={partyDisplayName.full || undefined}
                        >
                          {partyDisplayName.display || transaction.partyName || "—"}
                        </h1>
                      )}
                    </div>

                    {/* Reference Number */}
                    {mode === "edit" ? (
                      <div className="flex items-center gap-2">
                        <input
                          type="text"
                          value={editRefNumber}
                          onChange={(e) => setEditRefNumber(e.target.value)}
                          placeholder="Reference Number"
                          className="text-base sm:text-xs min-h-11 lg:min-h-0 px-2 rounded-md transition-colors focus:outline-none bg-black/20 text-white placeholder-white/50 focus:bg-black/30"
                          style={{ width: "200px", height: "36px" }}
                        />
                      </div>
                    ) : transaction.referenceNumber ? (
                      <span className="text-sm text-white/70">{transaction.referenceNumber}</span>
                    ) : null}
                  </div>
                </div>

                {/* Right Column: Amount + Date + Pill */}
                <div className="text-right flex flex-col items-end gap-1 ml-auto">
                  {/* Amount */}
                  {mode === "edit" && activeType === "transfer" ? (
                    <input
                      type="text"
                      value={editAmount}
                      onChange={(e) => {
                        const v = e.target.value.replace(/[^0-9.]/g, "");
                        setEditAmount(v);
                      }}
                      className="text-3xl font-bold tabular-nums text-right bg-black/20 rounded-md px-3 py-1 focus:outline-none focus:bg-black/30 transition-colors text-white placeholder-white/50"
                      style={{
                        minWidth: "150px",
                        width: `${Math.max(6, editAmount.length + 1)}ch`,
                      }}
                    />
                  ) : (
                    <p className="text-2xl font-bold tabular-nums text-white">
                      {mode === "edit"
                        ? editHeaderAmount && Number.parseFloat(editHeaderAmount)
                          ? formatCurrency(Number.parseFloat(editHeaderAmount))
                          : "$0.00"
                        : totalAmount}
                    </p>
                  )}

                  {/* Date */}
                  <div className="flex items-center gap-2 justify-end mt-1">
                    {mode === "edit" ? (
                      <DayPicker value={editDate} onChange={setEditDate} variant="header" />
                    ) : (
                      <p className="text-sm font-medium text-white/90">
                        {formatDate(transaction.transactionDate)}
                      </p>
                    )}
                  </div>

                  {/* Type Pill - Replaces DRAFT/Posted status in view mode */}
                  <div className="mt-4">
                    {mode === "edit" ? (
                      <div className="relative" ref={typeDropdownRef}>
                        <button
                          type="button"
                          onClick={() => setShowTypeDropdown(!showTypeDropdown)}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors bg-black/20 text-white hover:bg-black/30 backdrop-blur-md"
                        >
                          <svg
                            width="14"
                            height="14"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            dangerouslySetInnerHTML={{ __html: typeIcon }}
                          />
                          {typeLabel}
                          <svg
                            width="12"
                            height="12"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            className={`transition-transform duration-200 ${showTypeDropdown ? "rotate-180" : ""}`}
                          >
                            <polyline points="6 9 12 15 18 9" />
                          </svg>
                        </button>

                        {/* Dropdown Menu */}
                        {showTypeDropdown && (
                          <div className="absolute right-0 top-full mt-1 w-40 bg-white dark:bg-slate-800 rounded-lg shadow-lg border border-slate-100 dark:border-slate-700 py-1 z-50 animate-in fade-in zoom-in-95 duration-100">
                            {TABS.map((tab) => (
                              <button
                                key={tab.id}
                                onClick={() => handleTypeChange(tab.id)}
                                className={`w-full text-left px-3 py-2 text-sm hover:bg-slate-50 dark:hover:bg-slate-700 flex items-center gap-2 ${
                                  activeType === tab.id
                                    ? "text-[var(--color-app-header-teal)] font-medium bg-teal-50 dark:bg-teal-900/10"
                                    : "text-slate-600 dark:text-slate-300"
                                }`}
                              >
                                <span className="w-4 h-4 text-current [&>svg]:w-full [&>svg]:h-full">
                                  {tab.icon}
                                </span>
                                {tab.label}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-semibold shadow-sm bg-black/20 text-white backdrop-blur-md">
                        <svg
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          dangerouslySetInnerHTML={{ __html: typeIcon }}
                        />
                        {typeLabel}
                      </div>
                    )}
                  </div>

                  {/* Lossless duplicate-merge badge */}
                  {transaction.duplicateMerge &&
                    mode === "view" &&
                    (canUnmatch ? (
                      <button
                        type="button"
                        onClick={openUnmatchDialog}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500/25 px-3 py-1.5 text-xs font-semibold text-amber-100 backdrop-blur-md transition-colors hover:bg-amber-500/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-200"
                        title={`Separate this ${transaction.duplicateMerge.role} transaction from its duplicate`}
                        aria-label={`Merged ${transaction.duplicateMerge.role} transaction. Separate merged transactions`}
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
                          aria-hidden="true"
                        >
                          <path d="m2 14.5 9.642 4.821c.131.066.197.098.266.111q.091.018.184 0c.069-.013.135-.045.266-.11L22 14.5m-20-5 9.642-4.821c.131-.066.197-.099.266-.111a.5.5 0 0 1 .184 0c.069.012.135.045.266.11L22 9.5l-9.642 4.821c-.131.066-.197.098-.266.111a.5.5 0 0 1-.184 0c-.069-.013-.135-.045-.266-.11z" />
                        </svg>
                        Merged
                      </button>
                    ) : (
                      <span
                        className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500/25 px-3 py-1.5 text-xs font-semibold text-amber-100 backdrop-blur-md"
                        title={`This is the ${transaction.duplicateMerge.role} transaction in a duplicate merge`}
                        aria-label={`Merged ${transaction.duplicateMerge.role} transaction`}
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
                          aria-hidden="true"
                        >
                          <path d="m2 14.5 9.642 4.821c.131.066.197.098.266.111q.091.018.184 0c.069-.013.135-.045.266-.11L22 14.5m-20-5 9.642-4.821c.131-.066.197-.099.266-.111a.5.5 0 0 1 .184 0c.069.012.135.045.266.11L22 9.5l-9.642 4.821c-.131.066-.197.098-.266.111a.5.5 0 0 1-.184 0c-.069-.013-.135-.045-.266-.11z" />
                        </svg>
                        Merged
                      </span>
                    ))}
                </div>
              </div>

              {/* Memo */}
              <div className="px-6 relative z-10 -mt-12">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-[#475569] text-white mb-2 pl-1">
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
                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                  </svg>
                  Memo
                </div>
                {/* Memo Overlap Card */}
                <div className="bg-white dark:bg-slate-800 rounded-xl shadow-sm border border-[#e2e8f0] dark:border-slate-700 p-4 min-h-16 ">
                  {mode === "edit" ? (
                    <textarea
                      value={editMemo}
                      onChange={(e) => setEditMemo(e.target.value)}
                      onInput={(e) => {
                        const el = e.currentTarget;
                        el.style.height = "auto";
                        el.style.height = `${Math.min(el.scrollHeight, 96)}px`;
                      }}
                      placeholder="Add a memo..."
                      rows={1}
                      className="w-full text-base sm:text-sm text-[#1e293b] dark:text-slate-200 placeholder-[#cbd5e1] dark:placeholder-slate-500 focus:outline-none focus:border-b focus:border-[var(--color-app-header-teal)] pb-1 resize-none overflow-y-auto bg-transparent"
                      style={{ maxHeight: 96 }}
                    />
                  ) : (
                    <p className="text-sm font-medium text-[#1e293b] dark:text-slate-200">
                      {transaction.memo || "—"}
                    </p>
                  )}
                </div>
              </div>

              {/* Type-specific content */}
              <div className="px-6 py-4 pb-12 flex-1 overflow-y-auto bg-[#f8f9fb] dark:bg-slate-950/40">
                {activeType === "journal" && (
                  <JournalForm
                    lines={mode === "edit" ? editJournalLines : journalLines}
                    accounts={flatAccounts}
                    onUpdateLine={handleUpdateJournalLine}
                    onAddLine={handleAddJournalLine}
                    onAddLineAfter={handleAddJournalLineAfter}
                    onCopyLine={handleCopyJournalLine}
                    onRemoveLine={handleRemoveJournalLine}
                    totals={{
                      debit: (mode === "edit" ? editJournalLines : journalLines).reduce(
                        (s, l) => s + (Number.parseFloat(l.debit) || 0),
                        0,
                      ),
                      credit: (mode === "edit" ? editJournalLines : journalLines).reduce(
                        (s, l) => s + (Number.parseFloat(l.credit) || 0),
                        0,
                      ),
                      balanced: true,
                    }}
                    validationErrors={new Set()}
                    departmentOptions={departmentOptions}
                    locationOptions={locationOptions}
                    listPartiesFn={listParties}
                    partyOverrides={typedOverrides}
                    readOnly={readOnly}
                    onPartyNameChange={handleJournalPartyNameChange}
                  />
                )}

                {(activeType === "pay_in" || activeType === "pay_out") && (
                  <PayForm
                    type={activeType}
                    categoryId={mode === "edit" ? editPayCategoryId : payCategoryId}
                    onCategoryChange={setEditPayCategoryId}
                    lines={mode === "edit" ? editPayLines : payForLines}
                    accounts={flatAccounts}
                    onUpdateLine={handleUpdatePayLine}
                    onAddLine={handleAddPayLine}
                    onRemoveLine={handleRemovePayLine}
                    onCopyLine={handleCopyPayLine}
                    onAddLineAfter={handleAddPayLineAfter}
                    total={(mode === "edit" ? editPayLines : payForLines).reduce(
                      (s: number, l: PayForLine) => s + (Number.parseFloat(l.amount) || 0),
                      0,
                    )}
                    partyOptions={partyOptions}
                    onPartyQueryChange={setPartyQuery}
                    partyId={mode === "edit" ? editPartyId : transaction.partyId || ""}
                    onPartyChange={setEditPartyId}
                    departmentOptions={departmentOptions}
                    locationOptions={locationOptions}
                    readOnly={readOnly}
                  />
                )}

                {activeType === "transfer" && (
                  <TransferForm
                    accounts={flatAccounts}
                    fromParty={mode === "edit" ? editTransferFromParty : ""}
                    fromCategory={mode === "edit" ? editTransferFrom : transferData.fromCategory}
                    toParty={mode === "edit" ? editTransferToParty : ""}
                    toCategory={mode === "edit" ? editTransferTo : transferData.toCategory}
                    amount={mode === "edit" ? editTransferAmount : transferData.amount}
                    onAmountChange={setEditTransferAmount}
                    onFromPartyChange={setEditTransferFromParty}
                    onFromCategoryChange={setEditTransferFrom}
                    onToPartyChange={setEditTransferToParty}
                    onToCategoryChange={setEditTransferTo}
                    listPartiesFn={listParties}
                    partyOverrides={typedOverrides}
                    readOnly={readOnly}
                  />
                )}
              </div>

              {/* Bottom totals bar — Journal */}
              {activeType === "journal" && (
                <div className="px-6 py-3 border-t border-[#e2e8f0] dark:border-slate-700 flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="#14b8a6"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                    <span className="text-xs font-medium text-[#14b8a6]">
                      {formatCurrency(
                        journalLines.reduce((s, l) => s + (Number.parseFloat(l.debit) || 0), 0),
                      )}
                    </span>
                  </div>
                  <div className="flex gap-6 text-xs">
                    <div>
                      <span className="text-[#94a3b8] dark:text-slate-500">Debit</span>{" "}
                      <span className="font-semibold text-[#1e293b] dark:text-white tabular-nums">
                        {formatCurrency(
                          journalLines.reduce((s, l) => s + (Number.parseFloat(l.debit) || 0), 0),
                        )}
                      </span>
                    </div>
                    <div>
                      <span className="text-[#94a3b8] dark:text-slate-500">Credit</span>{" "}
                      <span className="font-semibold text-[#1e293b] dark:text-white tabular-nums">
                        {formatCurrency(
                          journalLines.reduce((s, l) => s + (Number.parseFloat(l.credit) || 0), 0),
                        )}
                      </span>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* ── Right Sidebar ── */}
            <div
              className={`${
                showSidebar
                  ? "fixed inset-0 z-50 flex justify-end bg-black/30 lg:static lg:bg-transparent lg:inset-auto lg:z-auto lg:w-[360px] lg:shrink-0"
                  : "hidden lg:block w-[360px] shrink-0"
              }`}
            >
              {showSidebar && (
                <button
                  type="button"
                  className="absolute inset-0 lg:hidden"
                  onClick={() => setShowSidebar(false)}
                  aria-label="Close sidebar"
                />
              )}
              <div className="relative w-full max-w-[360px] lg:w-[360px] ml-auto bg-white dark:bg-slate-900 lg:rounded-2xl rounded-l-2xl shadow-[0_4px_24px_rgba(0,0,0,0.08)] h-full flex flex-col">
                {/* Tab selector — gradient matches entity sidebar */}
                <div className="flex justify-evenly bg-gradient-to-r from-[#1a6b3c] to-[#27ae60] dark:from-[#145a30] dark:to-[#1e8c4c] shrink-0 px-4 py-2 gap-2 lg:rounded-t-2xl rounded-tl-2xl">
                  {/* Comments */}
                  <button
                    type="button"
                    onClick={() => setSidebarTab("comments")}
                    className={`w-20 h-12 flex flex-col items-center justify-center gap-0.5 rounded-full transition-colors ${
                      sidebarTab === "comments"
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
                      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                    </svg>
                    <span className="text-[9px] font-medium leading-none">Comments</span>
                  </button>
                  {/* Insights */}
                  <button
                    type="button"
                    onClick={() => setSidebarTab("insights")}
                    className={`w-20 h-12 flex flex-col items-center justify-center gap-0.5 rounded-full transition-colors ${
                      sidebarTab === "insights"
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
                      <rect x="4" y="2" width="16" height="20" rx="2" />
                      <line x1="8" y1="6" x2="16" y2="6" />
                      <line x1="8" y1="10" x2="16" y2="10" />
                      <line x1="8" y1="14" x2="12" y2="14" />
                    </svg>
                    <span className="text-[9px] font-medium leading-none">Insights</span>
                  </button>
                  {/* Activity */}
                  <button
                    type="button"
                    onClick={() => setSidebarTab("activity")}
                    className={`w-20 h-12 flex flex-col items-center justify-center gap-0.5 rounded-full transition-colors ${
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
                      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
                    </svg>
                    <span className="text-[9px] font-medium leading-none">Activity</span>
                  </button>
                </div>

                {/* Tab content */}
                <div className="flex-1 p-4 overflow-y-auto">
                  {/* Comments tab */}
                  {sidebarTab === "comments" && <CommentsTab transactionId={transaction.id} />}

                  {/* Insights tab */}
                  {sidebarTab === "insights" && (
                    <div className="space-y-3">
                      {transaction.partyId && partySummary ? (
                        <>
                          {/* Party Entity Card */}
                          <Link
                            to="/entities/$entityType/$partyId"
                            params={{
                              entityType: partySummary.party.partyType,
                              partyId: partySummary.party.id,
                            }}
                            className="block rounded-xl bg-[#f0f8ff] dark:bg-slate-800 border border-[#d0e8ff] dark:border-slate-600 p-4 hover:border-[var(--color-app-header-teal)] transition-colors no-underline"
                          >
                            <div className="flex items-center gap-3">
                              <div className="w-10 h-10 rounded-full bg-[var(--color-app-header-teal)] text-white flex items-center justify-center text-sm font-bold shrink-0">
                                {partySummary.party.name.charAt(0).toUpperCase()}
                              </div>
                              <div className="flex-1 min-w-0">
                                <p className="text-sm font-semibold text-[#1e293b] dark:text-white truncate">
                                  {partySummary.party.name}
                                </p>
                                <p className="text-[10px] text-[#64748b] dark:text-slate-400 capitalize">
                                  {partySummary.party.partyType.replace("_", " ")}
                                </p>
                                {/* Contact metadata */}
                                {(partySummary.party.email ||
                                  partySummary.party.phone ||
                                  partySummary.party.website) && (
                                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-1">
                                    {partySummary.party.email && (
                                      <span
                                        className="text-[10px] text-[#3b82f6] truncate max-w-[120px]"
                                        title={partySummary.party.email}
                                      >
                                        ✉ {partySummary.party.email}
                                      </span>
                                    )}
                                    {partySummary.party.website && (
                                      <span
                                        className="text-[10px] text-[#3b82f6] truncate max-w-[120px]"
                                        title={partySummary.party.website}
                                      >
                                        🔗 {partySummary.party.website}
                                      </span>
                                    )}
                                    {partySummary.party.phone && (
                                      <span
                                        className="text-[10px] text-[#3b82f6]"
                                        title={partySummary.party.phone}
                                      >
                                        📞 {partySummary.party.phone}
                                      </span>
                                    )}
                                  </div>
                                )}
                              </div>
                              <svg
                                width="16"
                                height="16"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="#94a3b8"
                                strokeWidth="1.5"
                                className="shrink-0"
                              >
                                <path
                                  d="M9 18l6-6-6-6"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                />
                              </svg>
                            </div>
                          </Link>

                          {/* Summary — reactive chart header */}
                          {(() => {
                            const curMonth = new Date().getMonth() + 1;
                            const trailingMonths: {
                              month: number;
                              totalAmount: string;
                              transactionCount: number;
                              year: number;
                            }[] = [];
                            for (let i = 11; i >= 0; i--) {
                              let m = curMonth - i;
                              let yr = currentYear;
                              if (m < 1) {
                                m += 12;
                                yr = prevYear;
                              }
                              const source = yr === currentYear ? partySummary : prevYearSummary;
                              const found = source?.months?.find((x: any) => x.month === m);
                              trailingMonths.push(
                                found
                                  ? { ...found, year: yr }
                                  : {
                                      month: m,
                                      totalAmount: "0",
                                      transactionCount: 0,
                                      year: yr,
                                    },
                              );
                            }

                            const MONTH_FULL = [
                              "January",
                              "February",
                              "March",
                              "April",
                              "May",
                              "June",
                              "July",
                              "August",
                              "September",
                              "October",
                              "November",
                              "December",
                            ];

                            return (
                              <InsightChartPanel
                                trailingMonths={trailingMonths}
                                partyName={partySummary.party.name}
                                partyType={partySummary.party.partyType}
                                monthFull={MONTH_FULL}
                              />
                            );
                          })()}
                        </>
                      ) : (
                        <div className="rounded-lg bg-[#f9fafb] dark:bg-slate-800 border border-[#e2e8f0] dark:border-slate-700 p-3">
                          <div className="flex items-center gap-2 mb-1.5">
                            <svg
                              width="14"
                              height="14"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="#14b8a6"
                              strokeWidth="2"
                            >
                              <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                              <circle cx="8.5" cy="7" r="4" />
                              <line x1="20" y1="8" x2="20" y2="14" />
                              <line x1="23" y1="11" x2="17" y2="11" />
                            </svg>
                            <span className="text-[11px] font-semibold text-[#475569] dark:text-slate-300 uppercase tracking-wide">
                              Entity Insights
                            </span>
                          </div>
                          <p className="text-xs text-[#64748b] dark:text-slate-400 leading-relaxed">
                            No party associated with this transaction. Assign a party to see
                            insights.
                          </p>
                        </div>
                      )}

                      {/* Similar Transactions */}
                      {similarTransactions && similarTransactions.length > 0 && (
                        <div className="rounded-xl bg-white dark:bg-slate-800 border border-[#e2e8f0] dark:border-slate-700 p-4 mt-3">
                          <p className="text-[11px] font-semibold text-[#475569] dark:text-slate-300 uppercase tracking-wide mb-3">
                            Similar Transactions
                          </p>
                          <div className="space-y-0">
                            {similarTransactions.map(
                              (stx: SimilarTransactionRecord, idx: number) => {
                                const date = stx.transactionDate
                                  ? new Date(stx.transactionDate)
                                  : null;
                                const dateLabel = date
                                  ? `${date.toLocaleString("default", { month: "short" })} ${String(date.getDate()).padStart(2, "0")}`
                                  : "";
                                const amt = Number.parseFloat(stx.totalAmount || "0");
                                const initial = (stx.partyName || "?").charAt(0).toUpperCase();

                                // Color based on party type
                                const colorMap: Record<string, string> = {
                                  vendor: "#8b5cf6",
                                  customer: "#3b82f6",
                                  employee: "#f59e0b",
                                  shareholder: "#ec4899",
                                  lender: "#6366f1",
                                  government: "#ef4444",
                                };
                                const avatarColor = colorMap[stx.partyType || ""] || "#14b8a6";

                                return (
                                  <Link
                                    key={stx.id}
                                    to={`/transactions/${stx.id}` as string & {}}
                                    className={`flex items-center gap-2.5 py-2 px-1 hover:bg-[#f8fafc] dark:hover:bg-slate-700/50 rounded-md transition-colors ${
                                      idx < similarTransactions.length - 1
                                        ? "border-b border-[#f1f5f9] dark:border-slate-700"
                                        : ""
                                    }`}
                                  >
                                    {/* Date */}
                                    <span className="text-[10px] text-[#94a3b8] dark:text-slate-500 font-medium w-[36px] shrink-0 text-right">
                                      {dateLabel}
                                    </span>

                                    {/* Avatar */}
                                    <div
                                      className="w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-bold text-white shrink-0"
                                      style={{ backgroundColor: avatarColor }}
                                    >
                                      {initial}
                                    </div>

                                    {/* Name + Category */}
                                    <div className="flex-1 min-w-0">
                                      <p className="text-[11px] font-semibold text-[#1e293b] dark:text-white truncate leading-tight">
                                        {stx.partyName || "Unknown"}
                                      </p>
                                      {stx.categoryName && (
                                        <p className="text-[9.5px] text-[#14b8a6] truncate leading-tight mt-0.5">
                                          {stx.categoryName}
                                        </p>
                                      )}
                                    </div>

                                    {/* Amount */}
                                    <span className="text-[11px] font-semibold text-[#1e293b] dark:text-white shrink-0">
                                      {formatCurrency(amt)}
                                    </span>
                                  </Link>
                                );
                              },
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Activity log */}
                  {sidebarTab === "activity" && (
                    <div className="space-y-0">
                      {activityLogEntries.length > 0 ? (
                        activityLogEntries.map((entry, i: number) => {
                          const iconMap: Record<
                            string,
                            "create" | "edit" | "post" | "void" | "attach" | "detach"
                          > = {
                            created: "create",
                            updated: "edit",
                            posted: "post",
                            voided: "void",
                            attachment_added: "attach",
                            attachment_removed: "detach",
                          };
                          const labelMap: Record<string, string> = {
                            created: "Created this transaction",
                            updated: "Edited this transaction",
                            posted: "Posted this transaction",
                            voided: "Voided this transaction",
                            attachment_added: "Attached a document",
                            attachment_removed: "Removed an attachment",
                          };

                          // Build clickable link for attachment actions
                          let href: string | undefined;
                          if (
                            (entry.action === "attachment_added" ||
                              entry.action === "attachment_removed") &&
                            entry.changes?.documentId
                          ) {
                            href = `/documents/${entry.changes.documentId}`;
                          }

                          return (
                            <TimelineEntry
                              key={entry.id}
                              icon={iconMap[entry.action] ?? "edit"}
                              label={labelMap[entry.action] ?? entry.action}
                              timestamp={
                                entry.createdAt instanceof Date
                                  ? entry.createdAt.toISOString()
                                  : entry.createdAt
                              }
                              userName={entry.actorName}
                              isLast={i === activityLogEntries.length - 1}
                              href={href}
                              changes={entry.changes}
                              action={entry.action}
                            />
                          );
                        })
                      ) : (
                        /* Fallback to old timestamps when no activity logs exist yet */
                        <>
                          {transaction.voidedAt && (
                            <TimelineEntry
                              icon="void"
                              label="Voided this transaction"
                              timestamp={transaction.voidedAt}
                            />
                          )}
                          {transaction.postedAt && (
                            <TimelineEntry
                              icon="post"
                              label="Posted this transaction"
                              timestamp={transaction.postedAt}
                            />
                          )}
                          {transaction.updatedAt &&
                            transaction.updatedAt !== transaction.createdAt && (
                              <TimelineEntry
                                icon="edit"
                                label="Edited this transaction"
                                timestamp={transaction.updatedAt}
                              />
                            )}
                          <TimelineEntry
                            icon="create"
                            label="Created this transaction"
                            timestamp={transaction.createdAt}
                            userName={transaction.createdByName}
                            isLast
                          />
                        </>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Delete confirmation dialog */}
      {showDeleteConfirm && (
        <ConfirmModal
          title="Delete Transaction"
          subtitle="This will permanently delete this transaction and all its journal lines. This action cannot be undone."
          message={null}
          confirmLabel={deleteMutation.isPending ? "Deleting..." : "Delete"}
          cancelLabel="Cancel"
          onConfirm={() => {
            setShowDeleteConfirm(false);
            deleteMutation.mutate();
          }}
          onCancel={() => setShowDeleteConfirm(false)}
          isLoading={deleteMutation.isPending}
          destructive={true}
        />
      )}

      {/* Lossless duplicate-unmerge confirmation */}
      {unmatchMergeId && (
        <ConfirmModal
          title="Separate merged transactions"
          subtitle="Both original journals and all evidence remain intact."
          message={
            <div className="space-y-4">
              <p className="leading-5 text-slate-600">
                Separating restores the duplicate as an effective ledger transaction, so both
                journals will count in balances and reports.
              </p>
              <label
                htmlFor="unmatch-reason"
                className="block text-xs font-semibold text-slate-700"
              >
                Reason
                <textarea
                  id="unmatch-reason"
                  value={unmatchReason}
                  onChange={(event) => setUnmatchReason(event.target.value)}
                  rows={3}
                  autoFocus
                  disabled={unmatchMutation.isPending}
                  aria-describedby="unmatch-reason-help"
                  placeholder="Explain why these transactions should remain separate"
                  className="mt-2 w-full resize-none rounded-md border border-slate-300 bg-white p-3 text-base sm:text-sm font-normal text-slate-900 outline-none transition focus:border-teal-600 focus:ring-2 focus:ring-teal-600/15 disabled:bg-slate-100"
                />
              </label>
              <p id="unmatch-reason-help" className="text-[11px] text-slate-500">
                Required and stored in the permanent audit history.
              </p>
            </div>
          }
          confirmLabel="Separate transactions"
          cancelLabel="Cancel"
          onConfirm={confirmUnmatch}
          onCancel={closeUnmatchDialog}
          isLoading={unmatchMutation.isPending}
          confirmDisabled={unmatchReason.trim().length < 3}
          destructive={false}
          icon={
            <svg
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M8 12h8" />
              <path d="M12 8v8" />
              <path d="M4 4l16 16" />
            </svg>
          }
        />
      )}
    </div>
  );
}

// ============================================================================
// Comments Tab (attachments + comments)
// ============================================================================

// ----------- Attachment Row with context menu -----------
type ServerFn = (opts: { data: unknown }) => Promise<any>;

function AttachmentRow({
  att,
  transactionId,
  queryClient,
}: {
  att: {
    id: string;
    documentId: string;
    linkableId: string;
    inheritedFromMergedJournal?: boolean;
    document?: { displayTitle?: string; originalFilename?: string };
  };
  transactionId: string;
  queryClient: ReturnType<typeof useQueryClient>;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [menuOpen]);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["transaction-attachments", transactionId] });
    queryClient.invalidateQueries({ queryKey: ["activity-logs", "transaction", transactionId] });
    if (att.linkableId !== transactionId) {
      queryClient.invalidateQueries({
        queryKey: ["activity-logs", "transaction", att.linkableId],
      });
    }
  };

  const handleDownload = async () => {
    setMenuOpen(false);
    try {
      const result = await (getDocumentUrl as ServerFn)({
        data: { documentId: att.documentId },
      });
      if (result?.url) {
        window.open(result.url, "_blank");
      }
    } catch (err) {
      logger.error("Download failed", { error: err });
    }
  };

  const handleRename = async () => {
    setMenuOpen(false);
    const currentName = att.document?.displayTitle || att.document?.originalFilename || "Document";
    const newName = window.prompt("Rename document:", currentName);
    if (!newName || newName === currentName) return;
    try {
      await (updateDocument as ServerFn)({
        data: { documentId: att.documentId, displayTitle: newName },
      });
      invalidate();
    } catch (err) {
      logger.error("Rename failed", { error: err });
    }
  };

  const handleUnlink = async () => {
    setMenuOpen(false);
    try {
      await (detachDocument as ServerFn)({
        data: {
          documentId: att.documentId,
          linkableType: "journal_header",
          linkableId: att.linkableId,
        },
      });
      invalidate();
    } catch (err) {
      logger.error("Unlink failed", { error: err });
    }
  };

  const handleDelete = async () => {
    setMenuOpen(false);
    if (!window.confirm("Permanently delete this document? This cannot be undone.")) return;
    try {
      await (deleteDocument as ServerFn)({
        data: { documentId: att.documentId },
      });
      invalidate();
    } catch (err) {
      logger.error("Delete failed", { error: err });
    }
  };

  const menuItems = [
    {
      label: "Download",
      icon: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3",
      action: handleDownload,
      color: "#475569",
    },
    {
      label: "Rename",
      icon: "M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z",
      action: handleRename,
      color: "#475569",
    },
    {
      label: "Unlink",
      icon: "M18.84 12.25l1.72-1.71a5 5 0 0 0-7.07-7.07l-3 3a5 5 0 0 0 .54 7.54M5.16 11.75l-1.72 1.71a5 5 0 0 0 7.07 7.07l3-3a5 5 0 0 0-.54-7.54M2 2l20 20",
      action: handleUnlink,
      color: "#d97706",
    },
    {
      label: "Delete",
      icon: "M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2",
      action: handleDelete,
      color: "#ef4444",
    },
  ];

  return (
    <div
      className="group relative flex items-center gap-2 rounded-lg border border-[#e2e8f0] bg-[#f1f5f9] px-2.5 py-2 transition-colors hover:border-[var(--color-app-header-teal)] dark:border-slate-700 dark:bg-slate-800"
      title={
        att.inheritedFromMergedJournal
          ? "Evidence attached to the merged duplicate journal"
          : undefined
      }
    >
      {/* File icon */}
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="#64748b"
        strokeWidth="1.5"
        className="shrink-0"
      >
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
      </svg>
      <span className="text-xs text-[#1e293b] dark:text-slate-200 truncate flex-1">
        {att.document?.displayTitle || att.document?.originalFilename || "Document"}
      </span>
      {att.inheritedFromMergedJournal && (
        <span className="shrink-0 rounded bg-amber-100 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-amber-800 dark:bg-amber-950/50 dark:text-amber-200">
          Merged
        </span>
      )}

      {/* 3-dot menu button */}
      <div ref={menuRef}>
        <button
          ref={btnRef}
          type="button"
          onClick={() => setMenuOpen((v) => !v)}
          className="w-5 h-5 flex items-center justify-center rounded text-[#94a3b8] hover:text-[#475569] dark:hover:text-slate-200 opacity-0 group-hover:opacity-100 transition-opacity"
          title="More actions"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <circle cx="12" cy="5" r="1.5" />
            <circle cx="12" cy="12" r="1.5" />
            <circle cx="12" cy="19" r="1.5" />
          </svg>
        </button>

        {/* Context Menu — fixed positioning to escape overflow clipping */}
        {menuOpen &&
          (() => {
            const rect = btnRef.current?.getBoundingClientRect();
            if (!rect) return null;
            return (
              <div
                className="fixed z-[9999] bg-white dark:bg-slate-800 rounded-lg border border-[#e2e8f0] dark:border-slate-600 shadow-xl py-1 min-w-[140px]"
                style={{ top: rect.bottom + 4, right: window.innerWidth - rect.right }}
              >
                {menuItems.map((item) => (
                  <button
                    key={item.label}
                    type="button"
                    onClick={item.action}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-[#f1f5f9] dark:hover:bg-slate-700 transition-colors"
                  >
                    <svg
                      width="18"
                      height="18"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke={item.color}
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="shrink-0"
                    >
                      <path d={item.icon} />
                    </svg>
                    <span className="text-xs" style={{ color: item.color }}>
                      {item.label}
                    </span>
                  </button>
                ))}
              </div>
            );
          })()}
      </div>
    </div>
  );
}

function CommentsTab({ transactionId }: { transactionId: string }) {
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const { data: attachmentsData } = useQuery({
    queryKey: ["transaction-attachments", transactionId],
    queryFn: () =>
      (listDocumentAttachments as (opts: { data: unknown }) => Promise<any>)({
        data: { linkableType: "journal_header", linkableId: transactionId },
      }),
    staleTime: 30_000,
  });

  const attachments = attachmentsData?.attachments ?? [];
  const hasAttachments = attachments.length > 0;

  const handleFileSelect = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0) return;
      setUploading(true);
      try {
        for (const file of Array.from(files)) {
          const buffer = await file.arrayBuffer();
          const base64 = btoa(
            new Uint8Array(buffer).reduce((s, b) => s + String.fromCharCode(b), ""),
          );
          const uploadResult = await (uploadDocument as (opts: { data: unknown }) => Promise<any>)({
            data: {
              filename: file.name,
              contentType: file.type || "application/octet-stream",
              fileBase64: base64,
              intakeMode: "evidence_only",
            },
          });
          if (uploadResult?.document?.id) {
            await (attachDocument as (opts: { data: unknown }) => Promise<any>)({
              data: {
                documentId: uploadResult.document.id,
                linkableType: "journal_header",
                linkableId: transactionId,
              },
            });
          }
        }
        queryClient.invalidateQueries({ queryKey: ["transaction-attachments", transactionId] });
        queryClient.invalidateQueries({
          queryKey: ["activity-logs", "transaction", transactionId],
        });
      } catch (err) {
        logger.error("Failed to upload/attach document", { error: err });
      } finally {
        setUploading(false);
        if (fileInputRef.current) fileInputRef.current.value = "";
      }
    },
    [transactionId, queryClient],
  );

  const openFilePicker = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  // --- Link existing document picker ---
  const [showDocPicker, setShowDocPicker] = useState(false);
  const [docSearch, setDocSearch] = useState("");
  const docPickerRef = useRef<HTMLDivElement>(null);

  const { data: allDocsData } = useQuery({
    queryKey: ["all-documents-for-picker"],
    queryFn: () =>
      (listDocuments as (opts: { data: unknown }) => Promise<any>)({
        data: {},
      }),
    enabled: showDocPicker,
    staleTime: 60_000,
  });

  // Filter out already-attached documents + apply search
  const attachedIds = new Set(attachments.map((a: { documentId: string }) => a.documentId));
  const availableDocs = (allDocsData?.documents ?? []).filter(
    (d: { id: string; displayTitle?: string; originalFilename?: string }) =>
      !attachedIds.has(d.id) &&
      (!docSearch ||
        (d.displayTitle || d.originalFilename || "")
          .toLowerCase()
          .includes(docSearch.toLowerCase())),
  );

  const handleLinkDoc = useCallback(
    async (documentId: string) => {
      try {
        await (attachDocument as (opts: { data: unknown }) => Promise<any>)({
          data: {
            documentId,
            linkableType: "journal_header",
            linkableId: transactionId,
          },
        });
        queryClient.invalidateQueries({ queryKey: ["transaction-attachments", transactionId] });
        queryClient.invalidateQueries({
          queryKey: ["activity-logs", "transaction", transactionId],
        });
        setShowDocPicker(false);
        setDocSearch("");
      } catch (err) {
        logger.error("Failed to link document", { error: err });
      }
    },
    [transactionId, queryClient],
  );

  // Close picker on outside click
  useEffect(() => {
    if (!showDocPicker) return;
    const handler = (e: MouseEvent) => {
      if (docPickerRef.current && !docPickerRef.current.contains(e.target as Node)) {
        setShowDocPicker(false);
        setDocSearch("");
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showDocPicker]);

  return (
    <div className="flex flex-col h-full">
      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        multiple
        accept=".pdf,.png,.jpg,.jpeg,.gif,.webp,.csv,.xlsx,.xls,.doc,.docx,.zip"
        onChange={(e) => handleFileSelect(e.target.files)}
      />

      {/* Attachments Section */}
      <div className="mb-3 relative" ref={docPickerRef}>
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-semibold text-[#475569] dark:text-slate-300 uppercase tracking-wide">
            Attachments
          </span>
          <div className="flex items-center gap-1">
            {/* Link existing document */}
            <button
              type="button"
              onClick={() => setShowDocPicker((v) => !v)}
              className={`w-5 h-5 flex items-center justify-center rounded-full transition-opacity ${
                showDocPicker
                  ? "bg-[var(--color-app-header-teal)] text-white"
                  : "bg-[#e2e8f0] dark:bg-slate-700 text-[#64748b] dark:text-slate-400 hover:bg-[var(--color-app-header-teal)] hover:text-white"
              }`}
              title="Link existing document"
            >
              <svg
                width="11"
                height="11"
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
            </button>
            {/* Upload new document */}
            <button
              type="button"
              onClick={openFilePicker}
              disabled={uploading}
              className="w-5 h-5 flex items-center justify-center rounded-full bg-[var(--color-app-header-teal)] text-white hover:opacity-80 transition-opacity disabled:opacity-50"
              title="Upload new document"
            >
              {uploading ? (
                <svg width="12" height="12" viewBox="0 0 24 24" className="animate-spin">
                  <circle
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="3"
                    fill="none"
                    strokeDasharray="31 31"
                  />
                </svg>
              ) : (
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
              )}
            </button>
          </div>
        </div>

        {/* Document Picker Dropdown */}
        {showDocPicker && (
          <div className="absolute top-8 left-0 right-0 z-50 bg-white dark:bg-slate-800 rounded-lg border border-[#e2e8f0] dark:border-slate-600 shadow-xl max-h-52 flex flex-col overflow-hidden">
            <div className="p-2 border-b border-[#e2e8f0] dark:border-slate-700">
              <input
                type="text"
                value={docSearch}
                onChange={(e) => setDocSearch(e.target.value)}
                placeholder="Search documents…"
                className="w-full text-base sm:text-xs px-2 py-1.5 rounded-md border border-[#e2e8f0] dark:border-slate-600 bg-[#f9fafb] dark:bg-slate-900 text-[#1e293b] dark:text-white placeholder-[#94a3b8] focus:outline-none focus:border-[var(--color-app-header-teal)]"
                autoFocus
              />
            </div>
            <div className="overflow-y-auto flex-1">
              {availableDocs.length === 0 ? (
                <p className="text-xs text-[#94a3b8] p-3 text-center">
                  {docSearch ? "No matching documents" : "No documents available"}
                </p>
              ) : (
                availableDocs.map(
                  (doc: {
                    id: string;
                    displayTitle?: string;
                    originalFilename?: string;
                    fileType?: string;
                  }) => (
                    <button
                      key={doc.id}
                      type="button"
                      onClick={() => handleLinkDoc(doc.id)}
                      className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-[#f1f5f9] dark:hover:bg-slate-700 transition-colors"
                    >
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="#64748b"
                        strokeWidth="1.5"
                        className="shrink-0"
                      >
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                        <polyline points="14 2 14 8 20 8" />
                      </svg>
                      <span className="text-xs text-[#1e293b] dark:text-slate-200 truncate">
                        {doc.displayTitle || doc.originalFilename || "Untitled"}
                      </span>
                      {doc.fileType && (
                        <span className="ml-auto text-[9px] uppercase text-[#94a3b8] shrink-0">
                          {doc.fileType}
                        </span>
                      )}
                    </button>
                  ),
                )
              )}
            </div>
          </div>
        )}

        {hasAttachments ? (
          <div className="space-y-1.5 max-h-40 overflow-y-auto">
            {attachments.map(
              (att: {
                id: string;
                documentId: string;
                linkableId: string;
                inheritedFromMergedJournal?: boolean;
                document?: { displayTitle?: string; originalFilename?: string };
              }) => (
                <AttachmentRow
                  key={att.id}
                  att={att}
                  transactionId={transactionId}
                  queryClient={queryClient}
                />
              ),
            )}
          </div>
        ) : (
          <div
            className="flex flex-col items-center py-6 rounded-lg border border-dashed border-[#cbd5e1] dark:border-slate-600 bg-[#f9fafb] dark:bg-slate-800/50 cursor-pointer hover:border-[var(--color-app-header-teal)] transition-colors"
            onClick={openFilePicker}
            onDragOver={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
            onDrop={(e) => {
              e.preventDefault();
              e.stopPropagation();
              handleFileSelect(e.dataTransfer.files);
            }}
          >
            <svg
              width="28"
              height="28"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#94a3b8"
              strokeWidth="1.5"
              className="mb-2"
            >
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
            </svg>
            <p className="text-xs text-[#94a3b8] dark:text-slate-500">
              {uploading ? "Uploading…" : "No attachments attached"}
            </p>
            <p className="text-[10px] text-[#3b82f6] mt-1 hover:underline">Browse or Drag & Drop</p>
          </div>
        )}
      </div>

      {/* Separator */}
      <div className="border-t border-[#e2e8f0] dark:border-slate-700 mb-3" />

      {/* Comments Section */}
      <div className="flex-1 flex flex-col min-h-0">
        <CommentThread entityType="transaction" entityId={transactionId} />
      </div>
    </div>
  );
}

// ============================================================================
// Party Bar Chart (Insights widget) —
// ============================================================================

const MONTH_SHORT = [
  "JAN",
  "FEB",
  "MAR",
  "APR",
  "MAY",
  "JUN",
  "JUL",
  "AUG",
  "SEP",
  "OCT",
  "NOV",
  "DEC",
];

function formatYLabel(val: number): string {
  if (val >= 1_000_000) return `$${(val / 1_000_000).toFixed(1)}M`;
  if (val >= 100_000) return `$${(val / 1_000).toFixed(0)}k`;
  if (val >= 1_000) return `$${(val / 1_000).toFixed(val >= 10_000 ? 0 : 1).replace(/\.0$/, "")}k`;
  if (val > 0) return `$${Math.round(val).toLocaleString()}`;
  return "$0";
}

function niceMax(rawMax: number): number {
  if (rawMax <= 0) return 100;
  const magnitude = Math.pow(10, Math.floor(Math.log10(rawMax)));
  const normalized = rawMax / magnitude;
  const steps = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
  for (const s of steps) {
    if (s >= normalized) return s * magnitude;
  }
  return 10 * magnitude;
}

function InsightChartPanel({
  trailingMonths,
  partyName,
  partyType,
  monthFull,
}: {
  trailingMonths: { month: number; totalAmount: string; transactionCount: number; year: number }[];
  partyName: string;
  partyType: string;
  monthFull: string[];
}) {
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  // Active index: hovered bar or default to last (current month)
  const activeIdx = hoveredIdx ?? trailingMonths.length - 1;
  const activeMonth = trailingMonths[activeIdx];
  const activeAmount = Math.abs(Number.parseFloat(activeMonth.totalAmount));

  // Previous month comparison
  const prevIdx = activeIdx > 0 ? activeIdx - 1 : null;
  const prevAmount =
    prevIdx !== null ? Math.abs(Number.parseFloat(trailingMonths[prevIdx].totalAmount)) : null;
  // Only show comparison when both months have transactions
  let pctChange: number | null = null;
  if (prevAmount !== null && prevAmount > 0 && activeAmount > 0) {
    pctChange = ((activeAmount - prevAmount) / prevAmount) * 100;
  }

  return (
    <div className="rounded-xl bg-white dark:bg-slate-800 border border-[#e2e8f0] dark:border-slate-700 p-4">
      <div className="flex items-baseline justify-between">
        <p className="text-sm font-semibold text-[#1e293b] dark:text-white">
          {partyName}{" "}
          <span className="text-[#64748b] dark:text-slate-400 font-normal capitalize">
            ({partyType})
          </span>
        </p>
        <span className="text-sm font-bold text-[var(--color-app-header-teal)]">
          {formatCurrency(activeAmount)}
        </span>
      </div>
      <div className="flex items-center gap-2 mt-0.5">
        <p className="text-[11px] text-[#94a3b8] dark:text-slate-500">
          {monthFull[activeMonth.month - 1]} {activeMonth.year}
        </p>
        {pctChange !== null && (
          <span
            className={`text-[11px] font-semibold ${
              pctChange >= 0 ? "text-emerald-500" : "text-red-400"
            }`}
          >
            {pctChange >= 0 ? "▲" : "▼"} {Math.abs(pctChange).toFixed(0)}%
            <span className="text-[#94a3b8] font-normal"> vs prev month</span>
          </span>
        )}
      </div>

      {/* Bar Chart — trailing 12 months */}
      <div className="mt-3 -mx-4">
        <PartyBarChart months={trailingMonths} hoveredIdx={hoveredIdx} onHoverIdx={setHoveredIdx} />
      </div>
    </div>
  );
}

function PartyBarChart({
  months,
  hoveredIdx,
  onHoverIdx,
}: {
  months: { month: number; totalAmount: string; transactionCount: number; year?: number }[];
  hoveredIdx: number | null;
  onHoverIdx: (idx: number | null) => void;
}) {
  const values = months.map((m) => Math.abs(Number.parseFloat(m.totalAmount)));
  const rawMax = Math.max(...values, 1);
  const max = niceMax(rawMax);

  // Layout — matches reference layout exactly
  const leftPad = 40;
  const rightPad = 2;
  const topPad = 6;
  const bottomPad = 18;
  const viewWidth = 360;
  const chartH = 108;
  const barArea = viewWidth - leftPad - rightPad;
  // Bar-to-gap ratio 11:10. Fill available width dynamically.
  const totalSlots = months.length + (months.length - 1); // bars + gaps
  const barW = barArea / totalSlots;
  const gap = barW;

  // Y-axis: 5 ticks
  const yTicks = 5;

  const labelFont = "'Avenir', Helvetica, Arial, sans-serif";
  const labelColor = "#32497f";

  return (
    <div className="w-full">
      <svg
        viewBox={`0 0 ${viewWidth} ${chartH + topPad + bottomPad}`}
        className="w-full"
        preserveAspectRatio="xMidYMid meet"
        onMouseLeave={() => onHoverIdx(null)}
      >
        <defs>
          <linearGradient id="insightBarActive" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#AEF2D6" />
            <stop offset="100%" stopColor="#89E3E9" />
          </linearGradient>
          <linearGradient id="insightBarHover" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#71F5BB" />
            <stop offset="100%" stopColor="#33E4C5" />
          </linearGradient>
        </defs>

        {/* Horizontal guide lines + Y-axis labels */}
        {Array.from({ length: yTicks + 1 }, (_, i) => {
          const pct = i / yTicks;
          const y = topPad + chartH - pct * chartH;
          const val = max * pct;
          return (
            <g key={i}>
              <line
                x1={leftPad}
                y1={y}
                x2={viewWidth - rightPad}
                y2={y}
                stroke={i === 0 ? "#e2e8f0" : "#f1f5f9"}
                strokeWidth="0.5"
              />
              <text
                x={leftPad - 4}
                y={y + 3.5}
                textAnchor="end"
                fontSize="10"
                fill={labelColor}
                fontFamily={labelFont}
                fontWeight="500"
              >
                {formatYLabel(val)}
              </text>
            </g>
          );
        })}

        {/* Bars */}
        {values.map((val, i) => {
          const barH = max > 0 ? (val / max) * chartH : 0;
          const x = leftPad + i * (barW + gap);
          const y = topPad + chartH - barH;
          const isLast = i === months.length - 1; // rightmost = current month
          const isHovered = hoveredIdx === i;
          const hasValue = val > 0;

          return (
            <g key={i} onMouseEnter={() => onHoverIdx(i)} style={{ cursor: "pointer" }}>
              {/* Invisible hit area for hover */}
              <rect x={x} y={topPad} width={barW} height={chartH} fill="transparent" />
              {/* Visible bar */}
              <rect
                x={x}
                y={hasValue ? y : topPad + chartH - 2}
                width={barW}
                height={hasValue ? Math.max(barH, 2) : 2}
                rx="2"
                fill={
                  isHovered
                    ? "url(#insightBarHover)"
                    : isLast
                      ? "url(#insightBarActive)"
                      : "#D6DBE5"
                }
              />

              {/* X-axis label — alternating, skip odd indices */}
              {i % 2 === 0 && (
                <text
                  x={x + barW / 2}
                  y={topPad + chartH + bottomPad - 4}
                  textAnchor="middle"
                  fontSize="10"
                  fill={isLast ? "#0f766e" : labelColor}
                  fontFamily={labelFont}
                  fontWeight="800"
                >
                  {MONTH_SHORT[months[i].month - 1]}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// ============================================================================
// Timeline Entry
// ============================================================================

function TimelineEntry({
  icon,
  label,
  timestamp,
  userName,
  isLast = false,
  href,
  changes,
  action,
}: {
  icon: "create" | "edit" | "post" | "void" | "attach" | "detach";
  label: string;
  timestamp: string;
  userName?: string | null;
  isLast?: boolean;
  href?: string;
  changes?: Record<string, any> | null;
  action?: string;
}) {
  const [expanded, setExpanded] = useState(false);

  const iconColors = {
    create: "bg-blue-100 dark:bg-blue-900/30 text-blue-500",
    edit: "bg-amber-100 dark:bg-amber-900/30 text-amber-500",
    post: "bg-emerald-100 dark:bg-emerald-900/30 text-emerald-500",
    void: "bg-red-100 dark:bg-red-900/30 text-red-500",
    attach: "bg-indigo-100 dark:bg-indigo-900/30 text-indigo-500",
    detach: "bg-orange-100 dark:bg-orange-900/30 text-orange-500",
  };

  const icons = {
    create: (
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
      >
        <line x1="12" y1="5" x2="12" y2="19" />
        <line x1="5" y1="12" x2="19" y2="12" />
      </svg>
    ),
    edit: (
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
      </svg>
    ),
    post: (
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
      >
        <polyline points="20 6 9 17 4 12" />
      </svg>
    ),
    void: (
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
      >
        <line x1="18" y1="6" x2="6" y2="18" />
        <line x1="6" y1="6" x2="18" y2="18" />
      </svg>
    ),
    attach: (
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
    ),
    detach: (
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
        <path d="M18.84 12.25l1.72-1.71a5 5 0 0 0-7.07-7.07l-3 3a5 5 0 0 0 .54 7.54" />
        <path d="M5.16 11.75l-1.72 1.71a5 5 0 0 0 7.07 7.07l3-3a5 5 0 0 0-.54-7.54" />
        <line x1="2" y1="2" x2="22" y2="22" />
      </svg>
    ),
  };

  const relativeTime = formatRelativeTime(timestamp);

  const labelContent = href ? (
    <Link
      to={href}
      className="underline decoration-dotted underline-offset-2 hover:decoration-solid hover:text-indigo-500 dark:hover:text-indigo-400 transition-colors"
    >
      {label}
    </Link>
  ) : (
    label
  );

  // Separate header-level diffs from per-line entries
  const allEntries = changes ? Object.entries(changes) : [];
  const isLineKey = (k: string) => /^line_\d+$/.test(k);

  // Header-level diffs: { old, new } pairs (excluding line_ keys and documentId/documentName)
  const headerDiffs: HeaderDiff[] = allEntries.filter(
    ([k, v]) =>
      !isLineKey(k) &&
      k !== "documentId" &&
      k !== "documentName" &&
      v &&
      typeof v === "object" &&
      "old" in v &&
      "new" in v,
  );

  // Line entries: line_1, line_2, etc.
  const lineEntries: LineEntry[] = allEntries
    .filter(([k]) => isLineKey(k))
    .sort(([a], [b]) => {
      const numA = Number.parseInt(a.replace("line_", ""), 10);
      const numB = Number.parseInt(b.replace("line_", ""), 10);
      return numA - numB;
    });

  // For creates, also show non-line flat header values as a snapshot
  const isCreateAction = action === "created";
  const headerSnapshotFields: HeaderSnapshotField[] = isCreateAction
    ? allEntries.filter(
        ([k, v]) =>
          !isLineKey(k) &&
          k !== "documentId" &&
          k !== "documentName" &&
          v !== null &&
          v !== undefined &&
          (typeof v !== "object" || !("old" in v)),
      )
    : [];

  // Count total changes for the toggle label
  let totalChangeCount = headerDiffs.length + headerSnapshotFields.length;
  for (const [, lineData] of lineEntries) {
    if (typeof lineData === "object") {
      const subFields = Object.entries(lineData as Record<string, any>).filter(
        ([, v]) => v !== null && v !== undefined && v !== "",
      );
      totalChangeCount += subFields.length;
    }
  }

  const hasExpandableChanges = totalChangeCount > 0;

  // For attachment actions, show document name inline
  const isAttachAction = action === "attachment_added" || action === "attachment_removed";
  const attachDocName = isAttachAction ? changes?.documentName : null;

  return (
    <div className="flex items-start gap-3 relative">
      {!isLast && (
        <div className="absolute left-[13px] top-7 bottom-0 w-px bg-[#e2e8f0] dark:bg-slate-700" />
      )}
      <div
        className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 ${iconColors[icon]}`}
      >
        {icons[icon]}
      </div>
      <div className="pb-4 min-w-0 flex-1">
        {userName ? (
          <p className="text-sm text-[#1e293b] dark:text-slate-200">
            <span className="font-semibold">{userName}</span>
            <span className="text-[#94a3b8] dark:text-slate-500"> · {relativeTime} · </span>
            <span className="text-[#64748b] dark:text-slate-400">{labelContent}</span>
          </p>
        ) : (
          <>
            <p className="text-sm font-medium text-[#1e293b] dark:text-slate-200">{labelContent}</p>
            <p className="text-[11px] text-[#94a3b8] dark:text-slate-500">{relativeTime}</p>
          </>
        )}

        {/* Attachment: show document name */}
        {attachDocName && (
          <p className="text-[11px] text-[#94a3b8] dark:text-slate-400 mt-0.5 truncate max-w-[200px]">
            {attachDocName}
          </p>
        )}

        {/* Collapsible change details (edit + create) */}
        {hasExpandableChanges && (
          <div className="mt-1">
            <button
              type="button"
              onClick={() => setExpanded(!expanded)}
              className="inline-flex items-center gap-1 text-[11px] text-[#64748b] dark:text-slate-400 hover:text-[#1e293b] dark:hover:text-slate-200 transition-colors"
            >
              <svg
                width="10"
                height="10"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="3"
                className={`transition-transform ${expanded ? "rotate-90" : ""}`}
              >
                <polyline points="9 18 15 12 9 6" />
              </svg>
              <span>
                {totalChangeCount} {totalChangeCount === 1 ? "change" : "changes"}
              </span>
            </button>
            {expanded && (
              <div className="mt-1.5 ml-3.5 space-y-0.5 border-l-2 border-[#e2e8f0] dark:border-slate-700 pl-2">
                {/* Header-level diffs (old → new) */}
                {headerDiffs.map(([field, diff]: HeaderDiff) => {
                  const fieldLabel = FIELD_LABELS[field] || field;
                  const oldVal = formatChangeValue(diff.old);
                  const newVal = formatChangeValue(diff.new);
                  return (
                    <p
                      key={field}
                      className="text-[11px] text-[#94a3b8] dark:text-slate-400 leading-relaxed"
                    >
                      <span className="text-[#64748b] dark:text-slate-500 font-medium">
                        {fieldLabel}:
                      </span>{" "}
                      <span className="line-through decoration-red-400/60">{oldVal}</span>
                      <span className="mx-1">{"\u2192"}</span>
                      <span className="text-emerald-600 dark:text-emerald-400">{newVal}</span>
                    </p>
                  );
                })}
                {/* Create snapshot: flat header values */}
                {headerSnapshotFields.map(([field, val]: HeaderSnapshotField) => (
                  <p
                    key={field}
                    className="text-[11px] text-[#94a3b8] dark:text-slate-400 leading-relaxed"
                  >
                    <span className="text-[#64748b] dark:text-slate-500 font-medium">
                      {FIELD_LABELS[field] || field}:
                    </span>{" "}
                    <span className="text-emerald-600 dark:text-emerald-400">
                      {formatChangeValue(val)}
                    </span>
                  </p>
                ))}
                {/* Per-line diffs */}
                {lineEntries.map(([lineKey, lineData]: LineEntry) => {
                  const lineNum = lineKey.replace("line_", "Line ");
                  const isCreate = action === "created";

                  if (
                    isCreate &&
                    typeof lineData === "object" &&
                    !("old" in lineData) &&
                    !("added" in lineData) &&
                    !("removed" in lineData)
                  ) {
                    // Create snapshot: flat field values
                    const fields = Object.entries(lineData as Record<string, string | null>).filter(
                      ([, v]) => v !== null && v !== undefined && v !== "",
                    );
                    if (fields.length === 0) return null;
                    return (
                      <div key={lineKey} className="mt-1">
                        <p className="text-[11px] text-[#64748b] dark:text-slate-400 font-semibold">
                          {lineNum}:
                        </p>
                        <div className="ml-2 space-y-0.5">
                          {fields.map(([f, v]) => (
                            <p
                              key={f}
                              className="text-[11px] text-[#94a3b8] dark:text-slate-400 leading-relaxed"
                            >
                              <span className="text-[#64748b] dark:text-slate-500 font-medium">
                                {LINE_FIELD_LABELS[f] || f}:
                              </span>{" "}
                              <span className="text-emerald-600 dark:text-emerald-400">
                                {formatChangeValue(v)}
                              </span>
                            </p>
                          ))}
                        </div>
                      </div>
                    );
                  }

                  // Line added (during update — more lines than before)
                  if (typeof lineData === "object" && "added" in lineData) {
                    const fields = Object.entries(
                      lineData.added as unknown as Record<string, string | null>,
                    ).filter(([, v]) => v !== null && v !== undefined && v !== "");
                    if (fields.length === 0) return null;
                    return (
                      <div key={lineKey} className="mt-1">
                        <p className="text-[11px] text-[#64748b] dark:text-slate-400 font-semibold">
                          {lineNum} <span className="text-emerald-500 font-normal">(added)</span>:
                        </p>
                        <div className="ml-2 space-y-0.5">
                          {fields.map(([f, v]) => (
                            <p
                              key={f}
                              className="text-[11px] text-[#94a3b8] dark:text-slate-400 leading-relaxed"
                            >
                              <span className="text-[#64748b] dark:text-slate-500 font-medium">
                                {LINE_FIELD_LABELS[f] || f}:
                              </span>{" "}
                              <span className="text-emerald-600 dark:text-emerald-400">
                                {formatChangeValue(v)}
                              </span>
                            </p>
                          ))}
                        </div>
                      </div>
                    );
                  }

                  // Line removed (during update — fewer lines than before)
                  if (typeof lineData === "object" && "removed" in lineData) {
                    const fields = Object.entries(
                      lineData.removed as unknown as Record<string, string | null>,
                    ).filter(([, v]) => v !== null && v !== undefined && v !== "");
                    if (fields.length === 0) return null;
                    return (
                      <div key={lineKey} className="mt-1">
                        <p className="text-[11px] text-[#64748b] dark:text-slate-400 font-semibold">
                          {lineNum} <span className="text-red-400 font-normal">(removed)</span>:
                        </p>
                        <div className="ml-2 space-y-0.5">
                          {fields.map(([f, v]) => (
                            <p
                              key={f}
                              className="text-[11px] text-[#94a3b8] dark:text-slate-400 leading-relaxed line-through decoration-red-400/60"
                            >
                              <span className="text-[#64748b] dark:text-slate-500 font-medium no-underline">
                                {LINE_FIELD_LABELS[f] || f}:
                              </span>{" "}
                              {formatChangeValue(v)}
                            </p>
                          ))}
                        </div>
                      </div>
                    );
                  }

                  // Update: per-field diffs within a line
                  const subDiffs = Object.entries(lineData as Record<string, any>).filter(
                    ([, v]) => v && typeof v === "object" && "old" in v && "new" in v,
                  );
                  if (subDiffs.length === 0) return null;
                  return (
                    <div key={lineKey} className="mt-1">
                      <p className="text-[11px] text-[#64748b] dark:text-slate-400 font-semibold">
                        {lineNum}:
                      </p>
                      <div className="ml-2 space-y-0.5">
                        {subDiffs.map(([f, diff]) => (
                          <p
                            key={f}
                            className="text-[11px] text-[#94a3b8] dark:text-slate-400 leading-relaxed"
                          >
                            <span className="text-[#64748b] dark:text-slate-500 font-medium">
                              {LINE_FIELD_LABELS[f] || f}:
                            </span>{" "}
                            <span className="line-through decoration-red-400/60">
                              {formatChangeValue(diff.old)}
                            </span>
                            <span className="mx-1">{"\u2192"}</span>
                            <span className="text-emerald-600 dark:text-emerald-400">
                              {formatChangeValue(diff.new)}
                            </span>
                          </p>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** Human-readable field name mapping for header fields */
const FIELD_LABELS: Record<string, string> = {
  memo: "Memo",
  transactionDate: "Date",
  transactionType: "Type",
  referenceNumber: "Reference #",
  totalAmount: "Amount",
  party: "Party",
  status: "Status",
};

/** Human-readable field name mapping for line fields */
const LINE_FIELD_LABELS: Record<string, string> = {
  description: "Description",
  debit: "Debit",
  credit: "Credit",
  category: "Category",
  party: "Party",
  department: "Department",
  location: "Location",
};

/** Format a change value for display */
function formatChangeValue(val: unknown): string {
  if (val === null || val === undefined || val === "") return "(empty)";
  if (typeof val === "number")
    return `$${Number(val).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
  return String(val);
}
