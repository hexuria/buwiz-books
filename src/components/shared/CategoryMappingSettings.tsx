/**
 * CategoryMappingSettings — Generic modal to map domain concepts
 * to ledger categories. Used by Banks, Bills, and Invoices.
 * Persists via server (category_mappings table). Supports inline category creation.
 */
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { getAccountsByType } from "../../routes/api/-accounts";
import { createAccount } from "../../routes/api/-accounts";
import { renderIconSvg, SUBTYPE_ICONS } from "../accounts/CategoryForm";
import { listCategoryMappings, upsertCategoryMapping } from "../../routes/api/-category-mappings";
import type { LedgerAccountRef, MappingConfig, MappingRow } from "../../lib/coa/mapping-types";
import { Modal } from "../ui/Modal";

// ============================================================================
// Types
// ============================================================================

// Canonical definitions now live in src/lib/coa/mapping-types.ts so that server
// code can use them without depending on a .tsx module. Re-exported here for
// existing importers.
export type { MappingRow, MappingConfig, MappingType } from "../../lib/coa/mapping-types";

type LedgerAccount = LedgerAccountRef;

// ============================================================================
// Persistence Helpers — server-backed with localStorage fallback
// ============================================================================

/** @deprecated — used only for one-time migration to server */
export function loadMappingsFor(storageKey: string): Record<string, string> {
  try {
    const raw = localStorage.getItem(storageKey);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

/**
 * Resolve the category ID shown as "current" for a mapping row in THIS settings
 * panel. Runtime/posting resolution lives server-side in
 * `src/lib/coa/resolve-mapped-account.ts` — do not use this for that.
 *
 * Priority: 1) saved mapping (type-guarded), 2) subtype match, 3) unset.
 */
export function resolveMappedCategory(
  key: string,
  _storageKey: string,
  rows: MappingRow[],
  ledgerAccounts: LedgerAccount[],
  serverMappings?: Record<string, string>,
): string {
  const row = rows.find((r) => r.type === key);

  // 1) the saved mapping, but only if the target is still present AND still of
  // the row's ledger type — accounts are soft-deleted, so stale targets are
  // common, and a wrong-typed target would unbalance whatever posts through it.
  const savedId = serverMappings?.[key];
  if (savedId) {
    const saved = ledgerAccounts.find((a) => a.id === savedId);
    if (saved && (!row || saved.accountType === row.ledgerType)) return savedId;
  }

  // 2) subtype match, preferring the row's canonical account number so two
  // accounts sharing a subtype always resolve the same way.
  if (row) {
    const matches = ledgerAccounts.filter(
      (a) => a.subtype === row.defaultSubtype && a.accountType === row.ledgerType,
    );
    if (matches.length > 0) {
      const preferred = matches.find((a) => a.accountNumber === row.defaultNumber);
      return (preferred ?? matches[0]).id;
    }
  }

  // 3) unset. There is deliberately NO "first account of roughly the right
  // type" fallback: it presented an arbitrary account as the configured
  // default, and could categorize a bill line into Accounts Receivable.
  return "";
}

// ============================================================================
// Account Combobox — searchable dropdown with subtype icons
// ============================================================================

const COMBO_ITEM_HEIGHT = 40;
const COMBO_MAX_VISIBLE = 7;

interface AccountComboboxProps {
  accounts: LedgerAccount[];
  value: string;
  onChange: (id: string) => void;
}

function AccountCombobox({ accounts, value, onChange }: AccountComboboxProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlightIdx, setHighlightIdx] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Build option list: "None" + all accounts
  const allOptions = useMemo(() => {
    const items = accounts.map((a) => ({
      id: a.id,
      label: a.accountNumber ? `${a.accountNumber} — ${a.name}` : a.name,
      subtype: a.subtype,
    }));
    return [{ id: "", label: "None", subtype: null as string | null }, ...items];
  }, [accounts]);

  // Filtered by search query
  const filtered = useMemo(() => {
    if (!query.trim()) return allOptions;
    const q = query.toLowerCase();
    return allOptions.filter((o) => o.label.toLowerCase().includes(q));
  }, [allOptions, query]);

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery("");
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // Reset highlight when filtered list changes
  useEffect(() => {
    setHighlightIdx(0);
  }, [filtered.length]);

  // Auto-scroll highlighted item into view
  useEffect(() => {
    if (!listRef.current || highlightIdx < 0) return;
    const el = listRef.current.children[highlightIdx] as HTMLElement;
    if (el) el.scrollIntoView({ block: "nearest" });
  }, [highlightIdx]);

  // Focus input when opening
  useEffect(() => {
    if (open && inputRef.current) inputRef.current.focus();
  }, [open]);

  const handleSelect = (id: string) => {
    onChange(id);
    setOpen(false);
    setQuery("");
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!open) return;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setHighlightIdx((i) => Math.min(i + 1, filtered.length - 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setHighlightIdx((i) => Math.max(i - 1, 0));
        break;
      case "Enter":
        e.preventDefault();
        if (filtered[highlightIdx]) handleSelect(filtered[highlightIdx].id);
        break;
      case "Escape":
        e.preventDefault();
        setOpen(false);
        setQuery("");
        break;
    }
  };

  const selected = allOptions.find((o) => o.id === value);
  const selectedIcon = selected?.subtype ? SUBTYPE_ICONS[selected.subtype] : null;

  return (
    <div ref={containerRef} style={{ position: "relative" }}>
      {/* Trigger / search input */}
      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="flex items-center gap-2 w-full min-h-11 lg:min-h-0 px-3 py-2 rounded-lg text-sm bg-white dark:bg-[#0f172a] border border-[#e2e8f0] dark:border-white/10 text-[#1e293b] dark:text-white transition-all cursor-pointer justify-between hover:border-[#10b981]/40 focus:outline-none"
        >
          <span className="flex items-center gap-2 truncate min-w-0">
            {selectedIcon && (
              <span
                className="flex items-center justify-center shrink-0 text-[#64748b] dark:text-white/50"
                style={{ width: 20, height: 20 }}
              >
                {renderIconSvg(selectedIcon, 18)}
              </span>
            )}
            <span style={{ opacity: selected && selected.id ? 1 : 0.5 }}>
              {selected ? selected.label : "Select account..."}
            </span>
          </span>
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            style={{ flexShrink: 0, opacity: 0.35 }}
          >
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>
      ) : (
        <div className="flex items-center gap-2 w-full px-3 py-2 text-sm border-2 border-[#10b981] rounded-lg bg-white dark:bg-[#0f172a]">
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#94a3b8"
            strokeWidth="2"
            className="shrink-0"
          >
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.35-4.35" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type to filter..."
            className="flex-1 bg-transparent outline-none text-base sm:text-sm text-[#1e293b] dark:text-white placeholder:text-gray-400 dark:placeholder:text-white/30"
          />
        </div>
      )}

      {/* Dropdown list */}
      {open && (
        <div
          className="absolute z-[60] mt-1 w-full bg-white dark:bg-[#1e293b] border border-[#e2e8f0] dark:border-white/10 rounded-xl overflow-hidden"
          style={{
            boxShadow: "0 8px 32px rgba(0,0,0,0.14), 0 2px 8px rgba(0,0,0,0.08)",
          }}
        >
          <div
            ref={listRef}
            className="mapping-combo-list"
            style={{
              maxHeight: COMBO_MAX_VISIBLE * COMBO_ITEM_HEIGHT,
              overflowY: "auto",
              scrollbarWidth: "none",
            }}
          >
            <style>{`.mapping-combo-list::-webkit-scrollbar { display: none; }`}</style>
            {filtered.length === 0 && (
              <div
                className="px-4 text-sm text-[#94a3b8] flex items-center"
                style={{ height: COMBO_ITEM_HEIGHT }}
              >
                No matching accounts
              </div>
            )}
            {filtered.map((opt, idx) => {
              const icon = opt.subtype ? SUBTYPE_ICONS[opt.subtype] : null;
              const isSelected = opt.id === value;
              const isHighlighted = idx === highlightIdx;
              return (
                <button
                  key={opt.id || "__none__"}
                  type="button"
                  onMouseEnter={() => setHighlightIdx(idx)}
                  onClick={() => handleSelect(opt.id)}
                  className={`flex items-center gap-2.5 w-full px-3 text-sm transition-colors cursor-pointer ${
                    isSelected
                      ? "text-[#10b981] bg-[#10b981]/8 dark:bg-[#10b981]/15"
                      : isHighlighted
                        ? "text-[#1e293b] dark:text-white bg-[#f1f5f9] dark:bg-white/5"
                        : "text-[#1e293b] dark:text-white"
                  }`}
                  style={{ height: COMBO_ITEM_HEIGHT, minHeight: COMBO_ITEM_HEIGHT }}
                >
                  <span
                    className="flex items-center justify-center shrink-0"
                    style={{ width: 22, height: 22, opacity: 0.55 }}
                  >
                    {icon && renderIconSvg(icon, 18)}
                  </span>
                  <span className="flex-1 text-left truncate">{opt.label}</span>
                  {isSelected && (
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      className="shrink-0"
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
// Shared hooks for server-backed mappings
// ============================================================================

function useCategoryMappings(config: MappingConfig, enabled: boolean) {
  const queryClient = useQueryClient();
  const mappingType = config.mappingType;
  const queryKey = ["categoryMappings", mappingType];

  // Fetch server mappings
  const { data: serverMappings } = useQuery({
    queryKey,
    queryFn: () =>
      (listCategoryMappings as (opts: { data: unknown }) => Promise<Record<string, string>>)({
        data: { mappingType },
      }),
    enabled,
    staleTime: 5 * 60 * 1000,
  });

  const mappings = (serverMappings ?? {}) as Record<string, string>;

  // One-time migration of pre-server localStorage mappings.
  //
  // Gated on a persistent "done" flag rather than on "the server set is empty":
  // the old condition re-ran every time the server had no rows, which meant
  // resetting the mappings immediately resurrected the stale local ones. The
  // local data is cleared once it has been pushed.
  useEffect(() => {
    if (!enabled || serverMappings === undefined) return;
    if (Object.keys(serverMappings).length > 0) return;

    const migratedFlag = `${config.storageKey}:migrated`;
    if (localStorage.getItem(migratedFlag) === "1") return;

    const localData = loadMappingsFor(config.storageKey);
    localStorage.setItem(migratedFlag, "1");
    if (Object.keys(localData).length === 0) return;

    const writes = Object.entries(localData)
      .filter(([, targetCategoryId]) => Boolean(targetCategoryId))
      .map(([sourceKey, targetCategoryId]) =>
        (upsertCategoryMapping as (opts: { data: unknown }) => Promise<any>)({
          data: { mappingType, sourceKey, targetCategoryId },
        }).catch(() => undefined),
      );

    Promise.all(writes).then(() => {
      localStorage.removeItem(config.storageKey);
      queryClient.invalidateQueries({ queryKey });
    });
  }, [enabled, serverMappings, config.storageKey, mappingType, queryKey, queryClient]);

  // Upsert mutation with optimistic updates
  const upsertMutation = useMutation({
    mutationFn: (vars: { sourceKey: string; targetCategoryId: string }) =>
      (upsertCategoryMapping as (opts: { data: unknown }) => Promise<any>)({
        data: { mappingType, sourceKey: vars.sourceKey, targetCategoryId: vars.targetCategoryId },
      }),
    onMutate: async (vars) => {
      await queryClient.cancelQueries({ queryKey });
      const prev = queryClient.getQueryData<Record<string, string>>(queryKey);
      queryClient.setQueryData(queryKey, {
        ...prev,
        [vars.sourceKey]: vars.targetCategoryId,
      });
      return { prev };
    },
    onError: (_err, _vars, context) => {
      if (context?.prev) queryClient.setQueryData(queryKey, context.prev);
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey });
    },
  });

  return { mappings, upsertMutation };
}

// ============================================================================
// Modal Component
// ============================================================================

interface CategoryMappingSettingsProps {
  open: boolean;
  onClose: () => void;
  config: MappingConfig;
}

export function CategoryMappingSettings({ open, onClose, config }: CategoryMappingSettingsProps) {
  const queryClient = useQueryClient();
  const { mappings, upsertMutation } = useCategoryMappings(config, open);
  const [creating, setCreating] = useState<string | null>(null);

  // Collect unique ledger types needed by the config rows
  const ledgerTypes = [...new Set(config.rows.map((r) => r.ledgerType))];

  // Fetch accounts for each unique type
  const accountQueries = ledgerTypes.map((t) => ({
    type: t,
    // biome-ignore lint: hooks in map is safe since ledgerTypes is stable
    ...useQuery<LedgerAccount[]>({
      queryKey: ["accounts-by-type", t],
      queryFn: () =>
        (getAccountsByType as (opts: { data: unknown }) => Promise<LedgerAccount[]>)({
          data: { accountType: t },
        }),
      enabled: open,
      staleTime: 60_000,
    }),
  }));

  const getAccountsForType = useCallback(
    (ledgerType: string): LedgerAccount[] => {
      const q = accountQueries.find((aq) => aq.type === ledgerType);
      return q?.data ?? [];
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [accountQueries.map((q) => q.data).join(",")],
  );

  // Current resolved value for each row
  const resolvedFor = (row: MappingRow) => {
    const list = getAccountsForType(row.ledgerType);
    const savedId = mappings[row.type];
    if (savedId && list.some((a) => a.id === savedId)) return savedId;
    return resolveMappedCategory(row.type, config.storageKey, config.rows, list, mappings);
  };

  const handleChange = (type: string, value: string) => {
    upsertMutation.mutate({ sourceKey: type, targetCategoryId: value });
  };

  // Create a missing category inline
  const handleCreate = async (row: MappingRow) => {
    setCreating(row.type);
    try {
      const created = await (createAccount as (opts: { data: unknown }) => Promise<any>)({
        data: {
          name: row.defaultName,
          accountNumber: row.defaultNumber,
          accountType: row.ledgerType,
          subtype: row.defaultSubtype,
        },
      });
      queryClient.invalidateQueries({ queryKey: ["accounts-by-type"] });
      upsertMutation.mutate({ sourceKey: row.type, targetCategoryId: created.id });
    } catch {
      // Ignore — category probably already exists
    }
    setCreating(null);
  };

  // Type badge color
  const badgeClasses = (ledgerType: string) => {
    switch (ledgerType) {
      case "liability":
        return "bg-amber-50 dark:bg-amber-900/20 text-amber-600 dark:text-amber-400";
      case "expense":
      case "cost_of_goods_sold":
      case "cost_of_revenue":
      case "other_expense":
        return "bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400";
      case "revenue":
      case "other_income":
        return "bg-emerald-50 dark:bg-emerald-900/20 text-emerald-600 dark:text-emerald-400";
      default:
        return "bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400";
    }
  };

  const badgeLabel = (ledgerType: string) => {
    switch (ledgerType) {
      case "liability":
        return "Liability";
      case "expense":
        return "Expense";
      case "cost_of_goods_sold":
      case "cost_of_revenue":
        return "COGS";
      case "other_expense":
        return "Other Exp";
      case "revenue":
        return "Revenue";
      case "other_income":
        return "Other Inc";
      case "asset":
        return "Asset";
      case "equity":
        return "Equity";
      default:
        return ledgerType;
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={config.title}
      description={config.description}
      mobile="fullscreen"
      size="lg"
      bodyClassName="p-0"
      footer={
        <>
          <p className="self-center text-[11px] text-[#94a3b8] dark:text-white/30 sm:mr-auto">
            Changes apply immediately
          </p>
          <button
            type="button"
            onClick={onClose}
            className="min-h-11 px-4 py-2 rounded-lg text-sm font-medium bg-[#10b981] text-white hover:bg-[#059669] transition-colors"
          >
            Done
          </button>
        </>
      }
    >
      <MappingRowList
        config={config}
        mappings={mappings}
        creating={creating}
        getAccountsForType={getAccountsForType}
        resolvedFor={resolvedFor}
        handleChange={handleChange}
        handleCreate={handleCreate}
        badgeClasses={badgeClasses}
        badgeLabel={badgeLabel}
      />
    </Modal>
  );
}

// ============================================================================
// Shared Mapping Row List — used by both the modal and inline panel
// ============================================================================

function MappingRowList({
  config,
  mappings: _mappings,
  creating,
  getAccountsForType,
  resolvedFor,
  handleChange,
  handleCreate,
  badgeClasses,
  badgeLabel,
}: {
  config: MappingConfig;
  mappings: Record<string, string>;
  creating: string | null;
  getAccountsForType: (ledgerType: string) => LedgerAccount[];
  resolvedFor: (row: MappingRow) => string;
  handleChange: (type: string, value: string) => void;
  handleCreate: (row: MappingRow) => Promise<void>;
  badgeClasses: (ledgerType: string) => string;
  badgeLabel: (ledgerType: string) => string;
}) {
  return (
    <div className="px-4 sm:px-6 py-4 space-y-2.5 max-h-[60vh] overflow-y-auto">
      {config.rows.map((row) => {
        const list = getAccountsForType(row.ledgerType);
        const current = resolvedFor(row);
        const hasOptions = list.length > 0;

        return (
          <div
            key={row.type}
            className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 sm:gap-3 px-4 py-3 rounded-xl border border-[#e2e8f0] dark:border-white/8 bg-[#fafbfc] dark:bg-[#0f172a]/50"
          >
            {/* Type label */}
            <div className="w-full sm:w-40 shrink-0 flex items-center gap-2">
              <span className="text-base">{row.icon}</span>
              <span className="text-sm font-medium text-[#1e293b] dark:text-white">
                {row.label}
              </span>
            </div>

            {/* Arrow */}
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="hidden sm:block text-[#cbd5e1] dark:text-white/20 shrink-0"
            >
              <polyline points="9 18 15 12 9 6" />
            </svg>

            {/* Category combobox or create button */}
            <div className="flex-1 min-w-0">
              {hasOptions ? (
                <AccountCombobox
                  accounts={list}
                  value={current}
                  onChange={(id) => handleChange(row.type, id)}
                />
              ) : (
                <button
                  type="button"
                  onClick={() => handleCreate(row)}
                  disabled={creating === row.type}
                  className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium bg-[#10b981]/10 text-[#10b981] dark:text-[#34d399] hover:bg-[#10b981]/20 transition-colors disabled:opacity-50"
                >
                  {creating === row.type ? (
                    <span className="animate-spin w-3 h-3 border-2 border-[#10b981] border-t-transparent rounded-full" />
                  ) : (
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <line x1="12" y1="5" x2="12" y2="19" />
                      <line x1="5" y1="12" x2="19" y2="12" />
                    </svg>
                  )}
                  Create "{row.defaultName}"
                </button>
              )}
            </div>

            {/* Type badge */}
            <span
              className={`self-start sm:self-auto text-[10px] font-semibold px-2 py-0.5 rounded shrink-0 uppercase tracking-wide ${badgeClasses(row.ledgerType)}`}
            >
              {badgeLabel(row.ledgerType)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ============================================================================
// CategoryMappingPanel — Inline (non-modal) mapping panel
// ============================================================================

interface CategoryMappingPanelProps {
  config: MappingConfig;
}

export function CategoryMappingPanel({ config }: CategoryMappingPanelProps) {
  const queryClient = useQueryClient();
  const { mappings, upsertMutation } = useCategoryMappings(config, true);
  const [creating, setCreating] = useState<string | null>(null);

  // Collect unique ledger types needed by the config rows
  const ledgerTypes = [...new Set(config.rows.map((r) => r.ledgerType))];

  // Fetch accounts for each unique type
  const accountQueries = ledgerTypes.map((t) => ({
    type: t,
    // biome-ignore lint: hooks in map is safe since ledgerTypes is stable
    ...useQuery<LedgerAccount[]>({
      queryKey: ["accounts-by-type", t],
      queryFn: () =>
        (getAccountsByType as (opts: { data: unknown }) => Promise<LedgerAccount[]>)({
          data: { accountType: t },
        }),
      staleTime: 60_000,
    }),
  }));

  const getAccountsForType = useCallback(
    (ledgerType: string): LedgerAccount[] => {
      const q = accountQueries.find((aq) => aq.type === ledgerType);
      return q?.data ?? [];
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [accountQueries.map((q) => q.data).join(",")],
  );

  const resolvedFor = (row: MappingRow) => {
    const list = getAccountsForType(row.ledgerType);
    const savedId = mappings[row.type];
    if (savedId && list.some((a) => a.id === savedId)) return savedId;
    return resolveMappedCategory(row.type, config.storageKey, config.rows, list, mappings);
  };

  const handleChange = (type: string, value: string) => {
    upsertMutation.mutate({ sourceKey: type, targetCategoryId: value });
  };

  const handleCreate = async (row: MappingRow) => {
    setCreating(row.type);
    try {
      const created = await (createAccount as (opts: { data: unknown }) => Promise<any>)({
        data: {
          name: row.defaultName,
          accountNumber: row.defaultNumber,
          accountType: row.ledgerType,
          subtype: row.defaultSubtype,
        },
      });
      queryClient.invalidateQueries({ queryKey: ["accounts-by-type"] });
      upsertMutation.mutate({ sourceKey: row.type, targetCategoryId: created.id });
    } catch {
      // Ignore — category probably already exists
    }
    setCreating(null);
  };

  const badgeClasses = (ledgerType: string) => {
    switch (ledgerType) {
      case "liability":
        return "bg-amber-50 dark:bg-amber-900/20 text-amber-600 dark:text-amber-400";
      case "expense":
      case "cost_of_goods_sold":
      case "cost_of_revenue":
      case "other_expense":
        return "bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400";
      case "revenue":
      case "other_income":
        return "bg-emerald-50 dark:bg-emerald-900/20 text-emerald-600 dark:text-emerald-400";
      default:
        return "bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400";
    }
  };

  const badgeLabel = (ledgerType: string) => {
    switch (ledgerType) {
      case "liability":
        return "Liability";
      case "expense":
        return "Expense";
      case "cost_of_goods_sold":
      case "cost_of_revenue":
        return "COGS";
      case "other_expense":
        return "Other Exp";
      case "revenue":
        return "Revenue";
      case "other_income":
        return "Other Inc";
      case "asset":
        return "Asset";
      case "equity":
        return "Equity";
      default:
        return ledgerType;
    }
  };

  return (
    <MappingRowList
      config={config}
      mappings={mappings}
      creating={creating}
      getAccountsForType={getAccountsForType}
      resolvedFor={resolvedFor}
      handleChange={handleChange}
      handleCreate={handleCreate}
      badgeClasses={badgeClasses}
      badgeLabel={badgeLabel}
    />
  );
}
