/**
 * useTransactionQueries — TanStack Query hooks for the Transaction Ledger
 *
 * Houses all data-fetching queries (transactions, grouped, balances, accounts, etc.)
 * and derived computations (running balance, grouped merge, sidebar balance map).
 */
import { useQuery } from "@tanstack/react-query";
import { useState, useCallback, useMemo, useEffect } from "react";
import type { TransactionType, JournalStatus } from "../db/validation/journals";
import type { LedgerRowData } from "../components/ledger/LedgerRow";
import type { AccountGroup } from "../components/ledger/AccountGroupedList";
import type { AccountBalance } from "../components/ledger/BalancesView";
import {
  listTransactions,
  listAccountBalances,
  listTransactionsGrouped,
  loadMoreTransactions,
  getClosedThroughServerFn,
} from "../routes/api/-transactions";
import { listAccounts, type AccountWithChildren } from "../routes/api/-accounts";
import { callServerFn } from "../lib/server-fn-client";
import { keys } from "../lib/query-keys";

// ── Hook ───────────────────────────────────────────────────────────────────

export interface TransactionQueryParams {
  selectedAccountId: string | null;
  typeFilter: TransactionType[];
  statusFilter: JournalStatus[];
  partyFilter: string[];
  departmentFilter: string[];
  locationFilter: string[];
  dateFrom: string;
  dateTo: string;
  debouncedSearchQuery: string;
  checkedAccountIds: Set<string>;
}

