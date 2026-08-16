/**
 * useTransactionFilters — URL-synced filter state for the Transaction Ledger
 *
 * Extracts filter values from the URL search params and provides
 * toggle/set/clear handlers that navigate to update the URL.
 */
import { useNavigate } from "@tanstack/react-router";
import { useState, useCallback, useMemo } from "react";
import { useDebouncedValue } from "./useDebouncedValue";
import type { TransactionType, JournalStatus } from "../db/validation/journals";
import type { SidebarAccount } from "../components/ledger/AccountSidebar";
import { getAllDescendantIds } from "../components/ledger/AccountSidebar";
import type { FilterChip } from "../components/ledger/LedgerSearchBar";

// ── Types ──────────────────────────────────────────────────────────────────

export interface TransactionsSearch {
  accountId?: string;
  selected?: string;
  mode?: string;

  types?: string;
  statuses?: string;
  sources?: string;
  matched?: string;
  partyIds?: string;
  departmentIds?: string;
  locationIds?: string;
  amountMin?: string;
  amountMax?: string;
  dateFrom?: string;
  dateTo?: string;
}

// ── Period helpers ──────────────────────────────────────────────────────────

function fmtLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function getDefaultPeriod(): { from: string; to: string } {
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth() - 11, 1);
  const to = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  return { from: fmtLocal(from), to: fmtLocal(to) };
}

// ── Hook ───────────────────────────────────────────────────────────────────

