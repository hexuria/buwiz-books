/**
 * Category Manager Page
 * Chart of Accounts with hierarchical tree and detail panel
 */
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import {
  listAccounts,
  createAccount,
  updateAccount,
  getAccount,
  deleteAccount,
  listFinancialConnections,
  backfillAccountNumbers,
} from "./api/-accounts";
import { callServerFn } from "../lib/server-fn-client";
import { CategoryManagerLayout } from "../components/accounts/CategoryManagerLayout";
import { CategoryTree, type CategoryNode } from "../components/accounts/CategoryTree";
import { CategoryForm, type CategoryFormData } from "../components/accounts/CategoryForm";
import { CategoryDetail, CategoryDetailEmpty } from "../components/accounts/CategoryDetail";
import { DeleteCategoryModal } from "../components/accounts/DeleteCategoryModal";
import { ImportCategoriesModal } from "../components/accounts/ImportCategoriesModal";
import { PresetPickerModal } from "../components/accounts/PresetPickerModal";
import { AiCustomizeModal } from "../components/accounts/AiCustomizeModal";
import { type FilterState, emptyFilters } from "../components/accounts/FilterPanel";
import type { AccountType } from "../components/accounts/CategoryRow";

// ============================================================================
// Route Definition — filter state synced to URL search params
// ============================================================================

interface AccountsSearch {
  selected?: string;
  mode?: string;
  status?: string;
  types?: string;
  subtypes?: string;
  parentId?: string;
}

export const Route = createFileRoute("/accounts")({
  component: AccountsPage,
  validateSearch: (search: Record<string, unknown>): AccountsSearch => ({
    selected: typeof search.selected === "string" ? search.selected : undefined,
    mode: typeof search.mode === "string" ? search.mode : undefined,
    status: typeof search.status === "string" ? search.status : undefined,
    types: typeof search.types === "string" ? search.types : undefined,
    subtypes: typeof search.subtypes === "string" ? search.subtypes : undefined,
    parentId: typeof search.parentId === "string" ? search.parentId : undefined,
  }),
});

// ============================================================================
// Types
// ============================================================================

interface ApiAccount {
  id: string;
  name: string;
  accountNumber?: string | null;
  description?: string | null;
  accountType: string;
  subtype?: string | null;
  icon?: string | null;
  parentId?: string | null;
  isSystem?: boolean;
  isActive?: boolean;
  children?: ApiAccount[];
}

// ============================================================================
// URL <-> FilterState helpers
// ============================================================================

/** Parse filter state from URL search params (comma-separated strings) */
function parseFiltersFromSearch(search: AccountsSearch): FilterState {
  return {
    // "" means explicitly cleared (show all), absent means default ["active"]
    status:
      search.status === ""
        ? []
        : search.status
          ? search.status.split(",").filter(Boolean)
          : emptyFilters.status,
    types: search.types
      ? (search.types.split(",").filter(Boolean) as AccountType[])
      : emptyFilters.types,
    subtypes: search.subtypes ? search.subtypes.split(",").filter(Boolean) : emptyFilters.subtypes,
  };
}

/** Serialize filter state to URL search params (comma-separated, omit defaults) */
function filtersToSearch(filters: FilterState, current: AccountsSearch): AccountsSearch {
  const isDefaultStatus = filters.status.length === 1 && filters.status[0] === "active";

  return {
    selected: current.selected,
    mode: current.mode,
    // Default ["active"] → omit from URL; [] (show all) → also omit (clean URL)
    status: isDefaultStatus ? undefined : filters.status.join(",") || undefined,
    types: filters.types.length > 0 ? filters.types.join(",") : undefined,
    subtypes: filters.subtypes.length > 0 ? filters.subtypes.join(",") : undefined,
  };
}

// ============================================================================
// Skeleton Loader
// ============================================================================

