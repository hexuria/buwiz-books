/**
 * Generic two-panel entity list page (list + detail/create). Renders the customers/vendors/
 * employees/government/lenders/shareholders pages from a single implementation — the six
 * routes differ only by the EntityConfig they pass in.
 *
 * Route-specific hooks (useSearch/useNavigate) stay in each route file and are passed down,
 * so this component stays route-agnostic and fully typed.
 */
import { useQuery } from "@tanstack/react-query";
import { useState, useMemo, useRef, type ReactNode } from "react";
import { listParties } from "../../routes/api/-parties";
import type { PartyRecord } from "../../routes/api/-parties";
import { keys } from "../../lib/query-keys";
import { PartyCard } from "./PartyCard";
import { PartyDetailPanel } from "./PartyDetailPanel";
import { PartyCreateForm } from "./PartyCreateForm";
import {
  StatusFilterPopover,
  StatusFilterChip,
  type StatusFilterValue,
} from "../accounts/StatusFilterPopover";
import { EntitySplitLayout } from "../layouts/EntitySplitLayout";
import { FilterBar } from "../ui/Actions";
import { useIsMobile } from "../../hooks/useBreakpoint";
import type { EntityConfig } from "./entity-configs";

export interface EntitySearch {
  selected?: string;
  mode?: string; // "new" | "edit"
  status?: string; // "active" | "deactivated"
}

/** Shared validateSearch for every entity route. */
export function validateEntitySearch(search: Record<string, unknown>): EntitySearch {
  return {
    selected: (search.selected as string) || undefined,
    mode: (search.mode as string) || undefined,
    status: (search.status as string) || undefined,
  };
}

type SortKey = "name" | "recent";
type SortDir = "asc" | "desc";

/**
 * Mirrors the desktop `StatusFilterPopover` options. There is deliberately no "All" row: clearing
 * the status routes back to `active` (see `setStatusFilter`), so an unfiltered state is not
 * reachable here and offering it would lie about the result.
 */
const STATUS_CHOICES: Array<{ value: Exclude<StatusFilterValue, null>; label: string }> = [
  { value: "active", label: "Active" },
  { value: "deactivated", label: "Inactive" },
];