export function useTransactionFilters(search: TransactionsSearch) {
  const navigate = useNavigate();

  // ── URL-derived filter values ──────────────────────────────────────────
  const selectedAccountId = search.accountId ?? null;
  const selected = search.selected;
  const pageMode = (search.mode ?? "view") as "view" | "edit";

  const typeFilter = useMemo(
    () => (search.types ? (search.types.split(",") as TransactionType[]) : []),
    [search.types],
  );
  const statusFilter = useMemo(
    () => (search.statuses ? (search.statuses.split(",") as JournalStatus[]) : []),
    [search.statuses],
  );
  const sourceFilter = useMemo(
    () =>
      search.sources
        ? (search.sources.split(",") as Array<
            "manual" | "import" | "invoice" | "bill" | "reconciliation" | "system"
          >)
        : [],
    [search.sources],
  );
  const matchedFilter = useMemo(
    () => (search.matched ? (search.matched.split(",") as Array<"matched" | "unmatched">) : []),
    [search.matched],
  );
  const partyFilter = useMemo(
    () => (search.partyIds ? search.partyIds.split(",") : []),
    [search.partyIds],
  );
  const departmentFilter = useMemo(
    () => (search.departmentIds ? search.departmentIds.split(",") : []),
    [search.departmentIds],
  );
  const locationFilter = useMemo(
    () => (search.locationIds ? search.locationIds.split(",") : []),
    [search.locationIds],
  );

  const defaultPeriod = useMemo(() => getDefaultPeriod(), []);
  const dateFrom = search.dateFrom ?? defaultPeriod.from;
  const dateTo = search.dateTo ?? defaultPeriod.to;

  // ── Local search / filter state ────────────────────────────────────────
  const [searchQuery, setSearchQuery] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [checkedAccountIds, setCheckedAccountIds] = useState<Set<string>>(new Set());
  const [amountMin, setAmountMin] = useState(search.amountMin ?? "");
  const [amountMax, setAmountMax] = useState(search.amountMax ?? "");
  const [partySearch, setPartySearch] = useState("");
  const [departmentSearch, setDepartmentSearch] = useState("");
  const [locationSearch, setLocationSearch] = useState("");

  const debouncedPartySearch = useDebouncedValue(partySearch, 200);
  const debouncedDepartmentSearch = useDebouncedValue(departmentSearch, 200);
  const debouncedLocationSearch = useDebouncedValue(locationSearch, 200);
  const debouncedSearchQuery = useDebouncedValue(searchQuery, 200);

  // ── Navigation helpers ─────────────────────────────────────────────────

  const handleSelectAccount = useCallback(
    (accountId: string | null) => {
      navigate({
        to: "/transactions",
        search: { ...search, accountId: accountId ?? undefined, selected: undefined, mode: "view" },
      });
    },
    [navigate, search],
  );

  const handleSelect = useCallback(
    (id: string) => {
      navigate({
        to: "/transactions/$transactionId" as string & {},
        params: { transactionId: id },
      });
    },
    [navigate],
  );

  const handleNewTransaction = useCallback(() => {
    navigate({ to: "/transactions/new" as string & {} });
  }, [navigate]);

  const handleDateChange = useCallback(
    (from: string, to: string) => {
      navigate({ to: "/transactions", search: { ...search, dateFrom: from, dateTo: to } });
    },
    [navigate, search],
  );

  const handleModeChange = useCallback(
    (mode: "view" | "edit") => {
      navigate({ to: "/transactions", search: { ...search, mode } });
    },
    [navigate, search],
  );

  // ── Filter toggles ────────────────────────────────────────────────────

  const toggleTypeFilter = useCallback(
    (type: TransactionType) => {
      const next = typeFilter.includes(type)
        ? typeFilter.filter((t) => t !== type)
        : [...typeFilter, type];
      navigate({
        to: "/transactions",
        search: { ...search, types: next.length > 0 ? next.join(",") : undefined },
      });
    },
    [typeFilter, navigate, search],
  );

  const toggleStatusFilter = useCallback(
    (status: JournalStatus) => {
      const next = statusFilter.includes(status)
        ? statusFilter.filter((s) => s !== status)
        : [...statusFilter, status];
      navigate({
        to: "/transactions",
        search: { ...search, statuses: next.length > 0 ? next.join(",") : undefined },
      });
    },
    [statusFilter, navigate, search],
  );

  const toggleSourceFilter = useCallback(
    (source: "manual" | "import" | "invoice" | "bill" | "reconciliation" | "system") => {
      const next = sourceFilter.includes(source)
        ? sourceFilter.filter((s) => s !== source)
        : [...sourceFilter, source];
      navigate({
        to: "/transactions",
        search: { ...search, sources: next.length > 0 ? next.join(",") : undefined },
      });
    },
    [sourceFilter, navigate, search],
  );

  const toggleMatchedFilter = useCallback(
    (status: "matched" | "unmatched") => {
      const next = matchedFilter.includes(status)
        ? matchedFilter.filter((s) => s !== status)
        : [...matchedFilter, status];
      navigate({
        to: "/transactions",
        search: { ...search, matched: next.length > 0 ? next.join(",") : undefined },
      });
    },
    [matchedFilter, navigate, search],
  );

  const togglePartyFilter = useCallback(
    (id: string) => {
      const next = partyFilter.includes(id)
        ? partyFilter.filter((p) => p !== id)
        : [...partyFilter, id];
      navigate({
        to: "/transactions",
        search: { ...search, partyIds: next.length > 0 ? next.join(",") : undefined },
      });
    },
    [partyFilter, navigate, search],
  );

  const toggleDepartmentFilter = useCallback(
    (id: string) => {
      const next = departmentFilter.includes(id)
        ? departmentFilter.filter((d) => d !== id)
        : [...departmentFilter, id];
      navigate({
        to: "/transactions",
        search: { ...search, departmentIds: next.length > 0 ? next.join(",") : undefined },
      });
    },
    [departmentFilter, navigate, search],
  );

  const toggleLocationFilter = useCallback(
    (id: string) => {
      const next = locationFilter.includes(id)
        ? locationFilter.filter((l) => l !== id)
        : [...locationFilter, id];
      navigate({
        to: "/transactions",
        search: { ...search, locationIds: next.length > 0 ? next.join(",") : undefined },
      });
    },
    [locationFilter, navigate, search],
  );

  const handleAmountChange = useCallback(
    (min: string, max: string) => {
      setAmountMin(min);
      setAmountMax(max);
      navigate({
        to: "/transactions",
        search: { ...search, amountMin: min || undefined, amountMax: max || undefined },
      });
    },
    [navigate, search],
  );

  const clearAllFilters = useCallback(() => {
    navigate({
      to: "/transactions",
      search: {
        ...search,
        types: undefined,
        statuses: undefined,
        sources: undefined,
        matched: undefined,
        partyIds: undefined,
        departmentIds: undefined,
        locationIds: undefined,
        amountMin: undefined,
        amountMax: undefined,
      },
    });
    setCheckedAccountIds(new Set());
    setAmountMin("");
    setAmountMax("");
    setPartySearch("");
    setDepartmentSearch("");
    setLocationSearch("");
    setFiltersOpen(false);
  }, [navigate, search]);

  // ── Category checkbox toggle with parent cascade ──────────────────────

  const handleToggleAccount = useCallback((_accountId: string, account: SidebarAccount) => {
    setCheckedAccountIds((prev) => {
      const next = new Set(prev);
      const allIds = getAllDescendantIds(account);
      const allChecked = allIds.every((id) => next.has(id));
      for (const id of allIds) {
        if (allChecked) {
          next.delete(id);
        } else {
          next.add(id);
        }
      }
      return next;
    });
  }, []);

  const removeCheckedAccount = useCallback((accountId: string) => {
    setCheckedAccountIds((prev) => {
      const next = new Set(prev);
      next.delete(accountId);
      return next;
    });
  }, []);

  // ── hasActiveFilters ──────────────────────────────────────────────────

  const hasActiveFilters =
    typeFilter.length > 0 ||
    statusFilter.length > 0 ||
    sourceFilter.length > 0 ||
    matchedFilter.length > 0 ||
    partyFilter.length > 0 ||
    departmentFilter.length > 0 ||
    locationFilter.length > 0 ||
    amountMin !== "" ||
    amountMax !== "" ||
    checkedAccountIds.size > 0;

  // ── Build filter chips ────────────────────────────────────────────────

  const buildFilterChips = useCallback(
    (
      accountTree: SidebarAccount[],
      partyOptions: Array<{ id: string; name: string }>,
      departmentOptions: Array<{ id: string; name: string }>,
      locationOptions: Array<{ id: string; name: string }>,
    ): FilterChip[] => {
      const chips: FilterChip[] = [];

      const findAccountName = (accs: SidebarAccount[], id: string): string | null => {
        for (const acc of accs) {
          if (acc.id === id) return acc.name;
          if (acc.children) {
            const found = findAccountName(acc.children, id);
            if (found) return found;
          }
        }
        return null;
      };

      for (const accId of checkedAccountIds) {
        const name = findAccountName(accountTree, accId);
        if (name) chips.push({ id: `cat-${accId}`, label: name, group: "category" });
      }

      const typeLabels: Record<string, string> = {
        pay_in: "Pay In",
        pay_out: "Pay Out",
        journal: "Journal",
        transfer: "Transfer",
      };
      for (const t of typeFilter)
        chips.push({ id: `type-${t}`, label: typeLabels[t] ?? t, group: "type" });
      for (const s of statusFilter)
        chips.push({
          id: `status-${s}`,
          label: s.charAt(0).toUpperCase() + s.slice(1),
          group: "status",
        });
      for (const s of sourceFilter)
        chips.push({
          id: `source-${s}`,
          label: s.charAt(0).toUpperCase() + s.slice(1),
          group: "source",
        });
      for (const m of matchedFilter)
        chips.push({
          id: `matched-${m}`,
          label: m.charAt(0).toUpperCase() + m.slice(1),
          group: "matched",
        });

      if (amountMin || amountMax) {
        const label =
          amountMin && amountMax
            ? `$${amountMin} – $${amountMax}`
            : amountMin
              ? `≥ $${amountMin}`
              : `≤ $${amountMax}`;
        chips.push({ id: "amount-range", label, group: "amount" });
      }

      for (const pId of partyFilter) {
        const party = partyOptions.find((p) => p.id === pId);
        chips.push({ id: `party-${pId}`, label: party?.name ?? pId.slice(0, 8), group: "party" });
      }
      for (const dId of departmentFilter) {
        const dept = departmentOptions.find((d) => d.id === dId);
        chips.push({
          id: `dept-${dId}`,
          label: dept?.name ?? dId.slice(0, 8),
          group: "department",
        });
      }
      for (const lId of locationFilter) {
        const loc = locationOptions.find((l) => l.id === lId);
        chips.push({ id: `loc-${lId}`, label: loc?.name ?? lId.slice(0, 8), group: "location" });
      }

      return chips;
    },
    [
      checkedAccountIds,
      typeFilter,
      statusFilter,
      sourceFilter,
      matchedFilter,
      partyFilter,
      departmentFilter,
      locationFilter,
      amountMin,
      amountMax,
    ],
  );

  // ── Remove chip handler ───────────────────────────────────────────────

  const handleRemoveChip = useCallback(
    (chipId: string) => {
      if (chipId.startsWith("cat-")) removeCheckedAccount(chipId.slice(4));
      else if (chipId.startsWith("type-")) toggleTypeFilter(chipId.slice(5) as TransactionType);
      else if (chipId.startsWith("status-")) toggleStatusFilter(chipId.slice(7) as JournalStatus);
      else if (chipId.startsWith("source-"))
        toggleSourceFilter(
          chipId.slice(7) as "manual" | "import" | "invoice" | "bill" | "reconciliation" | "system",
        );
      else if (chipId.startsWith("matched-"))
        toggleMatchedFilter(chipId.slice(8) as "matched" | "unmatched");
      else if (chipId.startsWith("party-")) togglePartyFilter(chipId.slice(6));
      else if (chipId.startsWith("dept-")) toggleDepartmentFilter(chipId.slice(5));
      else if (chipId.startsWith("loc-")) toggleLocationFilter(chipId.slice(4));
      else if (chipId === "amount-range") handleAmountChange("", "");
    },
    [
      removeCheckedAccount,
      toggleTypeFilter,
      toggleStatusFilter,
      toggleSourceFilter,
      toggleMatchedFilter,
      togglePartyFilter,
      toggleDepartmentFilter,
      toggleLocationFilter,
      handleAmountChange,
    ],
  );

  // ── Filtered search for party/department/location picker panels ────────

  const filterPartyOptions = useCallback(
    (list: Array<{ id: string; name: string; partyType: string }>) => {
      if (!debouncedPartySearch) return list;
      const q = debouncedPartySearch.toLowerCase();
      return list.filter((p) => p.name.toLowerCase().includes(q));
    },
    [debouncedPartySearch],
  );

  const filterDepartmentOptions = useCallback(
    (list: Array<{ id: string; name: string }>) => {
      if (!debouncedDepartmentSearch) return list;
      const q = debouncedDepartmentSearch.toLowerCase();
      return list.filter((d) => d.name.toLowerCase().includes(q));
    },
    [debouncedDepartmentSearch],
  );

  const filterLocationOptions = useCallback(
    (list: Array<{ id: string; name: string }>) => {
      if (!debouncedLocationSearch) return list;
      const q = debouncedLocationSearch.toLowerCase();
      return list.filter((l) => l.name.toLowerCase().includes(q));
    },
    [debouncedLocationSearch],
  );

  return {
    // URL-derived state
    selectedAccountId,
    selected,
    pageMode,
    dateFrom,
    dateTo,

    // Filter values
    typeFilter,
    statusFilter,
    sourceFilter,
    matchedFilter,
    partyFilter,
    departmentFilter,
    locationFilter,

    // Local state
    searchQuery,
    setSearchQuery,
    debouncedSearchQuery,
    filtersOpen,
    setFiltersOpen,
    checkedAccountIds,
    amountMin,
    amountMax,
    partySearch,
    setPartySearch,
    departmentSearch,
    setDepartmentSearch,
    locationSearch,
    setLocationSearch,

    // Navigation
    handleSelectAccount,
    handleSelect,
    handleNewTransaction,
    handleDateChange,
    handleModeChange,

    // Filter toggles
    toggleTypeFilter,
    toggleStatusFilter,
    toggleSourceFilter,
    toggleMatchedFilter,
    togglePartyFilter,
    toggleDepartmentFilter,
    toggleLocationFilter,
    handleAmountChange,
    clearAllFilters,

    // Category checkbox
    handleToggleAccount,
    removeCheckedAccount,

    // Derived
    hasActiveFilters,
    buildFilterChips,
    handleRemoveChip,
    filterPartyOptions,
    filterDepartmentOptions,
    filterLocationOptions,
  };
}
