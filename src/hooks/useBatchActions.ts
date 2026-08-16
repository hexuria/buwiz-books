/**
 * useBatchActions — Selection state, batch mutations, match/delete logic
 * for the Transaction Ledger's edit mode.
 */
import { useState, useCallback, useMemo, useEffect } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "../components/ui/Toast";
import type { LedgerRowData } from "../components/ledger/LedgerRow";
import type { AccountGroup } from "../components/ledger/AccountGroupedList";
import { updateTransactionsBatch, deleteTransactionsBatch } from "../routes/api/-transactions";
import { matchTransactions, previewTransactionMerge } from "../routes/api/-match-transactions";
import { usePermission } from "../lib/use-permission";

type ServerFnCaller = (opts: { data: unknown }) => Promise<any>;

export interface BatchActionsParams {
  pageMode: "view" | "edit";
  transactions: unknown[];
  groupedData: AccountGroup[];
}

export function useBatchActions({ pageMode, transactions, groupedData }: BatchActionsParams) {
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const { canAccess: canMatchJournals } = usePermission("journal", "match");

  // ── Selection state ───────────────────────────────────────────────────

  const [selectedTransactionIds, setSelectedTransactionIds] = useState<Set<string>>(new Set());
  const [matchModalIds, setMatchModalIds] = useState<[string, string] | null>(null);
  const [matchIdempotencyKey, setMatchIdempotencyKey] = useState(() => crypto.randomUUID());
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);

  // Reset on mode change
  useEffect(() => {
    if (pageMode !== "edit") {
      setSelectedTransactionIds(new Set());
    }
  }, [pageMode]);

  const handleSelectTransaction = useCallback((id: string) => {
    setSelectedTransactionIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleClearSelection = useCallback(() => {
    setSelectedTransactionIds(new Set());
  }, []);

  // ── Batch Mutations ───────────────────────────────────────────────────

  const updateBatchMutation = useMutation({
    mutationFn: (data: {
      ids: string[];
      updates: any;
      lineAccountId?: string;
      transactionType?: string;
    }) => (updateTransactionsBatch as ServerFnCaller)({ data }),
    onError: (err: any) => {
      showToast?.(err.message || "Failed to update transactions", { icon: "error" });
    },
  });

  const deleteBatchMutation = useMutation({
    mutationFn: (data: { ids: string[] }) => (deleteTransactionsBatch as ServerFnCaller)({ data }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["transactions"] });
      queryClient.invalidateQueries({ queryKey: ["accountBalances"] });
      handleClearSelection();
    },
  });

  const matchMutation = useMutation({
    mutationFn: (data: {
      canonicalTransactionId: string;
      duplicateTransactionId: string;
      reason: string;
      idempotencyKey: string;
    }) => (matchTransactions as ServerFnCaller)({ data }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["transactions"] });
      queryClient.invalidateQueries({ queryKey: ["accountBalances"] });
      handleClearSelection();
      setMatchModalIds(null);
      showToast?.("Duplicate merged without deleting either journal.", {
        icon: "success",
      });
    },
    onError: (err: any) => {
      showToast?.(err.message || "Match failed", { icon: "error" });
    },
  });

  const previewMatchMutation = useMutation({
    mutationFn: (data: { canonicalTransactionId: string; duplicateTransactionId: string }) =>
      (previewTransactionMerge as ServerFnCaller)({ data }),
    onError: (err: any) => {
      showToast?.(err.message || "Merge preview failed", { icon: "error" });
    },
  });

  // ── Handlers ──────────────────────────────────────────────────────────

  const handleMatchRequest = useCallback((txIds: [string, string]) => {
    const ids = txIds.map((id) => (id.length > 36 ? id.substring(0, 36) : id)) as [string, string];
    setMatchIdempotencyKey(crypto.randomUUID());
    setMatchModalIds(ids);
  }, []);

  const handleMatchPreview = useCallback(
    async (canonicalTransactionId: string) => {
      if (!matchModalIds) throw new Error("Select two transactions first.");
      const duplicateTransactionId = matchModalIds.find((id) => id !== canonicalTransactionId);
      if (!duplicateTransactionId) throw new Error("Select a canonical transaction.");
      return previewMatchMutation.mutateAsync({
        canonicalTransactionId,
        duplicateTransactionId,
      });
    },
    [matchModalIds, previewMatchMutation],
  );

  const handleMatchConfirm = useCallback(
    (canonicalTransactionId: string, reason: string) => {
      if (!matchModalIds) return;
      const duplicateTransactionId = matchModalIds.find((id) => id !== canonicalTransactionId);
      if (!duplicateTransactionId) return;
      matchMutation.mutate({
        canonicalTransactionId,
        duplicateTransactionId,
        reason,
        idempotencyKey: matchIdempotencyKey,
      });
    },
    [matchIdempotencyKey, matchModalIds, matchMutation],
  );

  const handleBatchUpdate = useCallback(
    async (updates: any) => {
      const ids = Array.from(selectedTransactionIds).map((id) =>
        id.length > 36 ? id.substring(0, 36) : id,
      );
      const uniqueIds = Array.from(new Set(ids));
      try {
        await updateBatchMutation.mutateAsync({ ids: uniqueIds, updates });
        queryClient.invalidateQueries({ queryKey: ["transactions"] });
        queryClient.invalidateQueries({ queryKey: ["transactionsGrouped"] });
        queryClient.invalidateQueries({ queryKey: ["accountBalances"] });
        for (const txnId of uniqueIds) {
          queryClient.invalidateQueries({ queryKey: ["transaction", txnId] });
          queryClient.invalidateQueries({ queryKey: ["activity-logs", "transaction", txnId] });
        }
        handleClearSelection();
      } catch {
        // onError already shows a toast
      }
    },
    [selectedTransactionIds, updateBatchMutation, queryClient, handleClearSelection],
  );

  const handleBatchDelete = useCallback(() => {
    setDeleteConfirmOpen(true);
  }, []);

  const handleConfirmDelete = useCallback(() => {
    const ids = Array.from(selectedTransactionIds).map((id) =>
      id.length > 36 ? id.substring(0, 36) : id,
    );
    const uniqueIds = Array.from(new Set(ids));
    deleteBatchMutation.mutate({ ids: uniqueIds });
    setDeleteConfirmOpen(false);
  }, [selectedTransactionIds, deleteBatchMutation]);

  // ── Selected transaction objects ──────────────────────────────────────

  const selectedTransactionsList = useMemo(() => {
    if (selectedTransactionIds.size === 0) return [];

    const list: LedgerRowData[] = [];
    const processedids = new Set<string>();

    for (const compositeId of selectedTransactionIds) {
      let txnId = compositeId;
      let accountIdSuffix: string | null = null;
      if (compositeId.length > 36) {
        txnId = compositeId.substring(0, 36);
        accountIdSuffix = compositeId.substring(37);
      }

      if (processedids.has(compositeId)) continue;

      let found: LedgerRowData | undefined;

      if (groupedData.length > 0) {
        if (accountIdSuffix) {
          const targetGroup = groupedData.find((g) => g.accountId === accountIdSuffix);
          if (targetGroup) {
            found = targetGroup.transactions.find((t) => t.id === txnId) as
              | LedgerRowData
              | undefined;
          }
        }
        if (!found) {
          for (const g of groupedData) {
            const match = g.transactions.find((t) => t.id === txnId);
            if (match) {
              found = match as LedgerRowData;
              break;
            }
          }
        }
      }

      if (!found) {
        found = (transactions as LedgerRowData[]).find((t) => t.id === txnId);
      }

      if (found) {
        list.push(found);
        processedids.add(compositeId);
      }
    }
    return list;
  }, [selectedTransactionIds, transactions, groupedData]);

  return {
    // Selection
    selectedTransactionIds,
    handleSelectTransaction,
    handleClearSelection,
    selectedTransactionsList,

    // Mutations
    updateBatchMutation,
    deleteBatchMutation,
    matchMutation,
    previewMatchMutation,

    // Handlers
    handleBatchUpdate,
    handleBatchDelete,
    handleConfirmDelete,
    handleMatchRequest,
    handleMatchPreview,
    handleMatchConfirm,

    // Modal state
    matchModalIds,
    setMatchModalIds,
    canMatchJournals,
    deleteConfirmOpen,
    setDeleteConfirmOpen,
  };
}
