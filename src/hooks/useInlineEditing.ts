/**
 * useInlineEditing — Inline edit state, apply logic, and combobox options
 * for the Transaction Ledger's edit mode.
 */
import { useState, useCallback, useMemo, useEffect } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "../components/ui/Toast";
import type { InlineEdits } from "../components/ledger/LedgerRow";
import { updateTransactionsBatch } from "../routes/api/-transactions";

type ServerFnCaller = (opts: { data: unknown }) => Promise<any>;

export interface InlineEditingParams {
  pageMode: "view" | "edit";
  allParties: unknown[];
  flatAccounts: unknown[];
  allDepartments: unknown[];
  allLocations: unknown[];
}

export function useInlineEditing({
  pageMode,
  allParties,
  flatAccounts,
  allDepartments,
  allLocations,
}: InlineEditingParams) {
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  // ── Pending edits state ───────────────────────────────────────────────

  const [pendingEdits, setPendingEdits] = useState<Map<string, InlineEdits>>(new Map());

  // Reset when leaving edit mode
  useEffect(() => {
    if (pageMode !== "edit") {
      setPendingEdits(new Map());
    }
  }, [pageMode]);

  // ── Mutation ──────────────────────────────────────────────────────────

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

  // ── Handlers ──────────────────────────────────────────────────────────

  const handleInlineFieldChange = useCallback(
    (txnId: string, field: keyof InlineEdits, value: string, lineAccountId?: string | null) => {
      const key = lineAccountId ? `${txnId}:${lineAccountId}` : txnId;
      setPendingEdits((prev) => {
        const next = new Map(prev);
        const existing = next.get(key) ?? {};
        next.set(key, { ...existing, [field]: value });
        return next;
      });
    },
    [],
  );

  const handleInlineCancel = useCallback(() => {
    setPendingEdits(new Map());
  }, []);

  const handleInlineApply = useCallback(async () => {
    if (pendingEdits.size === 0) return;
    const entries = Array.from(pendingEdits.entries());
    try {
      for (const [compositeKey, edits] of entries) {
        const sepIdx = compositeKey.indexOf(":");
        const txnId = sepIdx >= 0 ? compositeKey.slice(0, sepIdx) : compositeKey;
        const { lineAccountId, transactionType, ...fieldUpdates } = edits;
        await updateBatchMutation.mutateAsync({
          ids: [txnId],
          updates: fieldUpdates,
          lineAccountId,
          transactionType,
        });
      }

      // Build lookup maps for optimistic name resolution
      const partyLookup = new Map(
        (allParties as Array<{ id: string; name: string }>).map((p) => [p.id, p.name]),
      );
      const categoryLookup = new Map(
        (flatAccounts as Array<{ id: string; name: string }>).map((c) => [c.id, c.name]),
      );
      const deptLookup = new Map(
        (allDepartments as Array<{ id: string; name: string }>).map((d) => [d.id, d.name]),
      );
      const locLookup = new Map(
        (allLocations as Array<{ id: string; name: string }>).map((l) => [l.id, l.name]),
      );

      // Inline optimistic UI updater
      const applyEdits = (txn: any): any => {
        const compositeKey = txn.categoryAccountId ? `${txn.id}:${txn.categoryAccountId}` : txn.id;
        const edits = pendingEdits.get(compositeKey) ?? pendingEdits.get(txn.id);
        if (!edits) return txn;
        const updated = { ...txn };
        if (edits.partyId !== undefined) {
          updated.partyId = edits.partyId;
          updated.partyName = partyLookup.get(edits.partyId) ?? txn.partyName;
        }
        if (edits.accountId !== undefined) {
          updated.categoryAccountId = edits.accountId;
          updated.categoryName = categoryLookup.get(edits.accountId) ?? txn.categoryName;
        }
        if (edits.departmentId !== undefined) {
          updated.departmentId = edits.departmentId;
          updated.departmentName = deptLookup.get(edits.departmentId) ?? txn.departmentName;
        }
        if (edits.locationId !== undefined) {
          updated.locationId = edits.locationId;
          updated.locationName = locLookup.get(edits.locationId) ?? txn.locationName;
        }
        return updated;
      };

      queryClient.setQueriesData<any[]>({ queryKey: ["transactions"] }, (old) => {
        if (!old) return old;
        return old.map(applyEdits);
      });

      queryClient.setQueriesData<any[]>({ queryKey: ["transactionsGrouped"] }, (old) => {
        if (!old) return old;
        return old.map((group: any) => ({
          ...group,
          transactions: (group.transactions ?? []).map(applyEdits),
        }));
      });

      setPendingEdits(new Map());

      // Delayed refetch for eventual consistency
      const editedIds = entries.map(([txnId]) => txnId);
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ["transactions"] });
        queryClient.invalidateQueries({ queryKey: ["transactionsGrouped"] });
        queryClient.invalidateQueries({ queryKey: ["accountBalances"] });
        for (const txnId of editedIds) {
          queryClient.invalidateQueries({ queryKey: ["transaction", txnId] });
          queryClient.invalidateQueries({ queryKey: ["activity-logs", "transaction", txnId] });
        }
      }, 1500);
    } catch {
      // onError already shows a toast — keep pending edits so user can retry
    }
  }, [
    pendingEdits,
    updateBatchMutation,
    queryClient,
    allParties,
    flatAccounts,
    allDepartments,
    allLocations,
  ]);

  // ── Combobox options ──────────────────────────────────────────────────

  const partyOptions = useMemo(
    () =>
      (allParties as Array<{ id: string; name: string }>).map((p) => ({
        value: p.id,
        label: p.name,
      })),
    [allParties],
  );

  const categoryOptions = useMemo(
    () =>
      (flatAccounts as Array<{ id: string; name: string; accountNumber?: string }>).map((c) => ({
        value: c.id,
        label: c.accountNumber ? `${c.accountNumber} - ${c.name}` : c.name,
      })),
    [flatAccounts],
  );

  const departmentOptions = useMemo(
    () =>
      (allDepartments as Array<{ id: string; name: string }>).map((d) => ({
        value: d.id,
        label: d.name,
      })),
    [allDepartments],
  );

  const locationOptions = useMemo(
    () =>
      (allLocations as Array<{ id: string; name: string }>).map((l) => ({
        value: l.id,
        label: l.name,
      })),
    [allLocations],
  );

  return {
    pendingEdits,
    updateBatchMutation,
    handleInlineFieldChange,
    handleInlineCancel,
    handleInlineApply,
    partyOptions,
    categoryOptions,
    departmentOptions,
    locationOptions,
  };
}
