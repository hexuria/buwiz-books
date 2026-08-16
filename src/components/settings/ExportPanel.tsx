/**
 * ExportPanel — Entity selector with cherry-pick drill-down and download
 * Supports all 16 entity types in the v2 versioned export format.
 */
import { useState, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { exportData, listExportableRecords } from "../../routes/api/-export-import";
import type { EntityType } from "../../routes/api/-export-import";
import { ENTITY_LABELS } from "../../lib/export-versions";
import type { ExportableEntity } from "../../lib/export-versions";

// ============================================================================
// Constants
// ============================================================================

const ENTITY_ICONS: Record<string, string> = {
  banks: "M3 21h18M3 10h18M5 6l7-3 7 3M4 10v11M20 10v11M8 14v3M12 14v3M16 14v3",
  vendors:
    "M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 7a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75",
  customers: "M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 7a4 4 0 1 0 0-8 4 4 0 0 0 0 8z",
  employees: "M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M8.5 7a4 4 0 1 0 0-8 4 4 0 0 0 0 8z",
  shareholders: "M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5",
  lenders: "M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6",
  government: "M3 21h18M3 10h18M5 6l7-3 7 3M4 10v11M8 10v11M12 10v11M16 10v11M20 10v11",
  categories:
    "M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2M9 5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2M9 5h6M9 14h.01M13 14h2M9 11h.01M13 11h2M9 17h.01M13 17h2",
  departments: "M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z",
  locations: "M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0zM12 7a3 3 0 1 0 0 6 3 3 0 0 0 0-6z",
  products: "M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z",
  transactions:
    "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M16 13H8M16 17H8M10 9H8",
  bills:
    "M9 17H5a2 2 0 0 0-2 2 2 2 0 0 0 2 2h2a2 2 0 0 0 2-2zm12-2h-4a2 2 0 0 0-2 2 2 2 0 0 0 2 2h2a2 2 0 0 0 2-2zM5 7l4-4 4 4",
  invoices:
    "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M12 18v-6M9 15l3 3 3-3",
  numberSequences: "M4 9h16M4 15h16M10 3L8 21M16 3l-2 18",
  orgSettings: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z",
};

/** Entity keys shown in the UI — excludes numberSequences and orgSettings which have no cherry-pick */
const CHERRY_PICKABLE: EntityType[] = [
  "categories",
  "departments",
  "locations",
  "products",
  "vendors",
  "customers",
  "employees",
  "shareholders",
  "lenders",
  "government",
  "banks",
  "transactions",
  "bills",
  "invoices",
];

const ALL_ENTITY_KEYS: EntityType[] = [...CHERRY_PICKABLE, "numberSequences", "orgSettings"];

// ============================================================================
// Component
// ============================================================================

export function ExportPanel() {
  const [selectedEntities, setSelectedEntities] = useState<Set<EntityType>>(
    new Set(CHERRY_PICKABLE),
  );
  const [selectedIds, setSelectedIds] = useState<Record<string, Set<string>>>({});
  const [expandedEntity, setExpandedEntity] = useState<EntityType | null>(null);
  const [format, setFormat] = useState<"json" | "csv">("json");
  const [includeInactive, setIncludeInactive] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");

  // Fetch records for cherry-pick when expanded
  const { data: expandedRecords = [], isLoading: loadingRecords } = useQuery({
    queryKey: ["exportable-records", expandedEntity, includeInactive],
    queryFn: () =>
      (
        listExportableRecords as (opts: {
          data: unknown;
        }) => Promise<
          Array<{ id: string; name: string; subtitle: string | null; extra: string | null }>
        >
      )({ data: { entityType: expandedEntity, includeInactive } }),
    enabled: !!expandedEntity,
  });

  // Fetch counts for each cherry-pickable entity
  const countQueries: Record<string, ReturnType<typeof useQuery>> = {};
  for (const key of CHERRY_PICKABLE) {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    countQueries[key] = useQuery({
      queryKey: ["exportable-records", key, includeInactive],
      queryFn: () =>
        (
          listExportableRecords as (opts: {
            data: unknown;
          }) => Promise<Array<{ id: string; name: string }>>
        )({ data: { entityType: key, includeInactive } }),
    });
  }

  const entityCounts: Record<string, number> = {};
  for (const key of CHERRY_PICKABLE) {
    entityCounts[key] = (countQueries[key]?.data as Array<unknown> | undefined)?.length ?? 0;
  }

  // Export mutation
  const exportMutation = useMutation({
    mutationFn: async () => {
      const entitiesToExport = Array.from(selectedEntities).filter((entity) => {
        const picked = selectedIds[entity];
        return picked === undefined || picked.size > 0;
      });
      if (entitiesToExport.length === 0) throw new Error("No records selected");

      const ids: Record<string, string[]> = {};
      for (const entity of entitiesToExport) {
        const picked = selectedIds[entity];
        if (picked && picked.size > 0) ids[entity] = Array.from(picked);
      }

      return await (exportData as (opts: { data: unknown }) => Promise<any>)({
        data: {
          entities: entitiesToExport,
          ids: Object.keys(ids).length > 0 ? ids : undefined,
          includeInactive,
        },
      });
    },
    onSuccess: (data) => {
      let blob: Blob;
      let filename: string;

      if (format === "json") {
        blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
        filename = `export-${new Date().toISOString().split("T")[0]}.json`;
      } else {
        const sections: string[] = [];
        const entities = data.data || data.entities || {};
        for (const [entity, rows] of Object.entries(entities)) {
          const arr = Array.isArray(rows) ? rows : [];
          if (!arr.length) continue;
          const headers = Object.keys(arr[0] as Record<string, any>);
          const csvRows = [headers.join(",")];
          for (const row of arr) {
            const r = row as Record<string, any>;
            csvRows.push(
              headers
                .map((h) => {
                  const val = r[h];
                  if (val === null || val === undefined) return "";
                  const str = typeof val === "object" ? JSON.stringify(val) : String(val);
                  return str.includes(",") || str.includes('"') || str.includes("\n")
                    ? `"${str.replace(/"/g, '""')}"`
                    : str;
                })
                .join(","),
            );
          }
          sections.push(`--- ${entity.toUpperCase()} ---\n${csvRows.join("\n")}`);
        }
        blob = new Blob([sections.join("\n\n")], { type: "text/csv" });
        filename = `export-${new Date().toISOString().split("T")[0]}.csv`;
      }

      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    },
  });

  // Filtered records for drill-down
  const filteredRecords = useMemo(() => {
    if (!searchTerm.trim()) return expandedRecords;
    const q = searchTerm.toLowerCase();
    return expandedRecords.filter(
      (r) =>
        r.name?.toLowerCase().includes(q) ||
        (r.subtitle && r.subtitle.toLowerCase().includes(q)) ||
        (r.extra && r.extra.toLowerCase().includes(q)),
    );
  }, [expandedRecords, searchTerm]);

  // Toggle helpers
  const toggleEntity = (key: EntityType) => {
    const next = new Set(selectedEntities);
    if (next.has(key)) {
      next.delete(key);
      const nextIds = { ...selectedIds };
      delete nextIds[key];
      setSelectedIds(nextIds);
    } else {
      next.add(key);
      const nextIds = { ...selectedIds };
      delete nextIds[key];
      setSelectedIds(nextIds);
    }
    setSelectedEntities(next);
  };

  const toggleRecord = (entity: EntityType, id: string) => {
    let current = selectedIds[entity];
    if (current === undefined) {
      current = new Set(expandedRecords.map((r) => r.id));
    }
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else next.add(id);

    if (expandedRecords.length > 0 && next.size === expandedRecords.length) {
      const nextIds = { ...selectedIds };
      delete nextIds[entity];
      setSelectedIds(nextIds);
    } else {
      setSelectedIds({ ...selectedIds, [entity]: next });
    }
  };

  const selectAllRecords = (entity: EntityType) => {
    const nextIds = { ...selectedIds };
    delete nextIds[entity];
    setSelectedIds(nextIds);
  };

  const deselectAllRecords = (entity: EntityType) => {
    setSelectedIds({ ...selectedIds, [entity]: new Set() });
  };

  const isRecordSelected = (entity: EntityType, id: string) => {
    const picked = selectedIds[entity];
    if (picked === undefined) return true;
    return picked.has(id);
  };

  const hasCustomSelection = (entity: EntityType) => selectedIds[entity] !== undefined;

  const getSelectedCount = (entity: EntityType): number => {
    const picked = selectedIds[entity];
    if (picked === undefined) return entityCounts[entity] ?? 0;
    return picked.size;
  };

  // ── Drill-down view ──────────────────────────────────────────────────────
  if (expandedEntity) {
    const label = ENTITY_LABELS[expandedEntity as ExportableEntity] ?? expandedEntity;

    return (
      <div className="space-y-5">
        <button
          type="button"
          onClick={() => {
            setExpandedEntity(null);
            setSearchTerm("");
          }}
          className="flex items-center gap-1.5 text-sm text-[#0d9488] hover:text-[#0f766e] dark:text-teal-400 dark:hover:text-teal-300 font-medium transition-colors"
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
            <polyline points="15 18 9 12 15 6" />
          </svg>
          Back to entities
        </button>

        <section className="bg-white dark:bg-[#1e293b] rounded-2xl border border-[#e2e8f0] dark:border-white/10 p-6 space-y-4">
          <h3 className="text-sm font-semibold text-[#1e293b] dark:text-white">
            Select {label} to Export
          </h3>
          <div className="relative">
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="absolute left-3 top-1/2 -translate-y-1/2 text-[#94a3b8] dark:text-white/30"
            >
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              type="text"
              placeholder={`Search ${label.toLowerCase()}...`}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pl-9 pr-3 py-2 rounded-lg text-base sm:text-sm bg-[#f8fafc] dark:bg-[#0f172a] border border-[#e2e8f0] dark:border-white/10 text-[#1e293b] dark:text-white placeholder-[#94a3b8] dark:placeholder-white/30 focus:outline-none focus:ring-2 focus:ring-[#0d9488]/30 focus:border-[#0d9488] transition-colors"
            />
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => selectAllRecords(expandedEntity)}
              className="text-xs font-medium text-[#0d9488] hover:text-[#0f766e] dark:text-teal-400 transition-colors"
            >
              Select All ({expandedRecords.length})
            </button>
            <span className="text-[#e2e8f0] dark:text-white/10">|</span>
            <button
              type="button"
              onClick={() => deselectAllRecords(expandedEntity)}
              className="text-xs font-medium text-[#64748b] hover:text-[#1e293b] dark:text-white/50 dark:hover:text-white transition-colors"
            >
              Deselect All
            </button>
          </div>
          <div className="max-h-[400px] overflow-y-auto space-y-1 pr-1">
            {loadingRecords ? (
              ["a", "b", "c", "d", "e"].map((k) => (
                <div key={k} className="flex items-center gap-3 p-2.5 animate-pulse">
                  <div className="w-4 h-4 rounded bg-[#e2e8f0] dark:bg-white/10" />
                  <div className="h-3.5 w-40 rounded bg-[#e2e8f0] dark:bg-white/10" />
                </div>
              ))
            ) : filteredRecords.length === 0 ? (
              <div className="text-center py-8 text-sm text-[#94a3b8] dark:text-white/40">
                {searchTerm ? "No records match your search" : "No records found"}
              </div>
            ) : (
              filteredRecords.map((record) => (
                <label
                  key={record.id}
                  className="flex items-center gap-3 p-2.5 rounded-lg hover:bg-[#f8fafc] dark:hover:bg-white/[0.02] cursor-pointer transition-colors"
                >
                  <input
                    type="checkbox"
                    checked={isRecordSelected(expandedEntity, record.id)}
                    onChange={() => toggleRecord(expandedEntity, record.id)}
                    className="w-4 h-4 rounded border-[#d1d5db] dark:border-white/20 accent-[#0d9488] cursor-pointer"
                  />
                  <div className="flex-1 min-w-0">
                    <span className="text-sm font-medium text-[#1e293b] dark:text-white truncate block">
                      {record.name}
                    </span>
                    {(record.subtitle || record.extra) && (
                      <span className="text-xs text-[#94a3b8] dark:text-white/40 truncate block">
                        {[record.subtitle, record.extra && `(${record.extra})`]
                          .filter(Boolean)
                          .join(" ")}
                      </span>
                    )}
                  </div>
                </label>
              ))
            )}
          </div>
          <div className="flex justify-end pt-2">
            <button
              type="button"
              onClick={() => {
                setExpandedEntity(null);
                setSearchTerm("");
              }}
              className="px-4 py-2 rounded-lg bg-[#0d9488] hover:bg-[#0f766e] text-white text-sm font-medium transition-all"
            >
              Done
            </button>
          </div>
        </section>
      </div>
    );
  }

  // ── Main export view ──────────────────────────────────────────────────────
  return (
    <div className="space-y-5">
      <section className="bg-white dark:bg-[#1e293b] rounded-2xl border border-[#e2e8f0] dark:border-white/10 p-6 space-y-5">
        <h3 className="text-sm font-semibold text-[#1e293b] dark:text-white flex items-center gap-2">
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="text-[#0d9488]"
          >
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
          Select Data to Export
        </h3>

        {/* Format + Include inactive */}
        <div className="flex flex-wrap items-center gap-5">
          <div className="flex items-center gap-3">
            <span className="text-xs font-medium text-[#64748b] dark:text-white/50">Format:</span>
            {(["json", "csv"] as const).map((f) => (
              <label key={f} className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="radio"
                  name="export-format"
                  value={f}
                  checked={format === f}
                  onChange={() => setFormat(f)}
                  className="w-3.5 h-3.5 accent-[#0d9488] cursor-pointer"
                />
                <span className="text-xs font-medium text-[#1e293b] dark:text-white uppercase">
                  {f}
                </span>
              </label>
            ))}
          </div>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={includeInactive}
              onChange={(e) => setIncludeInactive(e.target.checked)}
              className="w-3.5 h-3.5 rounded border-[#d1d5db] dark:border-white/20 accent-[#0d9488] cursor-pointer"
            />
            <span className="text-xs font-medium text-[#64748b] dark:text-white/50">
              Include inactive records
            </span>
          </label>
        </div>

        {/* Entity checklist */}
        <div className="border border-[#e2e8f0] dark:border-white/10 rounded-xl overflow-hidden divide-y divide-[#e2e8f0] dark:divide-white/10">
          {ALL_ENTITY_KEYS.map((key) => {
            const label = ENTITY_LABELS[key as ExportableEntity] ?? key;
            const icon = ENTITY_ICONS[key] ?? "";
            const isCherryPickable = CHERRY_PICKABLE.includes(key);
            const count = entityCounts[key] ?? 0;
            const isChecked = selectedEntities.has(key);
            const customized = hasCustomSelection(key);
            const selectedCount = getSelectedCount(key);

            return (
              <div
                key={key}
                className="flex items-center gap-3 px-4 py-3 hover:bg-[#f8fafc] dark:hover:bg-white/[0.02] transition-colors"
              >
                <input
                  type="checkbox"
                  checked={isChecked}
                  onChange={() => toggleEntity(key)}
                  className="w-4 h-4 rounded border-[#d1d5db] dark:border-white/20 accent-[#0d9488] cursor-pointer"
                />
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="text-[#64748b] dark:text-white/50 shrink-0"
                >
                  <path d={icon} />
                </svg>
                <span className="flex-1 text-sm font-medium text-[#1e293b] dark:text-white">
                  {label}
                </span>
                {isCherryPickable && (
                  <span className="text-[10px] font-medium text-[#94a3b8] dark:text-white/40 px-2 py-0.5 rounded-full bg-[#f1f5f9] dark:bg-white/5">
                    {customized ? `${selectedCount} / ${count}` : count}
                  </span>
                )}
                {isChecked && isCherryPickable && count > 0 && (
                  <button
                    type="button"
                    onClick={() => setExpandedEntity(key)}
                    title="Cherry-pick records"
                    className="w-7 h-7 min-h-11 min-w-11 lg:min-h-0 lg:min-w-0 flex items-center justify-center rounded-lg text-[#94a3b8] hover:text-[#0d9488] hover:bg-[#f0fdfa] dark:hover:bg-teal-900/20 transition-all"
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
                      <polyline points="9 18 15 12 9 6" />
                    </svg>
                  </button>
                )}
              </div>
            );
          })}
        </div>

        {/* Select all / Deselect all */}
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setSelectedEntities(new Set(ALL_ENTITY_KEYS))}
            className="text-xs font-medium text-[#0d9488] hover:text-[#0f766e] dark:text-teal-400 transition-colors"
          >
            Select All
          </button>
          <span className="text-[#e2e8f0] dark:text-white/10">|</span>
          <button
            type="button"
            onClick={() => {
              setSelectedEntities(new Set());
              setSelectedIds({});
            }}
            className="text-xs font-medium text-[#64748b] hover:text-[#1e293b] dark:text-white/50 dark:hover:text-white transition-colors"
          >
            Deselect All
          </button>
        </div>
      </section>

      {/* Export button */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => exportMutation.mutate()}
          disabled={selectedEntities.size === 0 || exportMutation.isPending}
          className="px-5 py-2.5 rounded-lg bg-[#0d9488] hover:bg-[#0f766e] disabled:opacity-40 text-white text-sm font-medium transition-all flex items-center gap-2"
        >
          {exportMutation.isPending ? (
            <>
              <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                  fill="none"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                />
              </svg>
              Exporting...
            </>
          ) : (
            <>
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
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              Export Selected
            </>
          )}
        </button>
        {exportMutation.isSuccess && (
          <span className="text-xs text-[#0d9488] dark:text-teal-400 font-medium">
            Export downloaded successfully
          </span>
        )}
        {exportMutation.isError && (
          <span className="text-xs text-[#ef4444] dark:text-red-400 font-medium">
            Export failed. Please try again.
          </span>
        )}
      </div>
    </div>
  );
}