function sortParties(parties: PartyRecord[], sortBy: SortKey, sortDir: SortDir): PartyRecord[] {
  const dir = sortDir === "asc" ? 1 : -1;
  return [...parties].sort((a, b) => {
    if (sortBy === "recent") {
      return dir * (new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    }
    return dir * a.name.localeCompare(b.name);
  });
}

function Icon({
  paths,
  size,
  stroke,
  className,
}: {
  paths: ReactNode;
  size: number;
  stroke: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      {paths}
    </svg>
  );
}

interface EntityListPageProps {
  config: EntityConfig;
  search: EntitySearch;
  navigate: (search: EntitySearch) => void;
}

export function EntityListPage({ config, search, navigate }: EntityListPageProps) {
  const { partyType, titlePlural, titleSingular, newLabel, iconPaths, queryLimit } = config;
  const lowerSingular = titleSingular.toLowerCase();
  const lowerPlural = config.emptyPlural ?? titlePlural.toLowerCase();
  const addFirstLabel = config.addFirstLabel ?? `Add your first ${lowerSingular}`;

  const isMobile = useIsMobile();
  const [searchTerm, setSearchTerm] = useState("");
  const [sortBy, setSortBy] = useState<SortKey>("name");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const handleSortToggle = (key: SortKey) => {
    if (sortBy === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortBy(key);
      setSortDir("asc");
    }
  };
  const [filterOpen, setFilterOpen] = useState(false);
  const filterBtnRef = useRef<HTMLButtonElement>(null);

  const statusFilter: StatusFilterValue = (search.status as StatusFilterValue) ?? "active";
  const setStatusFilter = (next: StatusFilterValue) => {
    navigate({ ...search, status: next === "active" ? undefined : (next ?? undefined) });
  };

  const { data: records = [], isLoading } = useQuery({
    queryKey: keys.parties.list(partyType, { limit: queryLimit }),
    queryFn: () =>
      (listParties as (opts: { data: unknown }) => Promise<PartyRecord[]>)({
        data: {
          type: partyType,
          includeInactive: true,
          ...(queryLimit ? { limit: queryLimit } : {}),
        },
      }),
  });

  const filtered = useMemo(() => {
    let results = records;
    if (statusFilter === "active") results = results.filter((v) => v.isActive);
    else if (statusFilter === "deactivated") results = results.filter((v) => !v.isActive);

    if (searchTerm.trim()) {
      const q = searchTerm.toLowerCase();
      results = results.filter(
        (v) => v.name.toLowerCase().includes(q) || (v.email && v.email.toLowerCase().includes(q)),
      );
    }
    return sortParties(results, sortBy, sortDir);
  }, [records, searchTerm, sortBy, sortDir, statusFilter]);

  const selected =
    filtered.find((v) => v.id === search.selected) || records.find((v) => v.id === search.selected);
  const isNewMode = search.mode === "new";
  const isEditMode = search.mode === "edit" && selected;
  const showDetail = search.selected && !isEditMode;

  return (
    <EntitySplitLayout
      fullscreen={isNewMode}
      header={
        <div className="flex items-center justify-between gap-3 px-4 py-4 md:px-8 md:py-5 border-b border-[#e2e8f0] dark:border-white/10">
          <div className="flex min-w-0 items-center gap-3">
            <Icon paths={iconPaths} size={24} stroke={1.5} className="shrink-0 text-[#10b981]" />
            <h1 className="truncate text-lg sm:text-xl font-semibold text-[#1e293b] dark:text-white">
              {titlePlural}
            </h1>
            <span className="ml-1 shrink-0 px-2 py-0.5 rounded-full text-xs font-medium bg-[#e2e8f0] dark:bg-white/10 text-[#64748b] dark:text-white/50">
              {filtered.length}
            </span>
          </div>
          {/* `newLabel` is per-entity ("New Shareholder", "New Government Agency") and cannot be
              sized for, so below `sm` it is the icon that stays and the label that goes. */}
          <button
            type="button"
            aria-label={newLabel}
            title={newLabel}
            onClick={() => navigate({ ...search, mode: "new", selected: undefined })}
            className="flex shrink-0 items-center justify-center gap-2 h-11 w-11 px-0 sm:h-9 sm:w-auto sm:px-4 rounded-lg bg-gradient-to-r from-[#10b981] to-[#059669] text-white text-sm font-medium shadow-sm hover:shadow-md transition-all"
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
              className="shrink-0"
            >
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            <span className="hidden sm:inline whitespace-nowrap">{newLabel}</span>
          </button>
        </div>
      }
      sidebar={
        <>
          {isMobile ? (
            /* Below `md` the icon-filter + chip + search + Clear row cannot hold four controls at
               a tappable size, and the sort pills are 20px tall. Search stays; status and sort
               move into the FilterBar sheet. */
            <div className="px-4 py-3 border-b border-[#e2e8f0] dark:border-white/10">
              <FilterBar
                activeCount={statusFilter ? 1 : 0}
                trailing={
                  <input
                    type="text"
                    className="flex-1 min-w-0 h-11 px-3 rounded-lg border border-[#e2e8f0] dark:border-white/10 bg-white dark:bg-[#0f172a] outline-none text-base text-[var(--color-app-text-navy)] dark:text-white placeholder:text-[var(--color-app-text-light)] dark:placeholder:text-white/30 focus:ring-2 focus:ring-[#10b981]/20"
                    placeholder="Search for…"
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                  />
                }
              >
                <fieldset className="flex flex-col gap-1">
                  <legend className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-[#94a3b8] dark:text-white/40">
                    Status
                  </legend>
                  {STATUS_CHOICES.map((choice) => (
                    <button
                      key={choice.label}
                      type="button"
                      onClick={() =>
                        setStatusFilter(statusFilter === choice.value ? null : choice.value)
                      }
                      aria-pressed={statusFilter === choice.value}
                      className={`flex min-h-12 w-full items-center justify-between rounded-lg px-3 text-left text-sm font-medium transition-colors ${
                        statusFilter === choice.value
                          ? "bg-[#10b981]/10 text-[#10b981] dark:text-[#34d399]"
                          : "text-[#64748b] dark:text-white/50"
                      }`}
                    >
                      {choice.label}
                      {statusFilter === choice.value && (
                        <svg
                          width="16"
                          height="16"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      )}
                    </button>
                  ))}
                </fieldset>

                <fieldset className="flex flex-col gap-1">
                  <legend className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-[#94a3b8] dark:text-white/40">
                    Sort
                  </legend>
                  {(["name", "recent"] as SortKey[]).map((key) => {
                    const isActive = sortBy === key;
                    const field = key === "name" ? "Name" : "Last updated";
                    let direction: string;
                    if (key === "name") direction = isActive && sortDir === "desc" ? "Z–A" : "A–Z";
                    else direction = isActive && sortDir === "desc" ? "Oldest" : "Recent";
                    return (
                      <button
                        key={key}
                        type="button"
                        onClick={() => handleSortToggle(key)}
                        aria-pressed={isActive}
                        className={`flex min-h-12 w-full items-center justify-between rounded-lg px-3 text-left text-sm font-medium transition-colors ${
                          isActive
                            ? "bg-[#10b981]/10 text-[#10b981] dark:text-[#34d399]"
                            : "text-[#64748b] dark:text-white/50"
                        }`}
                      >
                        {field}
                        <span className="text-xs font-semibold">{direction}</span>
                      </button>
                    );
                  })}
                </fieldset>
              </FilterBar>
            </div>
          ) : (
            <div className="px-4 py-3 border-b border-[#e2e8f0] dark:border-white/10">
              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  ref={filterBtnRef}
                  type="button"
                  onClick={() => setFilterOpen(!filterOpen)}
                  className={`touch-target flex items-center p-1.5 rounded-md border-none cursor-pointer transition-colors ${
                    filterOpen
                      ? "bg-teal-50 text-teal-600"
                      : "bg-transparent text-slate-500 hover:text-teal-600"
                  }`}
                  aria-label="Filters"
                  aria-expanded={filterOpen}
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
                <StatusFilterChip status={statusFilter} onClear={() => setStatusFilter(null)} />
                <input
                  type="text"
                  className="flex-1 min-w-[100px] border-none outline-none text-base sm:text-sm text-[var(--color-app-text-navy)] dark:text-white bg-transparent placeholder:text-[var(--color-app-text-light)] dark:placeholder:text-white/30"
                  placeholder="Search for…"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                />
                {statusFilter && (
                  <button
                    type="button"
                    onClick={() => setStatusFilter(null)}
                    className="bg-transparent border-none cursor-pointer text-teal-600 font-semibold text-xs whitespace-nowrap hover:text-teal-700 transition-colors"
                  >
                    Clear
                  </button>
                )}
              </div>

              <StatusFilterPopover
                open={filterOpen}
                onClose={() => setFilterOpen(false)}
                status={statusFilter}
                onChange={setStatusFilter}
                anchorRef={filterBtnRef}
              />

              <div className="flex items-center gap-2 mt-2">
                <span className="text-[10px] font-semibold text-[#94a3b8] dark:text-white/40 uppercase tracking-wider">
                  Sort:
                </span>
                {(["name", "recent"] as SortKey[]).map((key) => {
                  const isActive = sortBy === key;
                  let label: string;
                  if (key === "name") label = isActive && sortDir === "desc" ? "Z–A" : "A–Z";
                  else label = isActive && sortDir === "desc" ? "Oldest" : "Recent";
                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() => handleSortToggle(key)}
                      className={`px-2 py-0.5 rounded text-[11px] font-medium transition-colors ${
                        isActive
                          ? "bg-[#10b981]/10 text-[#10b981] dark:text-[#34d399]"
                          : "text-[#94a3b8] dark:text-white/40 hover:text-[#64748b] dark:hover:text-white/60"
                      }`}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <div className="flex-1 overflow-y-auto p-3 space-y-2">
            {isLoading ? (
              <EntityListSkeleton />
            ) : filtered.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-center">
                <Icon
                  paths={iconPaths}
                  size={48}
                  stroke={1}
                  className="text-[#e2e8f0] dark:text-white/10 mb-3"
                />
                <p className="text-sm font-medium text-[#94a3b8] dark:text-white/40">
                  {searchTerm
                    ? `No ${lowerPlural} match your search`
                    : statusFilter === "deactivated"
                      ? `No inactive ${lowerPlural}`
                      : `No ${lowerPlural} yet`}
                </p>
                {!searchTerm && statusFilter !== "deactivated" && (
                  <button
                    type="button"
                    onClick={() => navigate({ ...search, mode: "new", selected: undefined })}
                    className="mt-2 inline-flex min-h-11 items-center px-3 text-sm text-[#10b981] hover:underline font-medium"
                  >
                    {addFirstLabel}
                  </button>
                )}
              </div>
            ) : (
              filtered.map((record) => (
                <PartyCard
                  key={record.id}
                  party={record}
                  isSelected={record.id === search.selected}
                  onClick={() =>
                    navigate({
                      ...search,
                      selected: record.id === search.selected ? undefined : record.id,
                      mode: undefined,
                    })
                  }
                />
              ))
            )}
          </div>
        </>
      }
      content={(isSidebarOpen) =>
        isNewMode ? (
          <PartyCreateForm
            partyType={partyType}
            onClose={() => navigate({ status: search.status })}
          />
        ) : isEditMode && selected ? (
          <PartyCreateForm
            partyType={partyType}
            initialData={selected}
            onClose={() => navigate({ ...search, selected: selected.id, mode: undefined })}
          />
        ) : showDetail && search.selected ? (
          <PartyDetailPanel
            partyId={search.selected}
            onEdit={() => navigate({ ...search, selected: search.selected, mode: "edit" })}
            onDeleted={() => navigate({ status: search.status })}
          />
        ) : (
          <div className="flex-1 flex flex-col">
            <div className="shrink-0 border-b border-[#e2e8f0] dark:border-white/10 h-[52px]" />
            <div className="flex-1 flex items-center justify-center">
              <div className="text-center">
                <Icon
                  paths={iconPaths}
                  size={64}
                  stroke={0.75}
                  className="mx-auto text-[#e2e8f0] dark:text-white/10 mb-4"
                />
                <p className="text-base text-[#94a3b8] dark:text-white/40 font-medium">
                  {isSidebarOpen
                    ? `Select a ${lowerSingular} to view details`
                    : `Toggle the sidebar to browse ${lowerPlural}`}
                </p>
                <p className="text-sm text-[#cbd5e1] dark:text-white/20 mt-1">
                  {isSidebarOpen
                    ? `Or click "New ${titleSingular}" to add one`
                    : `Or click "New ${titleSingular}" to create one`}
                </p>
              </div>
            </div>
          </div>
        )
      }
    />
  );
}

function EntityListSkeleton() {
  return (
    <>
      {[1, 2, 3, 4, 5].map((i) => (
        <div
          key={i}
          className="p-3.5 rounded-xl border border-[#e2e8f0] dark:border-white/8 bg-white dark:bg-[#15192a] animate-pulse"
        >
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-full bg-[#e2e8f0] dark:bg-white/10" />
            <div className="flex-1">
              <div className="h-3.5 w-28 rounded bg-[#e2e8f0] dark:bg-white/10 mb-1.5" />
              <div className="h-2.5 w-36 rounded bg-[#e2e8f0] dark:bg-white/10" />
            </div>
          </div>
        </div>
      ))}
    </>
  );
}