function CategoryTreeSkeleton() {
  // Vary widths to simulate different category names / descriptions
  const rows = [
    { nameW: "w-32", numW: "w-12", descW: "w-48", hasDesc: true },
    { nameW: "w-24", numW: "w-10", descW: "w-36", hasDesc: true },
    { nameW: "w-28", numW: "w-14", descW: "w-40", hasDesc: false },
    { nameW: "w-36", numW: "w-10", descW: "w-52", hasDesc: true },
    { nameW: "w-20", numW: "w-12", descW: "w-32", hasDesc: true },
    { nameW: "w-30", numW: "w-10", descW: "w-44", hasDesc: false },
    { nameW: "w-26", numW: "w-14", descW: "w-38", hasDesc: true },
    { nameW: "w-34", numW: "w-12", descW: "w-28", hasDesc: true },
  ];

  return (
    <div className="p-0 bg-white dark:bg-slate-900">
      {/* Column Headers — spans mirror CategoryTree exactly, including dropping Connections below
          `sm`. A skeleton whose columns land elsewhere than the real rows reads as a layout jump. */}
      <div className="grid shrink-0 grid-cols-12 items-center border-b border-gray-200 px-3 py-2 text-xs font-medium tracking-wider text-[var(--color-app-text-light)] uppercase sm:px-4">
        <span className="col-span-9 sm:col-span-6">Category</span>
        <span className="hidden text-center sm:col-span-3 sm:block">Connections</span>
        <span className="col-span-3" />
      </div>

      {/* Skeleton Rows */}
      {rows.map((row) => (
        <div
          key={`skel-${row.nameW}-${row.descW}`}
          className="grid grid-cols-12 items-center py-3 px-4 border-b border-[#f0f1f3] dark:border-slate-700 animate-pulse"
          style={{ paddingLeft: "16px" }}
        >
          {/* Column 1: Category — 9/12 on mobile, 6/12 once Connections reappears at `sm` */}
          <div className="col-span-9 flex items-center gap-3 min-w-0 sm:col-span-6">
            {/* Icon placeholder */}
            <div className="w-9 h-9 rounded-lg bg-[#e2e8f0] dark:bg-white/10 shrink-0" />
            {/* Name + number + description. The fixed `w-*` bars would outrun a 375px column, so
                they cap at the available width rather than pushing the grid wide. */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <div
                  className={`h-3.5 ${row.nameW} max-w-full rounded bg-[#e2e8f0] dark:bg-white/10`}
                />
                <div
                  className={`h-3 ${row.numW} max-w-full shrink-0 rounded bg-[#e2e8f0] dark:bg-white/10`}
                />
              </div>
              {row.hasDesc && (
                <div
                  className={`h-2.5 ${row.descW} max-w-full rounded bg-[#e2e8f0] dark:bg-white/10 mt-1.5`}
                />
              )}
            </div>
          </div>

          {/* Column 2: Connections placeholder — hidden below `sm`, matching CategoryRow */}
          <div className="hidden justify-center sm:col-span-3 sm:flex">
            <div className="flex items-center">
              <div className="w-7 h-7 rounded-full bg-[#e2e8f0] dark:bg-white/10" />
              <div className="w-7 h-7 rounded-full bg-[#e2e8f0] dark:bg-white/10 -ml-1.5" />
            </div>
          </div>

          {/* Column 3: Action buttons placeholder (3 cols). Three 36px circles overflow a 3/12
              column at 375px and the card clips rather than scrolls, so the first two drop out. */}
          <div className="col-span-3 flex justify-end gap-1">
            <div className="hidden w-9 h-9 rounded-full bg-[#e2e8f0] dark:bg-white/10 sm:block" />
            <div className="hidden w-9 h-9 rounded-full bg-[#e2e8f0] dark:bg-white/10 sm:block" />
            <div className="w-9 h-9 rounded-full bg-[#e2e8f0] dark:bg-white/10" />
          </div>
        </div>
      ))}
    </div>
  );
}

// ============================================================================
// Page Component
// ============================================================================

function AccountsPage() {
  const navigate = useNavigate();
  const search = Route.useSearch();
  const selected = search.selected;
  const mode = search.mode; // "create" | "edit" | undefined
  const queryClient = useQueryClient();
  const [searchQuery, setSearchQuery] = useState("");
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [showPresetModal, setShowPresetModal] = useState(false);
  const [showAiModal, setShowAiModal] = useState(false);

  // Auto-backfill missing account numbers on first load
  const backfillRan = useRef(false);
  useEffect(() => {
    if (backfillRan.current) return;
    backfillRan.current = true;
    callServerFn(backfillAccountNumbers, { data: undefined })
      .then((result) => {
        if (result.fixed > 0) {
          queryClient.invalidateQueries({ queryKey: ["accounts"] });
        }
      })
      .catch(() => {
        // Silently ignore — user may not have permission, or no accounts to fix
      });
  }, [queryClient]);

  // Derive filter state from URL
  const filters = useMemo(() => parseFiltersFromSearch(search), [search]);

  // Update filters → navigate with new search params
  const setFilters = useCallback(
    (next: FilterState) => {
      navigate({ to: "/accounts", search: filtersToSearch(next, search) });
    },
    [navigate, search],
  );

  // Fetch accounts — pass status/types/subtypes to server
  const {
    data: accounts = [],
    isLoading,
    error,
  } = useQuery({
    queryKey: [
      "accounts",
      { status: filters.status, types: filters.types, subtypes: filters.subtypes },
    ],
    queryFn: async (): Promise<ApiAccount[]> =>
      await callServerFn(listAccounts, {
        data: {
          includeChildren: true,
          status: filters.status,
          types: filters.types,
          subtypes: filters.subtypes,
        },
      }),
  });

  // Separate query WITHOUT subtype filter — used only for computing available
  // subtypes so the subtype filter list doesn't collapse when one is picked.
  const { data: subtypeSourceAccounts = [] } = useQuery({
    queryKey: ["accounts-subtype-source", { status: filters.status, types: filters.types }],
    queryFn: async (): Promise<ApiAccount[]> =>
      await callServerFn(listAccounts, {
        data: {
          includeChildren: true,
          status: filters.status,
          types: filters.types,
          subtypes: [],
        },
      }),
  });

  // Fetch financial account connections (for connection badges)
  const { data: financialConnections = [] } = useQuery({
    queryKey: ["financial-connections"],
    // `data: undefined`, not `data: {}` — this fn takes no input, and a GET server fn only
    // appends a `?payload=` query string when data is defined.
    queryFn: () => callServerFn(listFinancialConnections, { data: undefined }),
  });

  // Build a lookup: ledgerAccountId -> connections[]
  const connectionsMap = useMemo(() => {
    const map = new Map<string, Array<{ name: string; logoUrl?: string }>>();
    for (const fc of financialConnections) {
      if (!fc.ledgerAccountId) continue;
      const list = map.get(fc.ledgerAccountId) || [];
      list.push({
        name: fc.institutionName || fc.accountName,
        logoUrl: fc.institutionLogoUrl || undefined,
      });
      map.set(fc.ledgerAccountId, list);
    }
    return map;
  }, [financialConnections]);

  // Fetch selected account details
  const { data: selectedAccount } = useQuery({
    queryKey: ["account", selected],
    queryFn: async (): Promise<ApiAccount | null> =>
      selected ? await callServerFn(getAccount, { data: { id: selected } }) : null,
    enabled: !!selected,
    placeholderData: keepPreviousData,
  });

  // Create account mutation
  const createMutation = useMutation({
    mutationFn: (formData: CategoryFormData) => callServerFn(createAccount, { data: formData }),
    onSuccess: (newAccount: { id: string }) => {
      navigate({ to: "/accounts", search: { selected: newAccount.id, mode: undefined } });
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["accounts"] });
    },
  });

  // Update account mutation
  const updateMutation = useMutation({
    mutationFn: (formData: CategoryFormData & { id: string }) =>
      callServerFn(updateAccount, { data: formData }),
    onSuccess: () => {
      navigate({ to: "/accounts", search: { selected, mode: undefined } });
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["accounts"] });
      queryClient.invalidateQueries({ queryKey: ["account", selected] });
    },
  });

  // Delete account mutation
  const deleteMutation = useMutation({
    mutationFn: (id: string) => callServerFn(deleteAccount, { data: { id } }),
    onSuccess: () => {
      setShowDeleteModal(false);
      navigate({ to: "/accounts", search: { selected: undefined, mode: undefined } });
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["accounts"] });
    },
  });

  // Handle account selection (toggle: clicking same row deselects)
  const handleSelect = (id: string) => {
    const nextSelected = id === selected ? undefined : id;
    navigate({ to: "/accounts", search: { ...search, selected: nextSelected, mode: undefined } });
  };

  // Handle new category button
  const handleNewClick = () => {
    navigate({ to: "/accounts", search: { ...search, selected: undefined, mode: "create" } });
  };

  // Handle edit button
  const handleEditClick = () => {
    if (selected) {
      navigate({ to: "/accounts", search: { ...search, selected, mode: "edit" } });
    }
  };

  // Handle form cancel
  const handleFormCancel = () => {
    navigate({ to: "/accounts", search: { ...search, selected, mode: undefined } });
  };

  // Handle form submit
  const handleFormSubmit = (formData: CategoryFormData) => {
    if (mode === "edit" && selected) {
      updateMutation.mutate({ ...formData, id: selected });
    } else {
      createMutation.mutate(formData);
    }
  };

  // Handle deactivate/activate category toggle
  const handleDeactivate = () => {
    if (!selected || !selectedAccount) return;
    const newActiveState = !(selectedAccount.isActive !== false);
    updateMutation.mutate(
      { id: selected, isActive: newActiveState } as CategoryFormData & {
        id: string;
        isActive: boolean;
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: ["accounts"] });
          queryClient.invalidateQueries({ queryKey: ["accounts-subtype-source"] });
          queryClient.invalidateQueries({ queryKey: ["account", selected] });
          navigate({ to: "/accounts", search: { selected, mode: undefined } });
        },
      },
    );
  };

  // Handle clear all — reset URL to clean /accounts
  const handleClearAll = () => {
    navigate({ to: "/accounts", search: {} });
  };

  // Convert API accounts to CategoryNode format
  const mapToCategories = useMemo((): CategoryNode[] => {
    const mapFn = (accs: ApiAccount[]): CategoryNode[] =>
      accs.map((acc) => ({
        id: acc.id,
        name: acc.name,
        accountNumber: acc.accountNumber,
        description: acc.description,
        accountType: (acc.accountType?.toLowerCase() || "asset") as AccountType,
        icon: acc.icon,
        parentId: acc.parentId,
        children: acc.children ? mapFn(acc.children) : undefined,
        connections: connectionsMap.get(acc.id) || [],
      }));
    return mapFn(accounts);
  }, [accounts, connectionsMap]);

  // Extract available subtypes from type-filtered (NOT subtype-filtered) data
  // so picking a subtype doesn't collapse the list of available subtypes.
  const availableSubtypes = useMemo(() => {
    const subs = new Set<string>();
    const collect = (accs: ApiAccount[]) => {
      for (const a of accs) {
        if (a.subtype) subs.add(a.subtype);
        if (a.children) collect(a.children);
      }
    };
    collect(subtypeSourceAccounts);
    return Array.from(subs).sort();
  }, [subtypeSourceAccounts]);

  // Filter accounts by search query + type filters (client-side text search)
  const filterCategories = (nodes: CategoryNode[]): CategoryNode[] => {
    const query = searchQuery.toLowerCase();
    const results: CategoryNode[] = [];

    for (const node of nodes) {
      const matchesSearch =
        !searchQuery ||
        node.name.toLowerCase().includes(query) ||
        node.accountNumber?.toLowerCase().includes(query) ||
        node.description?.toLowerCase().includes(query);

      const filteredChildren = node.children ? filterCategories(node.children) : [];

      if (matchesSearch || filteredChildren.length > 0) {
        results.push({
          ...node,
          children: filteredChildren.length > 0 ? filteredChildren : node.children,
        });
      }
    }

    return results;
  };

  const filteredCategories = filterCategories(mapToCategories);

  // Get flat list for parent selection dropdown
  const flatCategories = useMemo(() => {
    const flatten = (
      nodes: CategoryNode[],
    ): Array<{
      id: string;
      name: string;
      accountNumber?: string;
      accountType?: string;
      subtype?: string;
    }> =>
      nodes.flatMap((node) => [
        {
          id: node.id,
          name: node.name,
          accountNumber: node.accountNumber ?? undefined,
          accountType: node.accountType,
          subtype: (node as ApiAccount).subtype ?? undefined,
        },
        ...(node.children ? flatten(node.children) : []),
      ]);
    return flatten(mapToCategories);
  }, [mapToCategories]);

  // Find parent name for selected account
  const getParentName = (parentId: string | null | undefined): string | null => {
    if (!parentId) return null;
    const parent = flatCategories.find((c) => c.id === parentId);
    return parent?.name || null;
  };

  // Prepare initial data for edit mode
  const getInitialData = () => {
    if (mode !== "edit" || !selectedAccount) return undefined;
    return {
      id: selectedAccount.id,
      name: selectedAccount.name,
      accountNumber: selectedAccount.accountNumber ?? undefined,
      description: selectedAccount.description ?? undefined,
      accountType: (selectedAccount.accountType?.toLowerCase() || "asset") as AccountType,
      subtype: selectedAccount.subtype ?? undefined,
      parentId: selectedAccount.parentId ?? undefined,
      icon: selectedAccount.icon ?? undefined,
    };
  };

  // Prepare initial data for "add child" mode (mode=create + selected=parentId)
  const getNewChildData = () => {
    if (mode !== "create" || !selected) return undefined;
    // Walk the full account tree to find the parent's accountType and subtype
    const findParent = (accs: ApiAccount[]): ApiAccount | undefined => {
      for (const a of accs) {
        if (a.id === selected) return a;
        if (a.children) {
          const found = findParent(a.children);
          if (found) return found;
        }
      }
      return undefined;
    };
    const parentAccount = findParent(accounts);
    // Root categories have no parentId — don't pre-fill subtype, let user pick
    const isRootParent = parentAccount && !parentAccount.parentId;
    return {
      name: "",
      parentId: selected,
      accountType: (parentAccount?.accountType?.toLowerCase() || "asset") as AccountType,
      subtype: isRootParent ? undefined : (parentAccount?.subtype ?? undefined),
    };
  };

  // ============================================================================
  // Render
  // ============================================================================

  // Determine side panel content
  let sidePanel: React.ReactNode;
  if (mode === "create" || mode === "edit") {
    sidePanel = (
      <CategoryForm
        key={mode === "edit" ? `edit-${selected}` : `create-${selected || "root"}`}
        parentCategories={flatCategories}
        initialData={getInitialData() ?? getNewChildData()}
        onSubmit={handleFormSubmit}
        onCancel={handleFormCancel}
        onDeactivate={handleDeactivate}
        isActive={selectedAccount?.isActive !== false}
        isLoading={createMutation.isPending || updateMutation.isPending}
      />
    );
  } else if (selected && selectedAccount) {
    sidePanel = (
      <CategoryDetail
        id={selectedAccount.id}
        name={selectedAccount.name}
        accountNumber={selectedAccount.accountNumber}
        description={selectedAccount.description}
        accountType={(selectedAccount.accountType?.toLowerCase() || "asset") as AccountType}
        parentName={getParentName(selectedAccount.parentId)}
        balance={0}
        connections={connectionsMap.get(selectedAccount.id) || []}
        isSystem={selectedAccount.isSystem}
        isRootCategory={!selectedAccount.parentId}
        hasTransactions={false}
        transactionCount={0}
        onEdit={handleEditClick}
        onAddChild={() =>
          navigate({
            to: "/accounts",
            search: { ...search, selected, mode: "create", parentId: undefined },
          })
        }
        onDelete={() => setShowDeleteModal(true)}
      />
    );
  } else if (!selected) {
    // Only show the empty/filter panel when nothing is selected at all
    // (not when selected is set but data is still loading — that causes a flash)
    sidePanel = (
      <CategoryDetailEmpty
        activeTypes={filters.types}
        onTypeClick={(type) => {
          const next = filters.types.includes(type)
            ? filters.types.filter((t) => t !== type)
            : [...filters.types, type];
          setFilters({ ...filters, types: next });
        }}
      />
    );
  }

  const sidePanelMode =
    mode === "create" || mode === "edit" ? "form" : selected && selectedAccount ? "view" : "empty";

  const pageContent = (
    <CategoryManagerLayout
      sidePanel={sidePanel}
      sidePanelMode={sidePanelMode as "empty" | "view" | "form"}
      onMobilePanelClose={() =>
        navigate({ to: "/accounts", search: { ...search, selected: undefined, mode: undefined } })
      }
      searchValue={searchQuery}
      onSearchChange={setSearchQuery}
      showNewButton={mode !== "create" && mode !== "edit"}
      onNewClick={handleNewClick}
      onImportClick={() => setShowImportModal(true)}
      onUseTemplateClick={() => setShowPresetModal(true)}
      onAiCustomizeClick={() => setShowAiModal(true)}
      filters={filters}
      onFiltersChange={setFilters}
      onClearAll={handleClearAll}
      availableSubtypes={availableSubtypes}
    >
      {isLoading ? (
        <CategoryTreeSkeleton />
      ) : error ? (
        <div className="p-4 sm:p-6">
          <div className="text-sm font-semibold text-red-500">Error loading categories</div>
          {/* Server error text is unbounded and often contains long unspaced identifiers, which
              the overflow-hidden card clips instead of scrolling. */}
          <div className="mt-1 text-sm break-words text-[var(--color-app-text-light)]">
            {(error as Error).message}
          </div>
        </div>
      ) : (
        <CategoryTree
          onUseTemplate={() => setShowPresetModal(true)}
          categories={filteredCategories}
          selectedId={selected}
          onSelect={handleSelect}
          onEdit={(id) =>
            navigate({ to: "/accounts", search: { ...search, selected: id, mode: "edit" } })
          }
          onAddChild={(id) =>
            navigate({
              to: "/accounts",
              search: { ...search, selected: id, mode: "create", parentId: undefined },
            })
          }
          onNavigate={(id) => {
            if (selected === id) {
              // Already selected → navigate to detail page
              navigate({ to: `/accounts/category/${id}` });
            } else {
              // Not yet selected → select it to show preview
              navigate({ to: "/accounts", search: { ...search, selected: id, mode: undefined } });
            }
          }}
        />
      )}
    </CategoryManagerLayout>
  );

  return (
    <>
      {pageContent}
      {showDeleteModal && selectedAccount && (
        <DeleteCategoryModal
          categoryName={selectedAccount.name}
          isSystem={selectedAccount.isSystem}
          hasTransactions={false}
          transactionCount={0}
          onConfirm={() => deleteMutation.mutate(selectedAccount.id)}
          onCancel={() => setShowDeleteModal(false)}
          isLoading={deleteMutation.isPending}
        />
      )}
      <ImportCategoriesModal isOpen={showImportModal} onClose={() => setShowImportModal(false)} />
      <PresetPickerModal isOpen={showPresetModal} onClose={() => setShowPresetModal(false)} />
      <AiCustomizeModal isOpen={showAiModal} onClose={() => setShowAiModal(false)} />
    </>
  );
}
