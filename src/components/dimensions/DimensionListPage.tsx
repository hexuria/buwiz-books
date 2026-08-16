/**
 * DimensionListPage — the card-based floating layout shared by /departments and /locations.
 *
 * Both pages drive the same `dimensions` table and the same server functions, so the whole
 * screen (tree, filters, side panel, mobile slide-over, delete flows) lives here once and each
 * route supplies only its nouns, glyph, API set and query keys.
 *
 * Left card: teal header, filter bar, hierarchical list
 * Right card: detail view, edit/create form, or empty state
 */
import { Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import { useState, useMemo, useRef, useEffect } from "react";
import type React from "react";
import { DeleteCategoryModal } from "../accounts/DeleteCategoryModal";
import {
  StatusFilterChip,
  StatusFilterPopover,
  type StatusFilterValue,
} from "../accounts/StatusFilterPopover";
import { FilterBar } from "../ui/Actions";
import { RowActionsMenu, type RowAction } from "../ui/DataTable";

// ============================================================================
// Types
// ============================================================================

export interface DimensionRecord {
  id: string;
  dimensionType: string;
  name: string;
  code: string | null;
  description: string | null;
  parentId: string | null;
  sourceIntegration: string | null;
  sourceIntegrationId: string | null;
  metadata: Record<string, unknown> | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface DimensionNode extends DimensionRecord {
  children: DimensionNode[];
}

export interface DimensionSearch {
  selected?: string;
  mode?: string; // "new" | "edit"
  status?: string; // "active" | "deactivated"
}

/** The server functions from `src/routes/api/-dimensions.ts` for one dimension type. */
export interface DimensionApi {
  list: (opts: { data: unknown }) => Promise<DimensionRecord[]>;
  get: (opts: { data: unknown }) => Promise<DimensionRecord | null>;
  create: (opts: { data: unknown }) => Promise<DimensionRecord>;
  update: (opts: { data: unknown }) => Promise<DimensionRecord>;
  deactivate: (opts: { data: unknown }) => Promise<DimensionRecord>;
  permanentlyDelete: (opts: { data: unknown }) => Promise<{ success: boolean }>;
}

/** Every string that differs between the two pages, in the order it appears on screen. */
export interface DimensionLabels {
  /** Left card header, e.g. "Departments". */
  plural: string;
  /** Top-bar button and the create-form header, e.g. "New Department". */
  newEntity: string;
  /** Edit-form header, e.g. "Edit Department". */
  editEntity: string;
  searchAriaLabel: string;
  searchPlaceholder: string;
  /** Desktop list column header, e.g. "Department". */
  columnHeader: string;
  errorLoading: string;
  emptySearch: string;
  emptyList: string;
  addFirst: string;
  /** Add-child affordance — hover strip, overflow sheet and detail card all share it. */
  addChild: string;
  editRow: string;
  viewRow: string;
  deactivateEntity: string;
  reactivateEntity: string;
  restoreEntity: string;
  deleteEntity: string;
  parentLabel: string;
  nameLabel: string;
  namePlaceholder: string;
  selectPrompt: string;
  selectHint: string;
}

export interface DimensionPageConfig {
  /** Router path of the list page itself. */
  basePath: "/departments" | "/locations";
  /** Router path of the per-record detail page. */
  detailPath: (id: string) => string;
  /** The page glyph, used everywhere from the header to the parent picker rows. */
  Icon: React.ComponentType<{ size?: number }>;
  /** The detail card's top accent band glyph, which is not always the page glyph. */
  accentIcon: React.ReactNode;
  listQueryKey: readonly unknown[];
  detailQueryKey: (id: string | undefined) => readonly unknown[];
  api: DimensionApi;
  /**
   * Order of the form's parent picker. "hierarchy" walks the tree depth-first, "source" keeps the
   * order the server returned — the two pages have always differed here, and this preserves that.
   */
  parentPickerOrder: "hierarchy" | "source";
  labels: DimensionLabels;
}

// ============================================================================
// Hierarchy helpers
// ============================================================================

function buildTree(records: DimensionRecord[], statusFilter: StatusFilterValue): DimensionNode[] {
  const items =
    statusFilter === "deactivated"
      ? records.filter((d) => !d.isActive)
      : statusFilter === "active"
        ? records.filter((d) => d.isActive)
        : records;
  const map = new Map<string, DimensionNode>();
  for (const d of items) map.set(d.id, { ...d, children: [] });

  const roots: DimensionNode[] = [];
  for (const node of map.values()) {
    if (node.parentId && map.has(node.parentId)) {
      map.get(node.parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

function filterTree(nodes: DimensionNode[], query: string): DimensionNode[] {
  if (!query) return nodes;
  const q = query.toLowerCase();

  const filter = (list: DimensionNode[]): DimensionNode[] => {
    const result: DimensionNode[] = [];
    for (const node of list) {
      const childMatches = filter(node.children);
      const selfMatch =
        node.name.toLowerCase().includes(q) ||
        (node.code && node.code.toLowerCase().includes(q)) ||
        (node.description && node.description.toLowerCase().includes(q));
      if (selfMatch || childMatches.length > 0) {
        result.push({ ...node, children: childMatches.length > 0 ? childMatches : node.children });
      }
    }
    return result;
  };
  return filter(nodes);
}

function flattenTree(nodes: DimensionNode[]): DimensionRecord[] {
  const flat: DimensionRecord[] = [];
  const walk = (list: DimensionNode[]) => {
    for (const n of list) {
      flat.push(n);
      walk(n.children);
    }
  };
  walk(nodes);
  return flat;
}

// ============================================================================
// Mobile filter choices
// ============================================================================

/** Mirrors the desktop `StatusFilterPopover` options. */
const STATUS_CHOICES: Array<{ value: StatusFilterValue; label: string; color: string }> = [
  { value: null, label: "All", color: "#cbd5e1" },
  { value: "active", label: "Active", color: "#22c55e" },
  { value: "deactivated", label: "Inactive", color: "#94a3b8" },
];

// ============================================================================
// Page Component
// ============================================================================

export function DimensionListPage({
  config,
  search,
}: {
  config: DimensionPageConfig;
  search: DimensionSearch;
}) {
  const { basePath, detailPath, Icon, accentIcon, api, labels } = config;
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [searchTerm, setSearchTerm] = useState("");
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleteAction, setDeleteAction] = useState<"deactivate" | "permanent">("deactivate");
  const [filterOpen, setFilterOpen] = useState(false);
  const filterBtnRef = useRef<HTMLButtonElement>(null);

  // Derive status filter from URL (default: "active")
  const statusFilter: StatusFilterValue = (search.status as StatusFilterValue) ?? "active";
  const setStatusFilter = (next: StatusFilterValue) => {
    navigate({
      to: basePath,
      search: {
        ...search,
        status: next === "active" ? undefined : (next ?? undefined),
      },
    });
  };

  // ── Data fetching ──────────────────────────────────────────────────────────
  const {
    data: records = [],
    isLoading,
    error,
  } = useQuery({
    queryKey: config.listQueryKey,
    queryFn: () => api.list({ data: {} }),
  });

  const { data: selected } = useQuery({
    queryKey: config.detailQueryKey(search.selected),
    queryFn: () => (search.selected ? api.get({ data: { id: search.selected } }) : null),
    enabled: !!search.selected,
    placeholderData: keepPreviousData,
  });

  // ── Mutations ──────────────────────────────────────────────────────────────
  const createMut = useMutation({
    mutationFn: (data: { name: string; description?: string; parentId?: string | null }) =>
      api.create({ data }),
    onSuccess: (created: DimensionRecord) => {
      queryClient.invalidateQueries({ queryKey: config.listQueryKey });
      navigate({
        to: basePath,
        search: { ...keepStatus, selected: created.id, mode: undefined },
      });
    },
  });

  const updateMut = useMutation({
    mutationFn: (
      data: { id: string } & Partial<{
        name: string;
        description: string;
        parentId: string | null;
        isActive: boolean;
      }>,
    ) => api.update({ data }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: config.listQueryKey });
      queryClient.invalidateQueries({ queryKey: config.detailQueryKey(search.selected) });
      navigate({
        to: basePath,
        search: { ...keepStatus, selected: search.selected, mode: undefined },
      });
    },
  });

  const deactivateMut = useMutation({
    mutationFn: (id: string) => api.deactivate({ data: { id } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: config.listQueryKey });
      setShowDeleteModal(false);
      navigate({ to: basePath, search: { ...keepStatus } });
    },
  });

  const permanentDeleteMut = useMutation({
    mutationFn: (id: string) => api.permanentlyDelete({ data: { id } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: config.listQueryKey });
      setShowDeleteModal(false);
      navigate({ to: basePath, search: {} });
    },
  });

  // ── Tree ───────────────────────────────────────────────────────────────────
  const tree = useMemo(
    () => filterTree(buildTree(records as DimensionRecord[], statusFilter), searchTerm),
    [records, statusFilter, searchTerm],
  );

  const flatRecords = useMemo(
    () =>
      config.parentPickerOrder === "hierarchy"
        ? flattenTree(buildTree(records as DimensionRecord[], null))
        : ((records ?? []) as DimensionRecord[]),
    [records, config.parentPickerOrder],
  );

  // ── Navigation helpers ─────────────────────────────────────────────────────
  // Preserve the current status filter across all navigations
  const keepStatus = search.status ? { status: search.status } : {};

  const handleSelect = (id: string) => {
    navigate({
      to: basePath,
      search: { ...keepStatus, selected: id === search.selected ? undefined : id, mode: undefined },
    });
  };

  const handleNew = () => {
    navigate({ to: basePath, search: { ...keepStatus, mode: "new" } });
  };

  const handleEditClick = (id?: string) => {
    const target = id || search.selected;
    if (target) {
      navigate({
        to: basePath,
        search: { ...keepStatus, selected: target, mode: "edit" },
      });
    }
  };

  const handleAddChild = (parentId: string) => {
    navigate({
      to: basePath,
      search: { ...keepStatus, selected: parentId, mode: "new" },
    });
  };

  const handleNavigate = (id: string) => {
    if (search.selected === id) {
      // Already selected → navigate to detail / transactions page
      navigate({ to: detailPath(id) });
    } else {
      // Not yet selected → select it to show preview
      navigate({
        to: basePath,
        search: { ...keepStatus, selected: id, mode: undefined },
      });
    }
  };

  const handleFormCancel = () => {
    navigate({
      to: basePath,
      search: { ...keepStatus, selected: search.selected, mode: undefined },
    });
  };

  const handleFormSubmit = (data: {
    name: string;
    description?: string;
    parentId?: string | null;
  }) => {
    if (search.mode === "edit" && search.selected) {
      updateMut.mutate({ id: search.selected, ...data });
    } else {
      createMut.mutate(data);
    }
  };

  const isNewMode = search.mode === "new";
  const isEditMode = search.mode === "edit" && !!selected;
  const showDetail = !!search.selected && !isEditMode && !isNewMode;

  // ── Side panel content ─────────────────────────────────────────────────────
  let sidePanel: React.ReactNode;
  let sidePanelMode: "empty" | "view" | "form" = "empty";

  if (isNewMode || isEditMode) {
    sidePanelMode = "form";
    sidePanel = (
      <DimensionFormCard
        key={isEditMode ? `edit-${search.selected}` : `new-${search.selected || "root"}`}
        Icon={Icon}
        labels={labels}
        records={isEditMode ? flatRecords.filter((d) => d.id !== selected?.id) : flatRecords}
        initialData={isEditMode ? (selected as DimensionRecord) : undefined}
        parentId={isNewMode && search.selected ? search.selected : undefined}
        onSubmit={handleFormSubmit}
        onCancel={handleFormCancel}
        onDeactivate={
          isEditMode && selected
            ? () => updateMut.mutate({ id: selected.id, isActive: !selected.isActive })
            : undefined
        }
        isActive={selected?.isActive !== false}
        isLoading={createMut.isPending || updateMut.isPending}
      />
    );
  } else if (showDetail && selected) {
    sidePanelMode = "view";
    sidePanel = (
      <DimensionDetailCard
        Icon={Icon}
        accentIcon={accentIcon}
        labels={labels}
        record={selected}
        parentName={flatRecords.find((d) => d.id === selected.parentId)?.name}
        onEdit={() => handleEditClick()}
        onAddChild={() => handleAddChild(selected.id)}
        onDeactivate={() => {
          setDeleteAction("deactivate");
          setShowDeleteModal(true);
        }}
        onTrashClick={() => {
          setDeleteAction("permanent");
          setShowDeleteModal(true);
        }}
        onRestore={() => updateMut.mutate({ id: selected.id, isActive: true })}
      />
    );
  } else {
    sidePanel = <DimensionEmptyCard Icon={Icon} labels={labels} />;
  }

  const showMobilePanel = sidePanelMode === "view" || sidePanelMode === "form";

  // Latent bug, preserved verbatim from both original pages: this is the one navigation here that
  // does NOT spread `keepStatus`, so dismissing the slide-over drops `status` from the URL and the
  // list snaps back to the "active" default. Fixing it is a behaviour change, not a refactor.
  const closeMobilePanel = () => {
    navigate({
      to: basePath,
      search: { selected: search.selected, mode: undefined },
    });
  };

  // The desktop popover anchors to an icon that has no room below md, so the same status choice
  // is handed to `FilterBar`, which presents it as a sheet with 48px rows.
  const statusFilterFields = (
    <fieldset className="flex flex-col gap-1 border-none p-0 m-0">
      <legend className="mb-2 text-xs font-semibold uppercase tracking-wider text-[var(--color-app-text-light)]">
        Status
      </legend>
      {STATUS_CHOICES.map((opt) => {
        const isSelected = statusFilter === opt.value;
        return (
          <button
            key={opt.label}
            type="button"
            aria-pressed={isSelected}
            onClick={() => setStatusFilter(opt.value)}
            className={`flex min-h-12 w-full items-center gap-3 rounded-lg px-3 text-left text-sm font-medium transition-colors ${
              isSelected
                ? "bg-teal-50 text-teal-700 dark:bg-teal-900/30 dark:text-teal-300"
                : "text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800"
            }`}
          >
            <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: opt.color }} />
            <span className="flex-1">{opt.label}</span>
            {isSelected && (
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
              >
                <path d="M20 6L9 17l-5-5" />
              </svg>
            )}
          </button>
        );
      })}
    </fieldset>
  );

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="app-page-bg h-full flex flex-col overflow-hidden">
      {/* Top Navigation */}
      <div className="flex items-center justify-between gap-2 px-3 sm:px-6 py-2 sm:py-3 mx-auto max-w-[1132px] w-full shrink-0 min-h-[56px] sm:min-h-[65px]">
        <Link
          to="/"
          className="inline-flex min-h-11 items-center gap-1.5 text-sm font-medium text-slate-700 no-underline hover:text-teal-700 transition-colors"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            className="shrink-0"
          >
            <path d="M15 18l-6-6 6-6" />
          </svg>
          <span className="sm:hidden">Back</span>
          <span className="hidden sm:inline">Back to Dashboard</span>
        </Link>

        <button
          type="button"
          onClick={handleNew}
          aria-label={labels.newEntity}
          className="flex min-h-11 items-center gap-2 px-4 py-2 rounded-full bg-[var(--color-app-header-teal)] text-white text-sm font-semibold shadow-sm hover:shadow-md transition-all cursor-pointer border-none whitespace-nowrap"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
          >
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          <span className="sm:hidden">New</span>
          <span className="hidden sm:inline">{labels.newEntity}</span>
        </button>
      </div>

      {/* Two-Panel Layout */}
      <div className="flex gap-6 px-3 sm:px-6 pb-3 sm:pb-6 max-w-[1132px] mx-auto w-full flex-1 min-h-0 items-stretch">
        {/* ── Left Card ───────────────────────────────────────────────── */}
        <div className="bg-[var(--color-app-card)] rounded-2xl shadow-[0_4px_24px_rgba(0,0,0,0.08)] overflow-hidden flex-1 min-w-0 relative flex flex-col max-h-full">
          {/* Teal Header */}
          <div className="bg-[var(--color-app-header-teal)] text-white px-5 py-4 flex items-center gap-3 font-semibold text-base shrink-0">
            <Icon size={20} />
            <span>{labels.plural}</span>
          </div>

          {/* Search Bar with Filter Chips */}
          <div className="flex flex-wrap items-center gap-1.5 py-2 md:py-3 px-4 bg-white dark:bg-slate-800 border-b border-gray-200 dark:border-slate-700 shrink-0">
            {/* Filter toggle button — desktop popover trigger */}
            <button
              ref={filterBtnRef}
              type="button"
              onClick={() => setFilterOpen(!filterOpen)}
              className={`hidden md:flex items-center p-1.5 rounded-md border-none cursor-pointer transition-colors ${
                filterOpen
                  ? "bg-teal-50 text-teal-600"
                  : "bg-transparent text-slate-500 hover:text-teal-600"
              }`}
              title="Filters"
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
              </svg>
            </button>

            {/* Filters sheet trigger — below md, where the anchored popover has nowhere to go.
                Hidden rather than unmounted above md: FilterBar renders its children inline
                there, which this toolbar has no room for next to the search field. */}
            <div className="md:hidden shrink-0">
              <FilterBar activeCount={statusFilter ? 1 : 0}>{statusFilterFields}</FilterBar>
            </div>

            {/* Active filter chip */}
            <span className="hidden md:contents">
              <StatusFilterChip status={statusFilter} onClear={() => setStatusFilter(null)} />
            </span>

            {/* Search input — 16px below md, or iOS zooms the viewport on focus */}
            <input
              type="text"
              aria-label={labels.searchAriaLabel}
              className="flex-1 min-w-[100px] border-none outline-none text-base md:text-sm text-[var(--color-app-text-navy)] bg-transparent placeholder:text-[var(--color-app-text-light)]"
              placeholder={labels.searchPlaceholder}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />

            {/* Clear all button */}
            {(statusFilter !== null || searchTerm !== "") && (
              <button
                type="button"
                onClick={() => {
                  setStatusFilter(null);
                  setSearchTerm("");
                }}
                className="touch-target bg-transparent border-none cursor-pointer text-teal-600 font-semibold text-xs whitespace-nowrap hover:text-teal-700 transition-colors"
              >
                Clear
              </button>
            )}
          </div>

          {/* Filter Popover */}
          <StatusFilterPopover
            open={filterOpen}
            onClose={() => setFilterOpen(false)}
            status={statusFilter}
            onChange={setStatusFilter}
            anchorRef={filterBtnRef}
          />

          {/* Column Headers — the card layout below md carries its own labelling */}
          <div className="hidden md:grid grid-cols-12 items-center px-4 py-2 text-[10px] font-semibold text-[var(--color-app-text-light)] uppercase tracking-wider border-b border-gray-200 dark:border-slate-700 shrink-0">
            <span className="col-span-6">{labels.columnHeader}</span>
            <span className="col-span-6 text-center">Source</span>
          </div>

          {/* List — scrollable */}
          <div className="overflow-y-auto flex-1 bg-white dark:bg-slate-900">
            {isLoading ? (
              <DimensionListSkeleton />
            ) : error ? (
              <div className="flex flex-col items-center justify-center py-16 text-center">
                <p className="text-sm font-medium text-red-500">{labels.errorLoading}</p>
                <p className="text-xs text-slate-400 mt-1">{(error as Error).message}</p>
              </div>
            ) : tree.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-center">
                <span className="text-slate-200 dark:text-slate-700 mb-3">
                  <Icon size={48} />
                </span>
                <p className="text-sm font-medium text-[var(--color-app-text-light)]">
                  {searchTerm ? labels.emptySearch : labels.emptyList}
                </p>
                {!searchTerm && (
                  <button
                    type="button"
                    onClick={handleNew}
                    className="mt-3 inline-flex min-h-11 items-center px-3 text-sm text-[var(--color-app-header-teal)] hover:underline font-medium bg-transparent border-none cursor-pointer"
                  >
                    {labels.addFirst}
                  </button>
                )}
              </div>
            ) : (
              <DimensionTreeRows
                Icon={Icon}
                labels={labels}
                nodes={tree}
                level={0}
                selectedId={search.selected}
                onSelect={handleSelect}
                onEdit={handleEditClick}
                onAddChild={handleAddChild}
                onNavigate={handleNavigate}
              />
            )}
          </div>
        </div>

        {/* ── Right Panel — desktop only ──────────────────────────────── */}
        <div className="hidden lg:block shrink-0 w-[340px]">{sidePanel}</div>
      </div>

      {/* Mobile Slide-Over */}
      {showMobilePanel && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div
            className="absolute inset-0 bg-black/30 transition-opacity"
            onClick={closeMobilePanel}
            onKeyDown={(e) => e.key === "Escape" && closeMobilePanel()}
            role="button"
            tabIndex={-1}
            aria-label="Close panel"
          />
          <div className="absolute inset-y-0 right-0 w-full max-w-[400px] pt-safe pb-safe pr-safe bg-[var(--color-app-page-bg,#e8f0f2)] dark:bg-slate-900 shadow-2xl flex flex-col animate-[slideInRight_0.2s_ease-out]">
            <div className="flex items-center px-4 py-2 shrink-0">
              <button
                type="button"
                onClick={closeMobilePanel}
                className="inline-flex min-h-11 items-center gap-1.5 text-sm font-medium text-slate-600 dark:text-slate-400 bg-transparent border-none cursor-pointer hover:text-slate-800 dark:hover:text-slate-200 transition-colors"
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                >
                  <path d="M15 18l-6-6 6-6" />
                </svg>
                Back
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-3 pb-6">{sidePanel}</div>
          </div>
        </div>
      )}

      {/* Delete modal */}
      {showDeleteModal && selected && (
        <DeleteCategoryModal
          categoryName={selected.name}
          title={deleteAction === "deactivate" ? labels.deactivateEntity : labels.deleteEntity}
          message={
            deleteAction === "deactivate" ? (
              <>
                Are you sure you want to deactivate <strong>{selected.name}</strong>?
                <br />
                <span className="text-xs text-gray-500 mt-1 block">
                  You can restore it later from the inactive list.
                </span>
              </>
            ) : (
              <>
                Are you sure you want to permanently delete <strong>{selected.name}</strong>?
                <br />
                <span className="text-xs text-red-600 mt-1 block font-medium">
                  This action cannot be undone.
                </span>
              </>
            )
          }
          confirmLabel={deleteAction === "deactivate" ? "Deactivate" : "Delete"}
          onConfirm={() =>
            deleteAction === "deactivate"
              ? deactivateMut.mutate(selected.id)
              : permanentDeleteMut.mutate(selected.id)
          }
          onCancel={() => setShowDeleteModal(false)}
          isLoading={
            deleteAction === "deactivate" ? deactivateMut.isPending : permanentDeleteMut.isPending
          }
        />
      )}
    </div>
  );
}