export function useTransactionQueries(params: TransactionQueryParams) {
  const {
    selectedAccountId,
    typeFilter,
    statusFilter,
    partyFilter,
    departmentFilter,
    locationFilter,
    dateFrom,
    dateTo,
    debouncedSearchQuery,
    checkedAccountIds,
  } = params;

  // ── Accounts ──────────────────────────────────────────────────────────

  const { data: accountTree = [] } = useQuery({
    queryKey: keys.accounts.tree(),
    queryFn: () =>
      callServerFn(listAccounts, {
        data: { includeChildren: true, status: ["active"], types: [], subtypes: [] },
      }),
    structuralSharing: false,
  });

  const { data: flatAccounts = [] } = useQuery({
    queryKey: keys.accounts.flat(),
    queryFn: () =>
      callServerFn(listAccounts, {
        data: { includeChildren: false, status: ["active"], types: [], subtypes: [] },
      }),
  });

  // ── Transactions (filtered) ───────────────────────────────────────────

  const { data: transactions = [], isLoading } = useQuery({
    queryKey: keys.transactions.list({
      selectedAccountId,
      typeFilter,
      statusFilter,
      partyFilter,
      departmentFilter,
      locationFilter,
      dateFrom,
      dateTo,
      debouncedSearchQuery,
    }),
    queryFn: async () => {
      const res = await callServerFn(listTransactions, {
        data: {
          accountId: selectedAccountId ?? undefined,
          types: typeFilter,
          statuses: statusFilter,
          partyIds: partyFilter.length > 0 ? partyFilter : undefined,
          departmentIds: departmentFilter.length > 0 ? departmentFilter : undefined,
          locationIds: locationFilter.length > 0 ? locationFilter : undefined,
          dateFrom,
          dateTo,
          search: debouncedSearchQuery || undefined,
        },
      });
      if (res === undefined)
        throw new Error("RPC yielded undefined (Vite HMR Optimization Reload)");
      return res;
    },
    retry: true,
  });

  // ── Account Balances ──────────────────────────────────────────────────

  const { data: accountBalances = [] } = useQuery({
    queryKey: keys.accounts.balances({ dateFrom, dateTo, statusFilter }),
    queryFn: async () => {
      const res = await callServerFn(listAccountBalances, {
        data: { dateFrom, dateTo, statuses: statusFilter },
      });
      if (res === undefined)
        throw new Error("RPC yielded undefined (Vite HMR Optimization Reload)");
      return res;
    },
    retry: true,
  });

  // ── Grouped Transactions ──────────────────────────────────────────────

  const {
    data: rawGroupedData = [],
    isLoading: isGroupedLoading,
    error: groupedError,
  } = useQuery({
    queryKey: keys.transactions.grouped({
      typeFilter,
      statusFilter,
      partyFilter,
      departmentFilter,
      locationFilter,
      dateFrom,
      dateTo,
      debouncedSearchQuery,
    }),
    queryFn: async () => {
      const res = await callServerFn(listTransactionsGrouped, {
        data: {
          types: typeFilter,
          statuses: statusFilter,
          partyIds: partyFilter.length > 0 ? partyFilter : undefined,
          departmentIds: departmentFilter.length > 0 ? departmentFilter : undefined,
          locationIds: locationFilter.length > 0 ? locationFilter : undefined,
          dateFrom,
          dateTo,
          search: debouncedSearchQuery || undefined,
          perAccountLimit: 20,
        },
      });
      if (res === undefined)
        throw new Error("RPC yielded undefined (Vite HMR Optimization Reload)");
      return res;
    },
    retry: true,
    enabled: !selectedAccountId,
  });

  // ── Load More (extra transactions per account) ────────────────────────

  const [extraTransactions, setExtraTransactions] = useState<Record<string, LedgerRowData[]>>({});
  const [loadingAccountIds, setLoadingAccountIds] = useState<Set<string>>(new Set());

  const groupedData = useMemo((): AccountGroup[] => {
    return rawGroupedData.map((g) => {
      const extra = extraTransactions[g.accountId];
      if (!extra || extra.length === 0) return g;
      const allTransactions = [...g.transactions, ...extra];
      return {
        ...g,
        transactions: allTransactions,
        hasMore: g.transactionCount > allTransactions.length,
      };
    });
  }, [rawGroupedData, extraTransactions]);

  const filteredGroupedData = useMemo((): AccountGroup[] => {
    if (checkedAccountIds.size === 0) return groupedData;
    return groupedData.filter((g) => checkedAccountIds.has(g.accountId));
  }, [groupedData, checkedAccountIds]);

  // Reset extras when filters change
  useEffect(() => {
    setExtraTransactions({});
  }, [typeFilter, statusFilter, partyFilter, departmentFilter, locationFilter, dateFrom, dateTo]);

  const handleLoadMore = useCallback(
    async (accountId: string) => {
      const group = groupedData.find((g) => g.accountId === accountId);
      if (!group) return;

      setLoadingAccountIds((prev) => new Set([...prev, accountId]));
      try {
        const result = await callServerFn(loadMoreTransactions, {
          data: {
            accountId,
            types: typeFilter,
            statuses: statusFilter,
            partyIds: partyFilter.length > 0 ? partyFilter : undefined,
            departmentIds: departmentFilter.length > 0 ? departmentFilter : undefined,
            locationIds: locationFilter.length > 0 ? locationFilter : undefined,
            dateFrom,
            dateTo,
            search: debouncedSearchQuery || undefined,
            limit: 20,
            offset: group.transactions.length,
          },
        });

        setExtraTransactions((prev) => ({
          ...prev,
          [accountId]: [...(prev[accountId] ?? []), ...result.transactions],
        }));
      } finally {
        setLoadingAccountIds((prev) => {
          const next = new Set(prev);
          next.delete(accountId);
          return next;
        });
      }
    },
    [
      groupedData,
      typeFilter,
      statusFilter,
      partyFilter,
      departmentFilter,
      locationFilter,
      dateFrom,
      dateTo,
    ],
  );

  // ── Running Balance ───────────────────────────────────────────────────

  const selectedAccountInfo = useMemo(() => {
    if (!selectedAccountId) return null;
    const findAccount = (accs: AccountWithChildren[]): AccountWithChildren | null => {
      for (const acc of accs) {
        if (acc.id === selectedAccountId) return acc;
        if (acc.children) {
          const found = findAccount(acc.children);
          if (found) return found;
        }
      }
      return null;
    };
    return findAccount(accountTree);
  }, [selectedAccountId, accountTree]);

  const transactionsWithBalance = useMemo(() => {
    if (!selectedAccountId) return transactions;
    const toSortableTime = (value: string | Date | null | undefined): number => {
      if (!value) return 0;
      if (value instanceof Date) return value.getTime();
      const parsed = Date.parse(value);
      return Number.isNaN(parsed) ? 0 : parsed;
    };

    const sorted = [...transactions].sort(
      (a, b) =>
        a.transactionDate.localeCompare(b.transactionDate) ||
        toSortableTime(a.createdAt) - toSortableTime(b.createdAt),
    );
    const accountType = selectedAccountInfo?.accountType ?? "asset";
    const isLER = ["liability", "equity", "revenue", "other_income"].includes(accountType);
    let runningBalance = 0;
    const withBalance = sorted.map((txn) => {
      const debit = Number.parseFloat(txn.accountDebit ?? "0");
      const credit = Number.parseFloat(txn.accountCredit ?? "0");
      runningBalance += isLER ? credit - debit : debit - credit;
      return { ...txn, runningBalance: runningBalance.toFixed(2) };
    });
    withBalance.reverse();
    return withBalance;
  }, [transactions, selectedAccountId, selectedAccountInfo]);

  // ── Sidebar Balance Map ───────────────────────────────────────────────

  const sidebarBalanceMap = useMemo(() => {
    const map: Record<string, { balance: string; count: number }> = {};
    for (const b of accountBalances as AccountBalance[]) {
      map[b.accountId] = { balance: b.balance, count: b.transactionCount };
    }
    return map;
  }, [accountBalances]);

  const selectedAccountBalance = sidebarBalanceMap[selectedAccountId ?? ""];

  // ── Closed Through ────────────────────────────────────────────────────

  const { data: closedThroughData } = useQuery({
    queryKey: ["closedThrough"],
    queryFn: () => callServerFn(getClosedThroughServerFn, { data: {} }),
  });
  const closedDate = closedThroughData?.closedThrough ?? null;

  return {
    // Raw data
    accountTree,
    flatAccounts,
    transactions,
    isLoading,
    accountBalances,
    groupedData,
    filteredGroupedData,
    isGroupedLoading,
    groupedError,

    // Load more
    handleLoadMore,
    loadingAccountIds,

    // Computed
    selectedAccountInfo,
    transactionsWithBalance,
    sidebarBalanceMap,
    selectedAccountBalance,

    // Period close
    closedDate,
  };
}