// ============================================================================
// Tree Rows — recursive with indent + hover action buttons
// ============================================================================

function DimensionTreeRows({
  Icon,
  labels,
  nodes,
  level,
  selectedId,
  onSelect,
  onEdit,
  onAddChild,
  onNavigate,
}: {
  Icon: React.ComponentType<{ size?: number }>;
  labels: DimensionLabels;
  nodes: DimensionNode[];
  level: number;
  selectedId?: string;
  onSelect: (id: string) => void;
  onEdit: (id: string) => void;
  onAddChild: (id: string) => void;
  onNavigate: (id: string) => void;
}) {
  return (
    <>
      {nodes.map((node) => (
        <DimensionRowItem
          key={node.id}
          Icon={Icon}
          labels={labels}
          node={node}
          level={level}
          selectedId={selectedId}
          onSelect={onSelect}
          onEdit={onEdit}
          onAddChild={onAddChild}
          onNavigate={onNavigate}
        />
      ))}
    </>
  );
}

function DimensionRowItem({
  Icon,
  labels,
  node,
  level,
  selectedId,
  onSelect,
  onEdit,
  onAddChild,
  onNavigate,
}: {
  Icon: React.ComponentType<{ size?: number }>;
  labels: DimensionLabels;
  node: DimensionNode;
  level: number;
  selectedId?: string;
  onSelect: (id: string) => void;
  onEdit: (id: string) => void;
  onAddChild: (id: string) => void;
  onNavigate: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const hasChildren = node.children.length > 0;
  const isSelected = node.id === selectedId;

  // Same three operations the desktop hover strip offers, reused by the mobile overflow sheet.
  const rowActions: Array<RowAction<DimensionNode>> = [
    {
      label: labels.addChild,
      onSelect: (n) => onAddChild(n.id),
      icon: (
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
          <path d="M3 3v10.2c0 1.68 0 2.52.327 3.162a3 3 0 001.311 1.311C5.28 18 6.12 18 7.8 18H15m0 0a3 3 0 106 0 3 3 0 00-6 0M3 8h12m0 0a3 3 0 106 0 3 3 0 00-6 0" />
        </svg>
      ),
    },
    {
      label: labels.editRow,
      onSelect: (n) => onEdit(n.id),
      icon: (
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
          <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
        </svg>
      ),
    },
    {
      label: isSelected ? "View details" : labels.viewRow,
      onSelect: (n) => onNavigate(n.id),
      icon: (
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
          <path d="M9 18l6-6-6-6" />
        </svg>
      ),
    },
  ];

  return (
    <>
      <div
        className={`group flex md:grid md:grid-cols-12 items-center gap-2 md:gap-0 py-4 md:py-3 px-4 cursor-pointer transition-colors border-b border-[#f0f1f3] dark:border-slate-700 hover:bg-[#f8f9fb] dark:hover:bg-slate-800 ${
          isSelected ? "bg-[#e8f4fe] dark:bg-slate-700" : ""
        }`}
        // The indent step shrinks with the viewport so a deep tree still leaves room for the name
        // at 375px, and settles at the original 24px once there is width for it.
        style={{ paddingLeft: `calc(1rem + ${level} * min(1.5rem, 3vw))` }}
        onClick={() => onSelect(node.id)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === "Enter" && onSelect(node.id)}
        // Rows are divs, not table rows — the e2e spec that targeted `tbody tr` matched nothing
        // and passed vacuously for as long as it existed. A testid is the stable handle.
        data-testid="dimension-row"
      >
        {/* Name column */}
        <div className="col-span-6 flex flex-1 items-center gap-2.5 min-w-0">
          {/* Expand/collapse toggle */}
          {hasChildren ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setExpanded(!expanded);
              }}
              aria-expanded={expanded}
              aria-label={expanded ? `Collapse ${node.name}` : `Expand ${node.name}`}
              className="touch-target w-9 h-9 rounded-lg flex items-center justify-center shrink-0 bg-[#e8f5f0] dark:bg-teal-900/30 text-[var(--color-app-header-teal)] border-none cursor-pointer"
            >
              {expanded ? (
                <>
                  {/* Expanded: show icon by default, chevron-down on hover */}
                  <span className="group-hover:hidden">
                    <Icon size={14} />
                  </span>
                  <span className="hidden group-hover:flex items-center justify-center">
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                    >
                      <path d="M6 9l6 6 6-6" />
                    </svg>
                  </span>
                </>
              ) : (
                /* Collapsed: always show chevron-right */
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                >
                  <path d="M9 18l6-6-6-6" />
                </svg>
              )}
            </button>
          ) : (
            <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0 bg-[#e8f5f0] dark:bg-teal-900/30 text-[var(--color-app-header-teal)]">
              <Icon size={14} />
            </div>
          )}

          {/* Info */}
          <div className="flex-1 min-w-0">
            <div>
              <span className="font-semibold text-[var(--color-app-text-navy)] text-[0.9375rem]">
                {node.name}
              </span>
              {node.code && (
                <span className="font-normal text-[var(--color-app-text-light)] text-sm md:text-[0.8125rem] ml-2">
                  {node.code}
                </span>
              )}
            </div>
            {node.description && (
              <div className="text-sm md:text-[0.8125rem] text-[var(--color-app-text-light)] truncate mt-0.5">
                {node.description}
              </div>
            )}
          </div>

          {/* Inactive badge */}
          {!node.isActive && (
            <span className="shrink-0 px-1.5 py-0.5 rounded text-[11px] md:text-[9px] font-semibold bg-red-100 text-red-600 uppercase">
              Inactive
            </span>
          )}
        </div>

        {/* Source + action buttons column */}
        <div className="col-span-6 flex shrink-0 items-center justify-end">
          {/* Source badge — always visible */}
          {node.sourceIntegration && (
            <span
              className="w-6 h-6 rounded-full bg-[#e74c3c] flex items-center justify-center text-[11px] font-bold text-white uppercase mr-2"
              title={node.sourceIntegration}
            >
              {node.sourceIntegration.charAt(0)}
            </span>
          )}

          {/* Overflow menu — the touch equivalent of the hover strip below md */}
          <div className="md:hidden">
            <RowActionsMenu row={node} actions={rowActions} />
          </div>

          {/* Hover action buttons — identical to CategoryRow */}
          <div className="hidden md:flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
            {/* Add child — GitBranch01 */}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onAddChild(node.id);
              }}
              className="touch-target w-9 h-9 rounded-full flex items-center justify-center bg-transparent border-none cursor-pointer text-slate-500 dark:text-slate-300 transition-all hover:bg-slate-200/60 dark:hover:bg-slate-600 hover:text-slate-700 dark:hover:text-white"
              title={labels.addChild}
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
                <path d="M3 3v10.2c0 1.68 0 2.52.327 3.162a3 3 0 001.311 1.311C5.28 18 6.12 18 7.8 18H15m0 0a3 3 0 106 0 3 3 0 00-6 0M3 8h12m0 0a3 3 0 106 0 3 3 0 00-6 0" />
              </svg>
            </button>
            {/* Edit — Pencil01 */}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onEdit(node.id);
              }}
              className="touch-target w-9 h-9 rounded-full flex items-center justify-center bg-transparent border-none cursor-pointer text-slate-500 dark:text-slate-300 transition-all hover:bg-slate-200/60 dark:hover:bg-slate-600 hover:text-slate-700 dark:hover:text-white"
              title={labels.editRow}
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
                <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
              </svg>
            </button>
            {/* Navigate — chevron when unselected, arrow-up-right when selected */}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onNavigate(node.id);
              }}
              className="touch-target w-9 h-9 rounded-full flex items-center justify-center bg-transparent border-none cursor-pointer text-slate-500 dark:text-slate-300 transition-all hover:bg-slate-200/60 dark:hover:bg-slate-600 hover:text-slate-700 dark:hover:text-white opacity-0 group-hover:opacity-70"
              title={isSelected ? "View details" : labels.viewRow}
            >
              {isSelected ? (
                /* Arrow-up-right — diagonal icon for "go to detail page" */
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
                  <path d="M7 17L17 7" />
                  <path d="M7 7h10v10" />
                </svg>
              ) : (
                /* ChevronRight — select to preview */
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
                  <path d="M9 18l6-6-6-6" />
                </svg>
              )}
            </button>
          </div>
        </div>
      </div>

      {/* Children */}
      {expanded && hasChildren && (
        <DimensionTreeRows
          Icon={Icon}
          labels={labels}
          nodes={node.children}
          level={level + 1}
          selectedId={selectedId}
          onSelect={onSelect}
          onEdit={onEdit}
          onAddChild={onAddChild}
          onNavigate={onNavigate}
        />
      )}
    </>
  );
}

// ============================================================================
// Right Side Panel Cards
// ============================================================================

/** Detail card — shows the record's details and activity chart placeholder */
function DimensionDetailCard({
  Icon,
  accentIcon,
  labels,
  record,
  parentName,
  onEdit,
  onAddChild,
  onTrashClick,
  onDeactivate,
  onRestore,
}: {
  Icon: React.ComponentType<{ size?: number }>;
  accentIcon: React.ReactNode;
  labels: DimensionLabels;
  record: DimensionRecord;
  parentName?: string;
  onEdit: () => void;
  onAddChild: () => void;
  onTrashClick: () => void;
  onDeactivate: () => void;
  onRestore: () => void;
}) {
  const currentMonth = new Date().toLocaleString("default", { month: "long", year: "numeric" });

  return (
    <div className="bg-[var(--color-app-card)] rounded-2xl shadow-[0_4px_24px_rgba(0,0,0,0.08)] overflow-hidden w-full lg:w-[340px] lg:shrink-0 min-h-[500px] flex flex-col">
      {/* Top accent band */}
      <div className="flex justify-center pt-5 pb-1 bg-[var(--color-app-header-teal)]">
        <div className="w-10 h-10 rounded-lg bg-white/20 flex items-center justify-center text-white">
          {accentIcon}
        </div>
      </div>

      {/* Header */}
      <div className="relative px-5 pt-3 pb-4">
        {/* Action buttons */}
        <div className="absolute top-3 right-5 flex items-center gap-1">
          <button
            type="button"
            className="touch-target w-7 h-7 rounded-full flex items-center justify-center bg-transparent border-none cursor-pointer text-[var(--color-app-text-light)] hover:bg-slate-100 dark:hover:bg-slate-700 hover:text-[var(--color-app-text-navy)] transition-all"
            onClick={onAddChild}
            title={labels.addChild}
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
              <path d="M3 3v10.2c0 1.68 0 2.52.327 3.162a3 3 0 001.311 1.311C5.28 18 6.12 18 7.8 18H15m0 0a3 3 0 106 0 3 3 0 00-6 0M3 8h12m0 0a3 3 0 106 0 3 3 0 00-6 0" />
            </svg>
          </button>
          <button
            type="button"
            className="touch-target w-7 h-7 rounded-full flex items-center justify-center bg-transparent border-none cursor-pointer text-[var(--color-app-text-light)] hover:bg-slate-100 dark:hover:bg-slate-700 hover:text-[var(--color-app-text-navy)] transition-all"
            onClick={onEdit}
            title="Edit"
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
              <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
            </svg>
          </button>
          {/* Trash icon (Permanent Delete) - ONLY visible when inactive */}
          {!record.isActive && (
            <button
              type="button"
              className="touch-target w-7 h-7 rounded-full flex items-center justify-center bg-transparent border-none cursor-pointer text-[var(--color-app-text-light)] hover:bg-red-50 dark:hover:bg-red-900/20 hover:text-red-500 transition-all"
              onClick={onTrashClick}
              title="Permanently delete"
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
                <path d="M3 6h18" />
                <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
              </svg>
            </button>
          )}
        </div>

        {/* Icon + Name */}
        <div className="flex items-start gap-3 pr-24">
          <div className="w-10 h-10 rounded-lg flex items-center justify-center bg-[var(--color-app-header-teal)] text-white shrink-0">
            <Icon size={18} />
          </div>
          <div className="flex-1 min-w-0">
            {parentName && (
              <div className="text-xs text-[var(--color-app-header-teal)] font-medium leading-tight">
                {parentName}
              </div>
            )}
            <div className="text-lg font-bold text-[var(--color-app-text-navy)] leading-snug">
              {record.name}
            </div>
            {record.code && (
              <div className="text-xs text-[var(--color-app-text-light)] mt-0.5">
                Code: {record.code}
              </div>
            )}
          </div>
        </div>

        {/* Description */}
        {record.description && (
          <p className="text-sm text-[#6b7c93] mt-3 leading-relaxed">{record.description}</p>
        )}
      </div>

      {/* Activity / Chart section */}
      <div className="mx-4 mb-4 bg-[#f5f7fb] dark:bg-slate-800 rounded-xl p-4 flex-1 flex flex-col">
        <div className="flex items-center gap-2 text-sm font-semibold text-[var(--color-app-text-navy)]">
          <Icon size={16} />
          <span>{record.name}</span>
        </div>
        <div className="text-xs text-[var(--color-app-text-light)] mt-0.5">{currentMonth}</div>

        {/* Bar chart placeholder — for reference */}
        <div className="flex-1 flex items-center justify-center mt-4">
          <BarChartPlaceholder />
        </div>
      </div>

      {/* Delete/Restore button (footer) */}
      <div className="px-5 pb-4">
        {record.isActive ? (
          <button
            type="button"
            onClick={onDeactivate}
            className="w-full min-h-11 py-2 rounded-lg text-sm font-medium text-red-500 bg-transparent border border-red-200 dark:border-red-900/30 hover:bg-red-50 dark:hover:bg-red-950/20 transition-colors cursor-pointer"
          >
            {labels.deactivateEntity}
          </button>
        ) : (
          <button
            type="button"
            onClick={onRestore}
            className="w-full min-h-11 py-2 rounded-lg text-sm font-medium text-[#0d9488] bg-transparent border border-[#0d9488]/30 hover:bg-teal-50 dark:hover:bg-teal-900/20 transition-colors cursor-pointer"
          >
            {labels.restoreEntity}
          </button>
        )}
      </div>
    </div>
  );
}

/** Simple bar chart placeholder */
function BarChartPlaceholder() {
  const bars = [35, 45, 55, 40, 50, 60, 45, 55, 40, 50, 65, 30];
  const months = ["FEB", "APR", "JUN", "AUG", "OCT", "JAN"];
  const maxH = 80;

  return (
    <div className="w-full">
      {/* Y-axis labels + bars */}
      <div className="flex items-end gap-[3px] h-[80px]">
        {bars.map((h, i) => (
          <div
            key={i}
            className="flex-1 bg-gray-200 dark:bg-slate-700 rounded-t-sm"
            style={{ height: `${(h / 70) * maxH}%` }}
          />
        ))}
      </div>
      {/* X-axis labels */}
      <div className="flex justify-between mt-1.5 text-[10px] text-[var(--color-app-text-light)]">
        {months.map((m) => (
          <span key={m}>{m}</span>
        ))}
      </div>
    </div>
  );
}

/** Edit / Create Form — rendered as a floating card */
function DimensionFormCard({
  Icon,
  labels,
  records,
  initialData,
  parentId,
  onSubmit,
  onCancel,
  onDeactivate,
  isActive = true,
  isLoading = false,
}: {
  Icon: React.ComponentType<{ size?: number }>;
  labels: DimensionLabels;
  records: DimensionRecord[];
  initialData?: DimensionRecord;
  parentId?: string;
  onSubmit: (data: { name: string; description?: string; parentId?: string | null }) => void;
  onCancel: () => void;
  onDeactivate?: () => void;
  isActive?: boolean;
  isLoading?: boolean;
}) {
  const isEdit = !!initialData;
  const [name, setName] = useState(initialData?.name ?? "");
  const [description, setDescription] = useState(initialData?.description ?? "");
  const [selectedParentId, setSelectedParentId] = useState<string>(
    initialData?.parentId ?? parentId ?? "",
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    onSubmit({
      name: name.trim(),
      description: description.trim() || undefined,
      parentId: selectedParentId || null,
    });
  };

  // Parent picker
  const parentOptions = records.filter((d) => d.isActive);

  return (
    <div className="bg-[var(--color-app-card)] rounded-2xl shadow-[0_4px_24px_rgba(0,0,0,0.08)] overflow-hidden w-full lg:w-[340px] lg:shrink-0 flex flex-col">
      {/* Teal header */}
      <div className="bg-[var(--color-app-header-teal)] text-white px-5 py-4 flex items-center gap-3 font-semibold text-base">
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          {isEdit ? (
            <>
              <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
              <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
            </>
          ) : (
            <>
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </>
          )}
        </svg>
        <span>{isEdit ? labels.editEntity : labels.newEntity}</span>
      </div>

      {/* Form */}
      <form onSubmit={handleSubmit} className="flex-1 flex flex-col p-5">
        <div className="space-y-5 flex-1">
          {/* Parent */}
          <div>
            <label className="block text-[11px] font-semibold text-[var(--color-app-text-light)] uppercase tracking-wider mb-1.5">
              {labels.parentLabel}
            </label>
            <ParentPicker
              Icon={Icon}
              value={selectedParentId}
              onChange={setSelectedParentId}
              parents={parentOptions}
            />
          </div>

          {/* Name */}
          <div>
            <label className="block text-[11px] font-semibold text-[var(--color-app-text-light)] uppercase tracking-wider mb-1.5">
              {labels.nameLabel}
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={labels.namePlaceholder}
              required
              className="w-full px-3 py-2.5 rounded-lg text-base md:text-sm bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-600 text-[var(--color-app-text-navy)] placeholder:text-[var(--color-app-text-light)] focus:outline-none focus:ring-2 focus:ring-[var(--color-app-header-teal)]/30 focus:border-[var(--color-app-header-teal)] transition-colors"
            />
          </div>

          {/* Description */}
          <div>
            <label className="block text-[11px] font-semibold text-[var(--color-app-text-light)] uppercase tracking-wider mb-1.5">
              Description (Optional)
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Enter a description…"
              rows={4}
              className="w-full px-3 py-2.5 rounded-lg text-base md:text-sm bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-600 text-[var(--color-app-text-navy)] placeholder:text-[var(--color-app-text-light)] focus:outline-none focus:ring-2 focus:ring-[var(--color-app-header-teal)]/30 focus:border-[var(--color-app-header-teal)] transition-colors resize-y"
            />
          </div>

          {/* Deactivate toggle (edit mode only) */}
          {isEdit && onDeactivate && (
            <button
              type="button"
              onClick={onDeactivate}
              className="w-full py-2.5 rounded-lg text-sm font-medium border cursor-pointer transition-colors bg-[#fef3cd] border-[#fceabb] text-[#856404] hover:bg-[#fce8a1]"
            >
              {isActive ? labels.deactivateEntity : labels.reactivateEntity}
            </button>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 pt-5 mt-5 border-t border-gray-200 dark:border-slate-700">
          <button
            type="button"
            onClick={onCancel}
            className="px-5 py-2.5 rounded-lg text-sm font-medium text-[var(--color-app-text-navy)] bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-600 hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors cursor-pointer"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!name.trim() || isLoading}
            className="px-5 py-2.5 rounded-lg text-sm font-semibold text-white bg-[var(--color-app-header-teal)] shadow-sm hover:shadow-md transition-all cursor-pointer border-none disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isLoading ? (isEdit ? "Saving…" : "Creating…") : "Save"}
          </button>
        </div>
      </form>
    </div>
  );
}

/** Empty state card — shown when nothing is selected */
function DimensionEmptyCard({
  Icon,
  labels,
}: {
  Icon: React.ComponentType<{ size?: number }>;
  labels: DimensionLabels;
}) {
  return (
    <div className="bg-[var(--color-app-card)] rounded-2xl shadow-[0_4px_24px_rgba(0,0,0,0.08)] overflow-hidden w-full lg:w-[340px] lg:shrink-0 min-h-[300px] flex flex-col items-center justify-center p-8 text-center">
      <div className="w-16 h-16 rounded-2xl bg-[#e8f5f0] dark:bg-teal-900/30 flex items-center justify-center text-[var(--color-app-header-teal)] mb-4">
        <Icon size={32} />
      </div>
      <p className="text-sm font-medium text-[var(--color-app-text-navy)]">{labels.selectPrompt}</p>
      <p className="text-xs text-[var(--color-app-text-light)] mt-1">{labels.selectHint}</p>
    </div>
  );
}

// ============================================================================
// Parent Picker — dropdown with icon, for reference
// ============================================================================

function ParentPicker({
  Icon,
  value,
  onChange,
  parents,
}: {
  Icon: React.ComponentType<{ size?: number }>;
  value: string;
  onChange: (val: string) => void;
  parents: DimensionRecord[];
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const selected = parents.find((p) => p.id === value);
  const rootLabel = "None (root)";

  return (
    <div ref={containerRef} style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2.5 w-full px-3 py-2.5 text-sm border border-gray-200 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 text-[var(--color-app-text-navy)] transition-all cursor-pointer justify-between"
      >
        <span className="flex items-center gap-2 truncate">
          <span className="w-6 h-6 rounded-md bg-[#e8f5f0] dark:bg-teal-900/30 flex items-center justify-center text-[var(--color-app-header-teal)] shrink-0">
            <Icon size={12} />
          </span>
          <span>{selected ? selected.name : rootLabel}</span>
        </span>
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          style={{ flexShrink: 0, opacity: 0.4 }}
        >
          <path d={open ? "M18 15l-6-6-6 6" : "M6 9l6 6 6-6"} />
        </svg>
      </button>

      {open && (
        <div
          className="absolute z-50 mt-1 w-full bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-xl overflow-hidden"
          style={{ boxShadow: "0 8px 32px rgba(0,0,0,0.12), 0 2px 8px rgba(0,0,0,0.06)" }}
        >
          <div style={{ maxHeight: 280, overflowY: "auto" }}>
            {/* Root option */}
            <button
              type="button"
              onClick={() => {
                onChange("");
                setOpen(false);
              }}
              className={`flex items-center gap-3 w-full px-4 py-2.5 text-sm transition-colors cursor-pointer border-none ${
                !value
                  ? "text-[var(--color-app-header-teal)] bg-teal-50 dark:bg-teal-900/30"
                  : "text-[var(--color-app-text-navy)] hover:bg-slate-50 dark:hover:bg-slate-700"
              }`}
            >
              <span className="w-6 h-6 rounded-md bg-[#e8f5f0] dark:bg-teal-900/30 flex items-center justify-center text-[var(--color-app-header-teal)] shrink-0">
                <Icon size={12} />
              </span>
              <span className="flex-1 text-left truncate">{rootLabel}</span>
              {!value && (
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  style={{ opacity: 0.6 }}
                >
                  <path d="M20 6L9 17l-5-5" />
                </svg>
              )}
            </button>

            {/* Parent options */}
            {parents.map((p) => {
              const isSelected = p.id === value;
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => {
                    onChange(p.id);
                    setOpen(false);
                  }}
                  className={`flex items-center gap-3 w-full px-4 py-2.5 text-sm transition-colors cursor-pointer border-none ${
                    isSelected
                      ? "text-[var(--color-app-header-teal)] bg-teal-50 dark:bg-teal-900/30"
                      : "text-[var(--color-app-text-navy)] hover:bg-slate-50 dark:hover:bg-slate-700"
                  }`}
                >
                  <span className="w-6 h-6 rounded-md bg-[#e8f5f0] dark:bg-teal-900/30 flex items-center justify-center text-[var(--color-app-header-teal)] shrink-0">
                    <Icon size={12} />
                  </span>
                  <span className="flex-1 text-left truncate">{p.name}</span>
                  {isSelected && (
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      style={{ opacity: 0.6 }}
                    >
                      <path d="M20 6L9 17l-5-5" />
                    </svg>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Loading Skeleton
// ============================================================================

function DimensionListSkeleton() {
  return (
    <div className="p-3 space-y-2">
      {[1, 2, 3, 4].map((i) => (
        <div key={i} className="flex items-center gap-3 p-3 rounded-lg animate-pulse">
          <div className="w-7 h-7 rounded-md bg-gray-200 dark:bg-slate-700" />
          <div className="flex-1">
            <div className="h-3.5 w-28 rounded bg-gray-200 dark:bg-slate-700 mb-1" />
          </div>
        </div>
      ))}
    </div>
  );
}
