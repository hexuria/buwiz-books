/**
 * Category Mappings — /organization/$orgId/mappings
 * Unified full-page settings for all category-to-ledger mappings.
 * Tabs: Banks & Cards · Bills · Invoices · Connections · Parties
 */
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import { Modal } from "../components/ui/Modal";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { CategoryMappingPanel } from "../components/shared/CategoryMappingSettings";
import type { MappingConfig } from "../components/shared/CategoryMappingSettings";
import { BANK_MAPPING_CONFIG } from "../lib/bank-mapping-config";
import { BILL_MAPPING_CONFIG } from "../lib/bill-mapping-config";
import { INVOICE_MAPPING_CONFIG } from "../lib/invoice-mapping-config";
import { SUBTYPE_READ_MAP, SUBTYPE_MUTATE_MAP } from "../lib/party-scoping";
import type { PartyType, PartyMappingOverride } from "../lib/party-scoping";
import { callServerFn } from "../lib/server-fn-client";
import { getMappedAccounts } from "./api/-category-mappings";
import { keys as queryKeys } from "../lib/query-keys";
import {
  listPartyMappings,
  upsertPartyMapping,
  deletePartyMapping,
  resetPartyMappings,
} from "./api/-party-mappings";
import {
  listConnections,
  createConnection,
  updateConnection,
  deleteConnection,
} from "./api/-connections";
import { listAccounts, updateAccount } from "./api/-accounts";

// ============================================================================
// Route
// ============================================================================

export const Route = createFileRoute("/organization/$orgId/mappings")({
  component: MappingsPage,
});

// ============================================================================
// Tab Config
// ============================================================================

type MappingTab = "banks" | "bills" | "invoices" | "connections" | "parties";

interface TabConfig {
  key: MappingTab;
  label: string;
  icon: string;
  config?: MappingConfig;
}

const TABS: TabConfig[] = [
  {
    key: "banks",
    label: "Banks & Cards",
    icon: "🏦",
    config: BANK_MAPPING_CONFIG,
  },
  {
    key: "bills",
    label: "Bills",
    icon: "📋",
    config: BILL_MAPPING_CONFIG,
  },
  {
    key: "invoices",
    label: "Invoices",
    icon: "📨",
    config: INVOICE_MAPPING_CONFIG,
  },
  {
    key: "connections",
    label: "Connections",
    icon: "🔌",
  },
  {
    key: "parties",
    label: "Parties",
    icon: "👥",
  },
];

// ============================================================================
// Party Type Styling
// ============================================================================

const PARTY_TYPE_STYLES: Record<PartyType, { label: string; bg: string; text: string }> = {
  vendor: {
    label: "Vendor",
    bg: "bg-blue-50 dark:bg-blue-900/20",
    text: "text-blue-600 dark:text-blue-400",
  },
  customer: {
    label: "Customer",
    bg: "bg-emerald-50 dark:bg-emerald-900/20",
    text: "text-emerald-600 dark:text-emerald-400",
  },
  both: {
    label: "Both",
    bg: "bg-amber-50 dark:bg-amber-900/20",
    text: "text-amber-600 dark:text-amber-400",
  },
  employee: {
    label: "Employee",
    bg: "bg-purple-50 dark:bg-purple-900/20",
    text: "text-purple-600 dark:text-purple-400",
  },
  shareholder: {
    label: "Shareholder",
    bg: "bg-indigo-50 dark:bg-indigo-900/20",
    text: "text-indigo-600 dark:text-indigo-400",
  },
  lender: {
    label: "Lender",
    bg: "bg-rose-50 dark:bg-rose-900/20",
    text: "text-rose-600 dark:text-rose-400",
  },
  government: {
    label: "Government",
    bg: "bg-slate-100 dark:bg-slate-800/40",
    text: "text-slate-600 dark:text-slate-400",
  },
  other: {
    label: "Other",
    bg: "bg-gray-50 dark:bg-gray-800/30",
    text: "text-gray-500 dark:text-gray-400",
  },
  bank: {
    label: "Bank",
    bg: "bg-cyan-50 dark:bg-cyan-900/20",
    text: "text-cyan-600 dark:text-cyan-400",
  },
};

// ============================================================================
// Page
// ============================================================================

function MappingsPage() {
  const [activeTab, setActiveTab] = useState<MappingTab>("banks");
  const currentTab = TABS.find((t) => t.key === activeTab) ?? TABS[0];

  return (
    <div className="min-h-screen bg-[#f1f5f9] dark:bg-[#0c1322] overflow-y-auto">
      {/* Header */}
      <header className="sticky top-0 z-40 bg-white/80 dark:bg-[#111827]/80 backdrop-blur-md border-b border-[#e2e8f0] dark:border-white/10">
        <div className="max-w-6xl mx-auto px-3 sm:px-6 h-14 flex items-center">
          <Link
            to="/"
            className="flex items-center gap-1.5 text-sm text-[#0d9488] hover:text-[#0f766e] dark:text-teal-400 dark:hover:text-teal-300 font-medium transition-colors no-underline"
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
            >
              <polyline points="15 18 9 12 15 6" />
            </svg>
            Back to app
          </Link>
          <h1 className="ml-6 text-lg font-semibold text-[#1e293b] dark:text-white">
            Category Mappings
          </h1>
        </div>
      </header>

      {/* Content */}
      <div className="max-w-6xl mx-auto px-3 sm:px-6 py-4 sm:py-8 flex flex-col lg:flex-row gap-4 lg:gap-8">
        {/* Sidebar */}
        <aside className="w-52 shrink-0">
          <nav className="sticky top-24 space-y-0.5">
            {TABS.map((tab) => (
              <button
                key={tab.key}
                type="button"
                onClick={() => setActiveTab(tab.key)}
                className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition-all ${
                  activeTab === tab.key
                    ? "bg-[#0d9488]/10 dark:bg-teal-900/30 text-[#0d9488] dark:text-teal-400"
                    : "text-[#64748b] dark:text-white/50 hover:bg-[#f1f5f9] dark:hover:bg-white/5 hover:text-[#1e293b] dark:hover:text-white"
                }`}
              >
                <span className="text-base">{tab.icon}</span>
                {tab.label}
              </button>
            ))}
          </nav>
        </aside>

        {/* Main Content */}
        <main className="flex-1 min-w-0">
          <div className="bg-white dark:bg-[#1e293b] rounded-2xl shadow-sm border border-[#e2e8f0] dark:border-white/10">
            {activeTab === "connections" ? (
              <ConnectionsTabContent />
            ) : activeTab === "parties" ? (
              <PartiesTabContent />
            ) : (
              <>
                {/* Section Header */}
                <div className="px-6 py-5 border-b border-[#e2e8f0] dark:border-white/10">
                  <h2 className="text-base font-semibold text-[#1e293b] dark:text-white">
                    {currentTab.config?.title}
                  </h2>
                  <p className="text-xs text-[#64748b] dark:text-white/50 mt-0.5">
                    {currentTab.config?.description}
                  </p>
                </div>

                {/* Unmapped indicator — a row with no resolvable account is
                    what makes a bill or invoice fail at posting time, so surface
                    the count rather than leaving it to be discovered mid-form. */}
                {currentTab.config && <UnmappedBanner config={currentTab.config} />}

                {/* Mapping Panel */}
                {currentTab.config && (
                  <CategoryMappingPanel key={currentTab.key} config={currentTab.config} />
                )}

                {/* Footer */}
                <div className="px-6 py-3 border-t border-[#e2e8f0] dark:border-white/10">
                  <p className="text-[11px] text-[#94a3b8] dark:text-white/30">
                    Changes apply immediately
                  </p>
                </div>
              </>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}

// ============================================================================
// Connections Tab Content — External source → category links
// ============================================================================

const SOURCE_TYPE_META: Record<string, { icon: string; label: string }> = {
  bank: { icon: "🏦", label: "Bank Accounts" },
  credit_card: { icon: "💳", label: "Credit Cards" },
  payroll: { icon: "👥", label: "Payroll" },
  payment_processor: { icon: "⚡", label: "Payment Processors" },
  expense_management: { icon: "📋", label: "Expense Management" },
  other: { icon: "🔗", label: "Other" },
};

type ConnectionSourceType =
  | "bank"
  | "credit_card"
  | "payroll"
  | "payment_processor"
  | "expense_management"
  | "other";

interface ConnectionRow {
  id: string;
  categoryId: string;
  categoryName: string | null;
  sourceType: ConnectionSourceType;
  sourceName: string;
  sourceInstitution: string | null;
  externalId: string | null;
  externalSource: string | null;
  lastFourDigits: string | null;
  createdAt: Date;
  updatedAt: Date;
}

type FlatAccountRow = Awaited<ReturnType<typeof listAccounts>>[number];

function ConnectionsTabContent() {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<ConnectionRow | null>(null);
  const [creating, setCreating] = useState(false);

  const { data: connections = [], isLoading } = useQuery<ConnectionRow[]>({
    queryKey: ["connections"],
    queryFn: () => callServerFn(listConnections, { data: {} }),
    staleTime: 5 * 60 * 1000,
  });

  const deleteMut = useMutation({
    mutationFn: deleteConnection,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["connections"] });
    },
  });

  const handleDelete = useCallback(
    (id: string) => {
      deleteMut.mutate({ data: { id } });
    },
    [deleteMut],
  );

  // Group connections by sourceType
  const grouped = useMemo(() => {
    const groups: Record<string, ConnectionRow[]> = {};
    for (const conn of connections) {
      const key = conn.sourceType;
      if (!groups[key]) groups[key] = [];
      groups[key].push(conn);
    }
    return groups;
  }, [connections]);

  const groupKeys = Object.keys(grouped).sort();
  const isEmpty = groupKeys.length === 0;

  return (
    <>
      {/* Header */}
      <div className="px-6 py-5 border-b border-[#e2e8f0] dark:border-white/10">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-[#1e293b] dark:text-white">Connections</h2>
            <p className="text-xs text-[#64748b] dark:text-white/50 mt-0.5">
              Link external data sources to your chart of accounts categories
            </p>
          </div>
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-white bg-[#0d9488] hover:bg-[#0f766e] transition-colors"
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            Add Connection
          </button>
        </div>
      </div>

      {/* List */}
      <div className="px-6 py-4 max-h-[60vh] overflow-y-auto">
        {isLoading ? (
          <div className="flex items-center justify-center py-16">
            <div className="w-5 h-5 border-2 border-[#0d9488] border-t-transparent rounded-full animate-spin" />
          </div>
        ) : isEmpty ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <span className="text-3xl mb-3">🔌</span>
            <p className="text-sm font-medium text-[#1e293b] dark:text-white">No connections yet</p>
            <p className="text-xs text-[#64748b] dark:text-white/50 mt-1 w-80">
              Connect your bank accounts, credit cards, payroll providers, and payment processors to
              map their data to your ledger categories.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {groupKeys.map((sourceType) => {
              const meta = SOURCE_TYPE_META[sourceType] ?? {
                icon: "🔗",
                label: sourceType,
              };
              const items = grouped[sourceType];
              return (
                <div key={sourceType}>
                  <div className="pt-1 pb-2">
                    <span className="text-[11px] font-bold text-[#94a3b8] dark:text-white/40 uppercase tracking-wider">
                      {meta.icon} {meta.label}
                    </span>
                  </div>
                  <div className="space-y-1.5">
                    {items.map((conn) => (
                      <div
                        key={conn.id}
                        className="flex items-center gap-3 px-4 py-3 rounded-xl border border-[#e2e8f0] dark:border-white/8 bg-[#fafbfc] dark:bg-[#0f172a]/50 hover:border-[#10b981]/30 dark:hover:border-teal-500/20 transition-colors cursor-pointer group"
                        role="button"
                        tabIndex={0}
                        onClick={() => setEditing(conn)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") setEditing(conn);
                        }}
                      >
                        {/* Source name */}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium text-[#1e293b] dark:text-white truncate">
                              {conn.sourceName}
                            </span>
                            {conn.lastFourDigits && (
                              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-[#f1f5f9] dark:bg-white/5 text-[#64748b] dark:text-white/40">
                                •••• {conn.lastFourDigits}
                              </span>
                            )}
                          </div>
                          {conn.sourceInstitution && (
                            <span className="text-[11px] text-[#94a3b8] dark:text-white/30">
                              {conn.sourceInstitution}
                            </span>
                          )}
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
                          className="text-[#cbd5e1] dark:text-white/20 shrink-0"
                        >
                          <polyline points="9 18 15 12 9 6" />
                        </svg>

                        {/* Linked category */}
                        <span className="text-xs font-medium text-[#0d9488] dark:text-teal-400 truncate max-w-[160px]">
                          {conn.categoryName ?? "Unlinked"}
                        </span>

                        {/* Delete */}
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDelete(conn.id);
                          }}
                          className="opacity-0 group-hover:opacity-100 flex items-center justify-center w-6 h-6 rounded text-[#94a3b8] hover:text-red-500 dark:hover:text-red-400 transition-all shrink-0"
                          title="Delete connection"
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
                            <line x1="18" y1="6" x2="6" y2="18" />
                            <line x1="6" y1="6" x2="18" y2="18" />
                          </svg>
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="px-6 py-3 border-t border-[#e2e8f0] dark:border-white/10">
        <p className="text-[11px] text-[#94a3b8] dark:text-white/30">
          {connections.length} connection
          {connections.length !== 1 ? "s" : ""}
        </p>
      </div>

      {/* Modal */}
      {(creating || editing) && (
        <ManageConnectionModal
          connection={editing}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
        />
      )}
    </>
  );
}

// ============================================================================
// Manage Connection Modal — Create / Edit
// ============================================================================

function ManageConnectionModal({
  connection,
  onClose,
}: {
  connection: ConnectionRow | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const isEdit = connection !== null;

  const [sourceType, setSourceType] = useState<ConnectionRow["sourceType"]>(
    connection?.sourceType ?? "bank",
  );
  const [sourceName, setSourceName] = useState(connection?.sourceName ?? "");
  const [sourceInstitution, setSourceInstitution] = useState(connection?.sourceInstitution ?? "");
  const [externalId, setExternalId] = useState(connection?.externalId ?? "");
  const [externalSource, setExternalSource] = useState(connection?.externalSource ?? "");
  const [lastFourDigits, setLastFourDigits] = useState(connection?.lastFourDigits ?? "");
  const [categoryId, setCategoryId] = useState(connection?.categoryId ?? "");
  const [categorySearch, setCategorySearch] = useState("");
  const [showCategoryDropdown, setShowCategoryDropdown] = useState(false);
  const categoryRef = useRef<HTMLDivElement>(null);

  // Load categories for the combobox
  const { data: categories = [] } = useQuery({
    queryKey: ["accounts", "all"],
    queryFn: () =>
      callServerFn(listAccounts, {
        data: { includeChildren: false, status: ["active"], types: [], subtypes: [] },
      }),
    staleTime: 5 * 60 * 1000,
  });

  const filteredCategories = useMemo(() => {
    const list = categories;
    if (!categorySearch) return list.slice(0, 30);
    const lower = categorySearch.toLowerCase();
    return list.filter((c) => c.name.toLowerCase().includes(lower)).slice(0, 30);
  }, [categories, categorySearch]);

  const selectedCategoryName = useMemo(() => {
    if (!categoryId) return "";
    const found = categories.find((c) => c.id === categoryId);
    return found?.name ?? connection?.categoryName ?? "";
  }, [categoryId, categories, connection]);

  // Close dropdown on outside click
  useEffect(() => {
    if (!showCategoryDropdown) return;
    const handler = (e: MouseEvent) => {
      if (categoryRef.current && !categoryRef.current.contains(e.target as Node)) {
        setShowCategoryDropdown(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showCategoryDropdown]);

  const createMut = useMutation({
    mutationFn: createConnection,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["connections"] });
      onClose();
    },
  });

  const updateMut = useMutation({
    mutationFn: updateConnection,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["connections"] });
      onClose();
    },
  });

  const handleSave = () => {
    if (!sourceName.trim() || !categoryId) return;

    if (isEdit) {
      updateMut.mutate({
        data: {
          id: connection.id,
          categoryId,
          sourceName: sourceName.trim(),
          sourceInstitution: sourceInstitution.trim() || null,
          externalId: externalId.trim() || null,
          externalSource: externalSource.trim() || null,
          lastFourDigits: lastFourDigits.trim() || null,
        },
      });
    } else {
      createMut.mutate({
        data: {
          categoryId,
          sourceType,
          sourceName: sourceName.trim(),
          sourceInstitution: sourceInstitution.trim() || undefined,
          externalId: externalId.trim() || undefined,
          externalSource: externalSource.trim() || undefined,
          lastFourDigits: lastFourDigits.trim() || undefined,
        },
      });
    }
  };

  const isSaving = createMut.isPending || updateMut.isPending;
  const canSave = sourceName.trim().length > 0 && categoryId.length > 0;

  return (
    <Modal
      open
      onClose={onClose}
      title={isEdit ? "Edit Connection" : "Add Connection"}
      mobile="fullscreen"
      size="md"
      bodyClassName="p-0"
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="min-h-11 px-4 py-2 rounded-lg text-xs font-medium text-[#64748b] dark:text-white/50 hover:bg-[#f1f5f9] dark:hover:bg-white/5 transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={!canSave || isSaving}
            className="min-h-11 px-4 py-2 rounded-lg text-xs font-semibold text-white bg-[#0d9488] hover:bg-[#0f766e] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {isSaving ? "Saving…" : isEdit ? "Save Changes" : "Create Connection"}
          </button>
        </>
      }
    >
      {/* Form */}
      <div className="px-4 sm:px-6 py-5 space-y-4">
        {/* Source Type */}
        {!isEdit && (
          <div>
            <label className="block text-[11px] font-semibold text-[#64748b] dark:text-white/50 uppercase tracking-wider mb-1.5">
              Source Type
            </label>
            <select
              value={sourceType}
              onChange={(e) => setSourceType(e.target.value as ConnectionRow["sourceType"])}
              className="w-full px-3 py-2 rounded-lg text-base sm:text-sm bg-white dark:bg-[#0f172a] border border-[#e2e8f0] dark:border-white/10 text-[#1e293b] dark:text-white focus:outline-none focus:border-[#10b981]/40"
            >
              {Object.entries(SOURCE_TYPE_META).map(([key, meta]) => (
                <option key={key} value={key}>
                  {meta.icon} {meta.label}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* Source Name */}
        <div>
          <label className="block text-[11px] font-semibold text-[#64748b] dark:text-white/50 uppercase tracking-wider mb-1.5">
            Source Name *
          </label>
          <input
            type="text"
            value={sourceName}
            onChange={(e) => setSourceName(e.target.value)}
            placeholder="e.g., Mercury Checking"
            className="w-full px-3 py-2 rounded-lg text-base sm:text-sm bg-white dark:bg-[#0f172a] border border-[#e2e8f0] dark:border-white/10 text-[#1e293b] dark:text-white placeholder-[#94a3b8] focus:outline-none focus:border-[#10b981]/40"
          />
        </div>

        {/* Institution */}
        <div>
          <label className="block text-[11px] font-semibold text-[#64748b] dark:text-white/50 uppercase tracking-wider mb-1.5">
            Institution
          </label>
          <input
            type="text"
            value={sourceInstitution}
            onChange={(e) => setSourceInstitution(e.target.value)}
            placeholder="e.g., Mercury Bank"
            className="w-full px-3 py-2 rounded-lg text-base sm:text-sm bg-white dark:bg-[#0f172a] border border-[#e2e8f0] dark:border-white/10 text-[#1e293b] dark:text-white placeholder-[#94a3b8] focus:outline-none focus:border-[#10b981]/40"
          />
        </div>

        {/* Last 4 */}
        <div className="flex gap-3">
          <div className="flex-1">
            <label className="block text-[11px] font-semibold text-[#64748b] dark:text-white/50 uppercase tracking-wider mb-1.5">
              Last 4 Digits
            </label>
            <input
              type="text"
              value={lastFourDigits}
              onChange={(e) => setLastFourDigits(e.target.value.replace(/\D/g, "").slice(0, 4))}
              placeholder="1234"
              maxLength={4}
              className="w-full px-3 py-2 rounded-lg text-base sm:text-sm bg-white dark:bg-[#0f172a] border border-[#e2e8f0] dark:border-white/10 text-[#1e293b] dark:text-white placeholder-[#94a3b8] focus:outline-none focus:border-[#10b981]/40 font-mono"
            />
          </div>
          <div className="flex-1">
            <label className="block text-[11px] font-semibold text-[#64748b] dark:text-white/50 uppercase tracking-wider mb-1.5">
              External Source
            </label>
            <input
              type="text"
              value={externalSource}
              onChange={(e) => setExternalSource(e.target.value)}
              placeholder="plaid, stripe…"
              className="w-full px-3 py-2 rounded-lg text-base sm:text-sm bg-white dark:bg-[#0f172a] border border-[#e2e8f0] dark:border-white/10 text-[#1e293b] dark:text-white placeholder-[#94a3b8] focus:outline-none focus:border-[#10b981]/40"
            />
          </div>
        </div>

        {/* External ID */}
        <div>
          <label className="block text-[11px] font-semibold text-[#64748b] dark:text-white/50 uppercase tracking-wider mb-1.5">
            External ID
          </label>
          <input
            type="text"
            value={externalId}
            onChange={(e) => setExternalId(e.target.value)}
            placeholder="acct_6343"
            className="w-full px-3 py-2 rounded-lg text-base sm:text-sm bg-white dark:bg-[#0f172a] border border-[#e2e8f0] dark:border-white/10 text-[#1e293b] dark:text-white placeholder-[#94a3b8] focus:outline-none focus:border-[#10b981]/40 font-mono"
          />
        </div>

        {/* Category Picker */}
        <div ref={categoryRef}>
          <label className="block text-[11px] font-semibold text-[#64748b] dark:text-white/50 uppercase tracking-wider mb-1.5">
            Ledger Category *
          </label>
          <div className="relative">
            <input
              type="text"
              value={showCategoryDropdown ? categorySearch : selectedCategoryName}
              onChange={(e) => {
                setCategorySearch(e.target.value);
                setShowCategoryDropdown(true);
              }}
              onFocus={() => setShowCategoryDropdown(true)}
              placeholder="Search categories…"
              className="w-full px-3 py-2 rounded-lg text-base sm:text-sm bg-white dark:bg-[#0f172a] border border-[#e2e8f0] dark:border-white/10 text-[#1e293b] dark:text-white placeholder-[#94a3b8] focus:outline-none focus:border-[#10b981]/40"
            />
            {showCategoryDropdown && (
              <div
                className="absolute z-[110] mt-1 w-full max-h-48 overflow-y-auto bg-white dark:bg-[#1e293b] border border-[#e2e8f0] dark:border-white/10 rounded-xl"
                style={{
                  boxShadow: "0 8px 32px rgba(0,0,0,0.14), 0 2px 8px rgba(0,0,0,0.08)",
                }}
              >
                {filteredCategories.length === 0 ? (
                  <div className="px-3 py-3 text-xs text-[#94a3b8]">No categories found</div>
                ) : (
                  filteredCategories.map((cat) => (
                    <button
                      key={cat.id}
                      type="button"
                      onClick={() => {
                        setCategoryId(cat.id);
                        setCategorySearch("");
                        setShowCategoryDropdown(false);
                      }}
                      className={`w-full text-left px-3 py-2 text-sm hover:bg-[#f1f5f9] dark:hover:bg-white/5 transition-colors ${
                        cat.id === categoryId
                          ? "text-[#0d9488] dark:text-teal-400 font-medium"
                          : "text-[#1e293b] dark:text-white"
                      }`}
                    >
                      {cat.accountNumber ? `${cat.accountNumber} · ` : ""}
                      {cat.name}
                    </button>
                  ))
                )}
              </div>
            )}
          </div>
          {selectedCategoryName && !showCategoryDropdown && (
            <p className="text-[10px] text-[#0d9488] dark:text-teal-400 mt-1">
              ✓ {selectedCategoryName}
            </p>
          )}
        </div>
      </div>
    </Modal>
  );
}

// ============================================================================
// Parties Tab Content — Editable party type mapping matrix
// ============================================================================

const ALL_PARTY_TYPES: PartyType[] = [
  "vendor",
  "customer",
  "employee",
  "shareholder",
  "lender",
  "bank",
  "government",
  "other",
];

// ============================================================================
// Root category for badge display
// ============================================================================

const SUBTYPE_TO_ROOT: Record<string, string> = {
  // Asset subtypes (14)
  account_receivable: "asset",
  accrued_revenue: "asset",
  asset_clearing: "asset",
  bank_accounts: "asset",
  fixed_assets: "asset",
  goodwill: "asset",
  intangible_assets: "asset",
  inventory: "asset",
  investments: "asset",
  other_current_assets: "asset",
  other_long_term_assets: "asset",
  prepaid_expenses: "asset",
  shareholder_loans: "asset",
  uncategorized_assets: "asset",
  // Liability subtypes (11)
  accounts_payable: "liability",
  accrued_expenses: "liability",
  convertible_notes: "liability",
  credit_cards: "liability",
  deferred_revenue: "liability",
  liability_clearing: "liability",
  long_term_debt: "liability",
  other_current_liabilities: "liability",
  other_long_term_liabilities: "liability",
  short_term_debt: "liability",
  payroll_liabilities: "liability",
  // Equity subtypes (9)
  additional_paid_in_capital: "equity",
  common_stock: "equity",
  other_comprehensive_income: "equity",
  owners_equity: "equity",
  preferred_stock: "equity",
  retained_earnings: "equity",
  safes: "equity",
  treasury_stock: "equity",
  uncategorized_equity: "equity",
  // Revenue subtypes (6)
  partner_revenue: "revenue",
  refunds_discounts: "revenue",
  sales_revenue: "revenue",
  subscription_revenue: "revenue",
  transaction_revenue: "revenue",
  uncategorized_income: "revenue",
  // Cost of Revenue subtypes (5)
  cost_of_goods: "cost_of_revenue",
  cost_of_labor: "cost_of_revenue",
  hosting_fees: "cost_of_revenue",
  other_cost_of_revenue: "cost_of_revenue",
  payment_processing_fees: "cost_of_revenue",
  // Operating Expenses subtypes (10+2)
  bad_debt_expense: "expense",
  bank_fees: "expense",
  business_application_software: "expense",
  facilities: "expense",
  general_operations: "expense",
  insurance: "expense",
  payroll_expenses: "expense",
  professional_fees: "expense",
  sales_marketing: "expense",
  supplies_and_materials: "expense",
  travel_entertainment: "expense",
  uncategorized_expenses: "expense",
  // Other Income subtypes (3)
  credit_card_rewards: "other_income",
  interests_dividends: "other_income",
  other_miscellaneous_income: "other_income",
  // Other Expenses subtypes (4)
  depreciation_amortization: "other_expense",
  interest_expense: "other_expense",
  other_miscellaneous_expenses: "other_expense",
  taxes: "other_expense",
};

function rootBadgeClasses(root: string): string {
  switch (root) {
    case "liability":
      return "bg-amber-50 dark:bg-amber-900/20 text-amber-600 dark:text-amber-400";
    case "expense":
      return "bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400";
    case "cost_of_revenue":
      return "bg-orange-50 dark:bg-orange-900/20 text-orange-600 dark:text-orange-400";
    case "revenue":
      return "bg-emerald-50 dark:bg-emerald-900/20 text-emerald-600 dark:text-emerald-400";
    case "other_income":
      return "bg-teal-50 dark:bg-teal-900/20 text-teal-600 dark:text-teal-400";
    case "other_expense":
      return "bg-rose-50 dark:bg-rose-900/20 text-rose-600 dark:text-rose-400";
    case "equity":
      return "bg-indigo-50 dark:bg-indigo-900/20 text-indigo-600 dark:text-indigo-400";
    default:
      return "bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400";
  }
}

function rootBadgeLabel(root: string): string {
  switch (root) {
    case "liability":
      return "Liability";
    case "expense":
      return "Expense";
    case "cost_of_revenue":
      return "COGS";
    case "revenue":
      return "Revenue";
    case "other_income":
      return "Other Inc";
    case "other_expense":
      return "Other Exp";
    case "equity":
      return "Equity";
    default:
      return "Asset";
  }
}

// ============================================================================
// Subtype icons
// ============================================================================

const SUBTYPE_ICONS: Record<string, string> = {
  // Asset subtypes
  account_receivable: "📥",
  accrued_revenue: "📊",
  asset_clearing: "🔄",
  bank_accounts: "🏦",
  fixed_assets: "🏗️",
  goodwill: "🤝",
  intangible_assets: "💎",
  inventory: "📦",
  investments: "💹",
  other_current_assets: "📂",
  other_long_term_assets: "📁",
  prepaid_expenses: "📋",
  shareholder_loans: "🤝",
  uncategorized_assets: "❓",
  // Liability subtypes
  accounts_payable: "💳",
  accrued_expenses: "📋",
  convertible_notes: "📝",
  credit_cards: "💳",
  deferred_revenue: "⏳",
  liability_clearing: "🔄",
  long_term_debt: "🏦",
  other_current_liabilities: "📋",
  other_long_term_liabilities: "📋",
  short_term_debt: "💰",
  payroll_liabilities: "🏛️",
  // Equity subtypes
  additional_paid_in_capital: "💰",
  common_stock: "📊",
  other_comprehensive_income: "📈",
  owners_equity: "👤",
  preferred_stock: "⭐",
  retained_earnings: "💰",
  safes: "📝",
  treasury_stock: "🏦",
  uncategorized_equity: "❓",
  // Revenue subtypes
  partner_revenue: "🤝",
  refunds_discounts: "🏷️",
  sales_revenue: "💵",
  subscription_revenue: "🔄",
  transaction_revenue: "💳",
  uncategorized_income: "❓",
  // Cost of Revenue subtypes
  cost_of_goods: "🏭",
  cost_of_labor: "👷",
  hosting_fees: "🖥️",
  other_cost_of_revenue: "📦",
  payment_processing_fees: "💳",
  // Operating Expenses subtypes
  bad_debt_expense: "⚠️",
  bank_fees: "🏦",
  business_application_software: "💻",
  facilities: "🏢",
  general_operations: "⚙️",
  insurance: "🛡️",
  payroll_expenses: "👥",
  professional_fees: "👔",
  sales_marketing: "📣",
  supplies_and_materials: "📎",
  travel_entertainment: "✈️",
  uncategorized_expenses: "📂",
  // Other Income subtypes
  credit_card_rewards: "🎁",
  interests_dividends: "📈",
  other_miscellaneous_income: "💰",
  // Other Expenses subtypes
  depreciation_amortization: "📉",
  interest_expense: "📈",
  other_miscellaneous_expenses: "📂",
  taxes: "🏛️",
};

// ============================================================================
// Category Groups — subtypes grouped by root category for display
// ============================================================================

const CATEGORY_GROUPS: { label: string; subtypes: string[] }[] = [
  {
    label: "Assets",
    subtypes: [
      "account_receivable",
      "accrued_revenue",
      "asset_clearing",
      "bank_accounts",
      "fixed_assets",
      "goodwill",
      "intangible_assets",
      "inventory",
      "investments",
      "other_current_assets",
      "other_long_term_assets",
      "prepaid_expenses",
      "shareholder_loans",
      "uncategorized_assets",
    ],
  },
  {
    label: "Liabilities",
    subtypes: [
      "accounts_payable",
      "accrued_expenses",
      "convertible_notes",
      "credit_cards",
      "deferred_revenue",
      "liability_clearing",
      "long_term_debt",
      "other_current_liabilities",
      "other_long_term_liabilities",
      "short_term_debt",
      "payroll_liabilities",
    ],
  },
  {
    label: "Equity",
    subtypes: [
      "additional_paid_in_capital",
      "common_stock",
      "other_comprehensive_income",
      "owners_equity",
      "preferred_stock",
      "retained_earnings",
      "safes",
      "treasury_stock",
      "uncategorized_equity",
    ],
  },
  {
    label: "Revenue",
    subtypes: [
      "partner_revenue",
      "refunds_discounts",
      "sales_revenue",
      "subscription_revenue",
      "transaction_revenue",
      "uncategorized_income",
    ],
  },
  {
    label: "Cost of Revenue",
    subtypes: [
      "cost_of_goods",
      "cost_of_labor",
      "hosting_fees",
      "other_cost_of_revenue",
      "payment_processing_fees",
    ],
  },
  {
    label: "Operating Expenses",
    subtypes: [
      "bad_debt_expense",
      "bank_fees",
      "business_application_software",
      "facilities",
      "general_operations",
      "insurance",
      "payroll_expenses",
      "professional_fees",
      "sales_marketing",
      "supplies_and_materials",
      "travel_entertainment",
      "uncategorized_expenses",
    ],
  },
  {
    label: "Other Income",
    subtypes: ["credit_card_rewards", "interests_dividends", "other_miscellaneous_income"],
  },
  {
    label: "Other Expenses",
    subtypes: [
      "depreciation_amortization",
      "interest_expense",
      "other_miscellaneous_expenses",
      "taxes",
    ],
  },
];

// ============================================================================
// PartyTypeCombobox — Multi-select with primary promotion
// ============================================================================

function PartyTypeCombobox({
  activeTypes,
  onToggle,
  onPromote,
}: {
  activeTypes: PartyType[];
  onToggle: (pt: PartyType) => void;
  onPromote: (pt: PartyType) => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Build display label
  const displayLabel = activeTypes
    .map((pt, i) => {
      const style = PARTY_TYPE_STYLES[pt];
      return i === 0 ? `★ ${style.label}` : style.label;
    })
    .join(", ");

  return (
    <div ref={containerRef} className="relative">
      {/* Trigger */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 w-full px-3 py-2 rounded-lg text-sm bg-white dark:bg-[#0f172a] border border-[#e2e8f0] dark:border-white/10 text-[#1e293b] dark:text-white transition-all cursor-pointer justify-between hover:border-[#10b981]/40 focus:outline-none"
      >
        <span className="truncate min-w-0 text-left">
          {activeTypes.length > 0 ? displayLabel : "No party types"}
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

      {/* Dropdown */}
      {open && (
        <div
          className="absolute z-[60] mt-1 w-64 bg-white dark:bg-[#1e293b] border border-[#e2e8f0] dark:border-white/10 rounded-xl overflow-hidden"
          style={{
            boxShadow: "0 8px 32px rgba(0,0,0,0.14), 0 2px 8px rgba(0,0,0,0.08)",
          }}
        >
          {ALL_PARTY_TYPES.map((pt) => {
            const isActive = activeTypes.includes(pt);
            const isPrimary = activeTypes[0] === pt;
            const style = PARTY_TYPE_STYLES[pt];

            return (
              <div
                key={pt}
                className="flex items-center gap-2 px-3 hover:bg-[#f1f5f9] dark:hover:bg-white/5 transition-colors"
                style={{ height: 40 }}
              >
                {/* Checkbox toggle */}
                <button
                  type="button"
                  onClick={() => {
                    onToggle(pt);
                  }}
                  className={`flex items-center justify-center w-4 h-4 rounded border transition-colors shrink-0 ${
                    isActive
                      ? "bg-[#10b981] border-[#10b981] text-white"
                      : "border-[#cbd5e1] dark:border-white/20"
                  }`}
                >
                  {isActive && (
                    <svg
                      width="10"
                      height="10"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="3"
                    >
                      <path d="M20 6L9 17l-5-5" />
                    </svg>
                  )}
                </button>

                {/* Label */}
                <span
                  className={`flex-1 text-sm ${
                    isActive ? `font-medium ${style.text}` : "text-[#64748b] dark:text-white/50"
                  }`}
                >
                  {style.label}
                </span>

                {/* Primary star */}
                {isActive && (
                  <button
                    type="button"
                    onClick={() => onPromote(pt)}
                    title={isPrimary ? "Primary" : `Set ${style.label} as primary`}
                    className={`touch-target flex items-center justify-center w-6 h-6 rounded transition-colors shrink-0 ${
                      isPrimary
                        ? "text-amber-500"
                        : "text-[#cbd5e1] dark:text-white/20 hover:text-amber-400"
                    }`}
                  >
                    <span className="text-sm">{isPrimary ? "★" : "☆"}</span>
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Parties Tab Content
// ============================================================================

// Root type labels for filter pills
const ROOT_TYPE_LABELS: { key: string; label: string }[] = [
  { key: "asset", label: "Assets" },
  { key: "liability", label: "Liabilities" },
  { key: "equity", label: "Equity" },
  { key: "revenue", label: "Revenue" },
  { key: "cost_of_revenue", label: "Cost of Revenue" },
  { key: "expense", label: "Expenses" },
  { key: "other_income", label: "Other Income" },
  { key: "other_expense", label: "Other Expenses" },
];

function PartiesTabContent() {
  const queryClient = useQueryClient();
  const [expandedSubtypes, setExpandedSubtypes] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedRootTypes, setSelectedRootTypes] = useState<Set<string>>(new Set());
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filterPanelRef = useRef<HTMLDivElement>(null);

  // Close filter panel on outside click
  useEffect(() => {
    if (!filtersOpen) return;
    const handler = (e: MouseEvent) => {
      if (filterPanelRef.current && !filterPanelRef.current.contains(e.target as Node)) {
        const target = e.target as HTMLElement;
        if (target.closest("[data-ignore-click-outside]")) return;
        setFiltersOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [filtersOpen]);

  // Load overrides from the server
  const { data: serverOverrides } = useQuery({
    queryKey: ["partyMappings"],
    queryFn: () => listPartyMappings(),
    staleTime: 5 * 60 * 1000,
  });
  const overrides: Record<string, PartyMappingOverride> = serverOverrides ?? {};

  // Load all accounts for per-category overrides
  const { data: accountsRaw = [] } = useQuery({
    queryKey: ["accounts", "flat-for-parties"],
    queryFn: () =>
      callServerFn(listAccounts, {
        data: { includeChildren: false, status: ["active"], types: [], subtypes: [] },
      }),
    staleTime: 5 * 60 * 1000,
  });

  // Group accounts by subtype
  const accountsBySubtype = useMemo(() => {
    const map: Record<string, FlatAccountRow[]> = {};
    for (const acct of accountsRaw) {
      const subtype = acct.subtype;
      if (!subtype) continue;
      if (!map[subtype]) map[subtype] = [];
      map[subtype].push(acct);
    }
    return map;
  }, [accountsRaw]);

  // Collect ALL subtype keys from CATEGORY_GROUPS so every row is resolved
  const ALL_SUBTYPES = useMemo(() => CATEGORY_GROUPS.flatMap((g) => g.subtypes), []);

  // Merge defaults with overrides — separate read and mutate
  const resolvedReadMap = useMemo(() => {
    const result: Record<string, PartyType[]> = {};
    for (const subtype of ALL_SUBTYPES) {
      result[subtype] = overrides[subtype]?.readTypes ?? SUBTYPE_READ_MAP[subtype] ?? [];
    }
    return result;
  }, [overrides, ALL_SUBTYPES]);

  const resolvedMutateMap = useMemo(() => {
    const result: Record<string, PartyType[]> = {};
    for (const subtype of ALL_SUBTYPES) {
      result[subtype] = overrides[subtype]?.mutateTypes ?? SUBTYPE_MUTATE_MAP[subtype] ?? [];
    }
    return result;
  }, [overrides, ALL_SUBTYPES]);

  const hasOverrides = Object.keys(overrides).length > 0;

  // ── Filtering logic ─────────────────────────────────────────────────
  const filteredGroups = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return CATEGORY_GROUPS.map((group) => {
      // If root type filters are active, check if this group's root matches
      const groupRootKey = SUBTYPE_TO_ROOT[group.subtypes[0]] ?? "asset";
      if (selectedRootTypes.size > 0 && !selectedRootTypes.has(groupRootKey)) {
        return { ...group, subtypes: [] };
      }
      // Filter subtypes by search query
      if (!q) return group;
      const filtered = group.subtypes.filter((st) => formatSubtype(st).toLowerCase().includes(q));
      return { ...group, subtypes: filtered };
    }).filter((g) => g.subtypes.length > 0);
  }, [searchQuery, selectedRootTypes]);

  const toggleRootType = useCallback((key: string) => {
    setSelectedRootTypes((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  const clearAllFilters = useCallback(() => {
    setSearchQuery("");
    setSelectedRootTypes(new Set());
  }, []);

  const hasFilters = searchQuery.trim().length > 0 || selectedRootTypes.size > 0;

  // Build filter chips for display (root type filters only, search stays in input)
  const filterChips = useMemo(() => {
    const chips: { id: string; label: string }[] = [];
    for (const key of selectedRootTypes) {
      const meta = ROOT_TYPE_LABELS.find((r) => r.key === key);
      if (meta) chips.push({ id: `root-${key}`, label: meta.label });
    }
    return chips;
  }, [selectedRootTypes]);

  const handleRemoveChip = useCallback((chipId: string) => {
    if (chipId.startsWith("root-")) {
      const key = chipId.slice(5);
      setSelectedRootTypes((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  }, []);

  // Toggle expand/collapse
  const toggleExpand = useCallback((subtype: string) => {
    setExpandedSubtypes((prev) => {
      const next = new Set(prev);
      if (next.has(subtype)) {
        next.delete(subtype);
      } else {
        next.add(subtype);
      }
      return next;
    });
  }, []);

  // Optimistic cache updater for subtype-level
  const setOptimistic = useCallback(
    (subtype: string, mapping: PartyMappingOverride | null) => {
      queryClient.setQueryData(["partyMappings"], (prev: Record<string, PartyMappingOverride>) => {
        const copy: Record<string, PartyMappingOverride> = { ...prev };
        if (mapping === null) {
          delete copy[subtype];
        } else {
          copy[subtype] = mapping;
        }
        return copy;
      });
    },
    [queryClient],
  );

  const upsertMutation = useMutation({
    mutationFn: upsertPartyMapping,
  });

  const deleteMutation = useMutation({
    mutationFn: deletePartyMapping,
  });

  const resetMutation = useMutation({
    mutationFn: resetPartyMappings,
    onSuccess: () => {
      queryClient.setQueryData(["partyMappings"], {});
    },
  });

  // Account-level update mutation
  const accountUpdateMutation = useMutation({
    mutationFn: (data: {
      id: string;
      readPartyTypes?: string[] | null;
      mutatePartyTypes?: string[] | null;
    }) =>
      callServerFn(updateAccount, {
        data,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["accounts"] });
    },
  });

  // Build the full mapping for a subtype, merging the override with the counterpart channel
  const buildMapping = useCallback(
    (subtype: string, channel: "read" | "mutate", nextTypes: PartyType[]): PartyMappingOverride => {
      const existing = overrides[subtype];
      if (channel === "read") {
        return {
          readTypes: nextTypes,
          mutateTypes: existing?.mutateTypes ?? SUBTYPE_MUTATE_MAP[subtype] ?? [],
        };
      }
      return {
        readTypes: existing?.readTypes ?? SUBTYPE_READ_MAP[subtype] ?? [],
        mutateTypes: nextTypes,
      };
    },
    [overrides],
  );

  const isDefaultMapping = useCallback(
    (subtype: string, mapping: PartyMappingOverride): boolean => {
      const defRead = SUBTYPE_READ_MAP[subtype] ?? [];
      const defMutate = SUBTYPE_MUTATE_MAP[subtype] ?? [];
      const rMatch =
        mapping.readTypes.length === defRead.length &&
        mapping.readTypes.every((t: PartyType, i: number) => t === defRead[i]);
      const mMatch =
        mapping.mutateTypes.length === defMutate.length &&
        mapping.mutateTypes.every((t: PartyType, i: number) => t === defMutate[i]);
      return rMatch && mMatch;
    },
    [],
  );

  const handleToggle = useCallback(
    (subtype: string, partyType: PartyType, channel: "read" | "mutate") => {
      const currentMap = channel === "read" ? resolvedReadMap : resolvedMutateMap;
      const current = currentMap[subtype] ?? [];
      const isActive = current.includes(partyType);
      let next: PartyType[];

      if (isActive) {
        if (current.length <= 1) return;
        next = current.filter((t) => t !== partyType);
      } else {
        next = [...current, partyType];
      }

      const mapping = buildMapping(subtype, channel, next);
      if (isDefaultMapping(subtype, mapping)) {
        setOptimistic(subtype, null);
        deleteMutation.mutate({ data: { subtype } });
      } else {
        setOptimistic(subtype, mapping);
        upsertMutation.mutate({
          data: { subtype, readTypes: mapping.readTypes, mutateTypes: mapping.mutateTypes },
        });
      }
    },
    [
      resolvedReadMap,
      resolvedMutateMap,
      buildMapping,
      isDefaultMapping,
      setOptimistic,
      upsertMutation,
      deleteMutation,
    ],
  );

  const handlePromote = useCallback(
    (subtype: string, partyType: PartyType, channel: "read" | "mutate") => {
      const currentMap = channel === "read" ? resolvedReadMap : resolvedMutateMap;
      const current = currentMap[subtype] ?? [];
      if (current[0] === partyType) return;
      const next = [partyType, ...current.filter((t) => t !== partyType)];

      const mapping = buildMapping(subtype, channel, next);
      if (isDefaultMapping(subtype, mapping)) {
        setOptimistic(subtype, null);
        deleteMutation.mutate({ data: { subtype } });
      } else {
        setOptimistic(subtype, mapping);
        upsertMutation.mutate({
          data: { subtype, readTypes: mapping.readTypes, mutateTypes: mapping.mutateTypes },
        });
      }
    },
    [
      resolvedReadMap,
      resolvedMutateMap,
      buildMapping,
      isDefaultMapping,
      setOptimistic,
      upsertMutation,
      deleteMutation,
    ],
  );

  // Account-level party type toggle — uses dual readPartyTypes/mutatePartyTypes
  const handleAccountToggle = useCallback(
    (
      accountId: string,
      partyType: PartyType,
      channel: "read" | "mutate",
      currentTypes: string[] | null,
    ) => {
      const current = currentTypes ?? [];
      let next: string[] | null;
      if (current.includes(partyType)) {
        // Remove this type
        next = current.filter((t) => t !== partyType);
        if (next.length === 0) next = null;
      } else {
        // Add this type
        next = [...current, partyType];
      }

      if (channel === "read") {
        accountUpdateMutation.mutate({
          id: accountId,
          readPartyTypes: next,
        });
        queryClient.setQueryData<FlatAccountRow[]>(["accounts", "flat-for-parties"], (prev) =>
          prev?.map((account) =>
            account.id === accountId ? { ...account, readPartyTypes: next } : account,
          ),
        );
      } else {
        accountUpdateMutation.mutate({
          id: accountId,
          mutatePartyTypes: next,
        });
        queryClient.setQueryData<FlatAccountRow[]>(["accounts", "flat-for-parties"], (prev) =>
          prev?.map((account) =>
            account.id === accountId ? { ...account, mutatePartyTypes: next } : account,
          ),
        );
      }
    },
    [accountUpdateMutation, queryClient],
  );

  const handleReset = useCallback(() => {
    resetMutation.mutate({ data: {} });
  }, [resetMutation]);

  function formatSubtype(subtype: string): string {
    return subtype
      .split("_")
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
  }

  return (
    <>
      {/* Header */}
      <div className="px-6 py-5 border-b border-[#e2e8f0] dark:border-white/10">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-[#1e293b] dark:text-white">
              Party Type Mappings
            </h2>
            <p className="text-xs text-[#64748b] dark:text-white/50 mt-0.5">
              Choose default party types per subtype, or expand to override individual categories
            </p>
          </div>
          {hasOverrides && (
            <button
              type="button"
              onClick={handleReset}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-[#64748b] dark:text-white/50 hover:text-[#ef4444] dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-all"
            >
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
                <polyline points="1 4 1 10 7 10" />
                <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
              </svg>
              Reset to defaults
            </button>
          )}
        </div>
      </div>

      {/* Search & Filter Bar — transactions-page style */}
      <div className="border-b border-[#e2e8f0] dark:border-white/10">
        <div className="flex items-start gap-2 px-5 py-2">
          {/* Search icon */}
          <div className="h-8 flex items-center shrink-0">
            <svg
              className="text-[#94a3b8] dark:text-white/30"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
          </div>

          {/* Chips + inline search */}
          <div className="flex-1 min-w-0">
            <div className="flex flex-wrap items-center gap-1.5">
              {filterChips.map((chip) => (
                <span
                  key={chip.id}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-[#e6f7f5] dark:bg-teal-950/60 text-[#0d9488] dark:text-teal-400 border border-[#b2e0db] dark:border-teal-800 whitespace-nowrap"
                >
                  {chip.label}
                  <button
                    type="button"
                    onClick={() => handleRemoveChip(chip.id)}
                    className="flex items-center justify-center w-3.5 h-3.5 rounded-full text-[#7cc8bf] dark:text-teal-500 hover:text-[#0d9488] dark:hover:text-teal-300 hover:bg-[#ccece8] dark:hover:bg-teal-900/40 transition-colors"
                  >
                    <svg
                      width="8"
                      height="8"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="3"
                    >
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                </span>
              ))}

              {/* Inline text search input at end of chips */}
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={hasFilters ? "Search subtypes…" : "Search subtypes…"}
                className="flex-1 min-w-[120px] py-0.5 bg-transparent text-base sm:text-[13px] text-[#1e293b] dark:text-white placeholder-[#94a3b8] dark:placeholder-white/30 focus:outline-none"
              />
            </div>
          </div>

          {/* Clear button */}
          {hasFilters && (
            <div className="h-8 flex items-center shrink-0">
              <button
                type="button"
                onClick={clearAllFilters}
                className="px-2.5 text-[11px] font-semibold text-[#0d9488] dark:text-teal-400 hover:text-[#0f766e] dark:hover:text-teal-300 transition-colors whitespace-nowrap"
              >
                Clear
              </button>
            </div>
          )}

          {/* Filter button */}
          <div className="h-8 flex items-center shrink-0 relative">
            <button
              type="button"
              data-ignore-click-outside
              onClick={() => setFiltersOpen((v) => !v)}
              className={`touch-target w-8 h-8 rounded-lg flex items-center justify-center transition-colors ${
                filtersOpen || selectedRootTypes.size > 0
                  ? "bg-[#ccece8] dark:bg-teal-900/40 text-[#0d9488] dark:text-teal-400"
                  : "text-[#94a3b8] dark:text-white/30 hover:text-[#64748b] dark:hover:text-white/50 hover:bg-[#f1f5f9] dark:hover:bg-white/5"
              }`}
              title="Filters"
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
                <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
              </svg>
            </button>

            {/* Filter dropdown panel */}
            {filtersOpen && (
              <div
                ref={filterPanelRef}
                className="absolute right-0 top-full mt-1 w-[260px] bg-white dark:bg-[#1e293b] border border-[#e2e8f0] dark:border-white/10 rounded-xl overflow-hidden z-50"
                style={{
                  boxShadow: "0 8px 32px rgba(0,0,0,0.14), 0 2px 8px rgba(0,0,0,0.08)",
                }}
              >
                {/* Panel header */}
                <div className="flex items-center justify-between px-4 py-3 border-b border-[#f1f5f9] dark:border-white/8">
                  <span className="text-[13px] font-semibold text-[#1e293b] dark:text-white">
                    Filters
                  </span>
                  <div className="flex items-center gap-2">
                    {selectedRootTypes.size > 0 && (
                      <button
                        type="button"
                        onClick={() => setSelectedRootTypes(new Set())}
                        className="text-[11px] text-[#0d9488] dark:text-teal-400 hover:text-[#0f766e] dark:hover:text-teal-300 font-medium transition-colors"
                      >
                        Clear all
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => setFiltersOpen(false)}
                      className="touch-target w-6 h-6 rounded flex items-center justify-center text-[#94a3b8] dark:text-white/30 hover:text-[#64748b] dark:hover:text-white/50 hover:bg-[#f1f5f9] dark:hover:bg-white/5 transition-colors"
                    >
                      <svg
                        width="12"
                        height="12"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                      >
                        <line x1="18" y1="6" x2="6" y2="18" />
                        <line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                    </button>
                  </div>
                </div>

                {/* Category type checkboxes */}
                <div className="max-h-[50vh] overflow-y-auto py-1">
                  {ROOT_TYPE_LABELS.map((rt) => {
                    const isActive = selectedRootTypes.has(rt.key);
                    return (
                      <label
                        key={rt.key}
                        className="flex items-center gap-2.5 px-4 py-2 cursor-pointer hover:bg-[#fafbfc] dark:hover:bg-white/3 transition-colors"
                      >
                        <span
                          className={`w-2 h-2 rounded-full shrink-0 ${isActive ? rootBadgeClasses(rt.key) : "bg-[#cbd5e1] dark:bg-white/15"}`}
                        />
                        <span className="flex-1 text-[13px] text-[#374151] dark:text-white/70 group-hover:text-[#1e293b] dark:group-hover:text-white transition-colors">
                          {rt.label}
                        </span>
                        <input
                          type="checkbox"
                          checked={isActive}
                          onChange={() => toggleRootType(rt.key)}
                          className="w-[18px] h-[18px] rounded cursor-pointer shrink-0"
                          style={{ accentColor: "#0d9488" }}
                        />
                      </label>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Card Rows */}
      <div className="px-6 py-4 space-y-2.5 max-h-[60vh] overflow-y-auto">
        {hasFilters && filteredGroups.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <span className="text-2xl mb-2">🔍</span>
            <p className="text-sm font-medium text-[#1e293b] dark:text-white">
              No subtypes match your filters
            </p>
            <p className="text-xs text-[#64748b] dark:text-white/50 mt-1">
              Try adjusting your search or clearing filters
            </p>
          </div>
        )}
        {filteredGroups.map((group) => (
          <div key={group.label}>
            {/* Group label */}
            <div className="pt-2 pb-1.5">
              <span className="text-[11px] font-bold text-[#94a3b8] dark:text-white/40 uppercase tracking-wider">
                {group.label}
              </span>
            </div>

            {/* Rows */}
            <div className="space-y-2">
              {group.subtypes.map((subtype) => {
                const activeReadTypes = resolvedReadMap[subtype] ?? [];
                const activeMutateTypes = resolvedMutateMap[subtype] ?? [];
                const isModified = overrides[subtype] !== undefined;
                const rootCategory = SUBTYPE_TO_ROOT[subtype] ?? "asset";
                const isExpanded = expandedSubtypes.has(subtype);
                const subtypeAccounts = accountsBySubtype[subtype] ?? [];
                const hasAccountOverrides = subtypeAccounts.some(
                  (a: any) => a.readPartyTypes != null || a.mutatePartyTypes != null,
                );

                return (
                  <div key={subtype}>
                    {/* Subtype row */}
                    <div className="flex items-center gap-3 px-4 py-3 rounded-xl border border-[#e2e8f0] dark:border-white/8 bg-[#fafbfc] dark:bg-[#0f172a]/50">
                      {/* Expand toggle */}
                      {subtypeAccounts.length > 0 ? (
                        <button
                          type="button"
                          onClick={() => toggleExpand(subtype)}
                          className="w-5 h-5 flex items-center justify-center rounded text-[#94a3b8] dark:text-white/30 hover:text-[#1e293b] dark:hover:text-white hover:bg-[#f1f5f9] dark:hover:bg-white/5 transition-all shrink-0"
                        >
                          <svg
                            width="12"
                            height="12"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            style={{
                              transform: isExpanded ? "rotate(90deg)" : "rotate(0deg)",
                              transition: "transform 0.15s ease",
                            }}
                          >
                            <polyline points="9 18 15 12 9 6" />
                          </svg>
                        </button>
                      ) : (
                        <div className="w-5 shrink-0" />
                      )}

                      {/* Type label */}
                      <div className="w-44 shrink-0 flex items-center gap-2">
                        <span className="text-base">{SUBTYPE_ICONS[subtype] ?? "📄"}</span>
                        <span className="text-sm font-medium text-[#1e293b] dark:text-white">
                          {formatSubtype(subtype)}
                        </span>
                        {isModified && (
                          <span className="w-1.5 h-1.5 rounded-full bg-[#0d9488] dark:bg-teal-400 shrink-0" />
                        )}
                        {hasAccountOverrides && (
                          <span
                            className="text-[10px] px-1.5 py-0.5 rounded bg-amber-50 dark:bg-amber-900/20 text-amber-600 dark:text-amber-400 font-semibold shrink-0"
                            title="One or more categories have account-level overrides"
                          >
                            🏷️
                          </span>
                        )}
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
                        className="text-[#cbd5e1] dark:text-white/20 shrink-0"
                      >
                        <polyline points="9 18 15 12 9 6" />
                      </svg>

                      {/* Read + Mutate comboboxes */}
                      <div className="flex-1 min-w-0 flex gap-2 items-center">
                        <div className="flex-1 min-w-0">
                          <div className="text-[9px] font-semibold text-[#94a3b8] dark:text-white/30 uppercase tracking-wider mb-0.5">
                            Read
                          </div>
                          <PartyTypeCombobox
                            activeTypes={activeReadTypes}
                            onToggle={(pt) => handleToggle(subtype, pt, "read")}
                            onPromote={(pt) => handlePromote(subtype, pt, "read")}
                          />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-[9px] font-semibold text-[#94a3b8] dark:text-white/30 uppercase tracking-wider mb-0.5">
                            Create
                          </div>
                          <PartyTypeCombobox
                            activeTypes={activeMutateTypes}
                            onToggle={(pt) => handleToggle(subtype, pt, "mutate")}
                            onPromote={(pt) => handlePromote(subtype, pt, "mutate")}
                          />
                        </div>
                      </div>

                      {/* Root category badge */}
                      <span
                        className={`text-[10px] font-semibold px-2 py-0.5 rounded shrink-0 uppercase tracking-wide ${rootBadgeClasses(rootCategory)}`}
                      >
                        {rootBadgeLabel(rootCategory)}
                      </span>
                    </div>

                    {/* Expanded: individual category rows — dual comboboxes */}
                    {isExpanded && subtypeAccounts.length > 0 && (
                      <div className="ml-7 mt-1 space-y-1 mb-2">
                        {subtypeAccounts.map((acct: any) => {
                          const acctReadTypes = (acct.readPartyTypes as string[] | null) ?? null;
                          const acctMutateTypes =
                            (acct.mutatePartyTypes as string[] | null) ?? null;
                          const hasOverride = acctReadTypes != null || acctMutateTypes != null;
                          // Effective types: account override or inherit from parent
                          const effectiveRead = acctReadTypes ?? activeReadTypes;
                          const effectiveMutate = acctMutateTypes ?? activeMutateTypes;

                          return (
                            <div
                              key={acct.id}
                              className="flex items-center gap-3 px-4 py-2.5 rounded-lg border border-dashed border-[#e2e8f0] dark:border-white/6 bg-white dark:bg-[#0f172a]/30"
                            >
                              {/* Account info */}
                              <div className="w-40 shrink-0 flex items-center gap-2 min-w-0">
                                {acct.accountNumber && (
                                  <span className="text-[10px] font-mono text-[#94a3b8] dark:text-white/30">
                                    {acct.accountNumber}
                                  </span>
                                )}
                                <span className="text-xs font-medium text-[#475569] dark:text-white/70 truncate">
                                  {acct.name}
                                </span>
                                {hasOverride && (
                                  <span
                                    className="text-[9px] px-1.5 py-0.5 rounded bg-teal-50 dark:bg-teal-900/20 text-teal-600 dark:text-teal-400 font-semibold shrink-0"
                                    title="Account-level override (Tier 1)"
                                  >
                                    🏷️
                                  </span>
                                )}
                              </div>

                              {/* Arrow */}
                              <svg
                                width="12"
                                height="12"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                className="text-[#cbd5e1] dark:text-white/15 shrink-0"
                              >
                                <polyline points="9 18 15 12 9 6" />
                              </svg>

                              {/* Dual account-level comboboxes */}
                              <div className="flex-1 min-w-0 flex gap-2 items-center">
                                <div className="flex-1 min-w-0">
                                  <div className="text-[9px] font-semibold text-[#94a3b8] dark:text-white/30 uppercase tracking-wider mb-0.5">
                                    Read
                                  </div>
                                  <PartyTypeCombobox
                                    activeTypes={effectiveRead as PartyType[]}
                                    onToggle={(pt) =>
                                      handleAccountToggle(acct.id, pt, "read", acctReadTypes)
                                    }
                                    onPromote={() => {}}
                                  />
                                </div>
                                <div className="flex-1 min-w-0">
                                  <div className="text-[9px] font-semibold text-[#94a3b8] dark:text-white/30 uppercase tracking-wider mb-0.5">
                                    Create
                                  </div>
                                  <PartyTypeCombobox
                                    activeTypes={effectiveMutate as PartyType[]}
                                    onToggle={(pt) =>
                                      handleAccountToggle(acct.id, pt, "mutate", acctMutateTypes)
                                    }
                                    onPromote={() => {}}
                                  />
                                </div>
                              </div>

                              {/* Clear override button */}
                              {hasOverride && (
                                <button
                                  type="button"
                                  onClick={() => {
                                    accountUpdateMutation.mutate({
                                      id: acct.id,
                                      readPartyTypes: null,
                                      mutatePartyTypes: null,
                                    });
                                    queryClient.setQueryData(
                                      ["accounts", "flat-for-parties"],
                                      (prev: any[]) =>
                                        prev?.map((a: any) =>
                                          a.id === acct.id
                                            ? { ...a, readPartyTypes: null, mutatePartyTypes: null }
                                            : a,
                                        ),
                                    );
                                  }}
                                  className="text-[10px] text-[#94a3b8] dark:text-white/30 hover:text-[#ef4444] dark:hover:text-red-400 transition-colors shrink-0"
                                  title="Clear account-level overrides"
                                >
                                  ✕ Clear
                                </button>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {/* Footer */}
      <div className="px-6 py-3 border-t border-[#e2e8f0] dark:border-white/10">
        <p className="text-[11px] text-[#94a3b8] dark:text-white/30">
          Changes apply immediately · Expand subtypes to set per-category overrides
        </p>
      </div>
    </>
  );
}

// ============================================================================
// Unmapped-row indicator
// ============================================================================

function UnmappedBanner({ config }: { config: MappingConfig }) {
  const sourceKeys = config.rows.map((row) => row.type);
  const { data } = useQuery<Record<string, string | null>>({
    queryKey: queryKeys.categoryMappings.resolved(config.mappingType, sourceKeys),
    queryFn: () =>
      (getMappedAccounts as (opts: { data: unknown }) => Promise<Record<string, string | null>>)({
        data: { mappingType: config.mappingType, sourceKeys },
      }),
    staleTime: 60_000,
  });

  if (!data) return null;
  const unmapped = config.rows.filter((row) => !data[row.type]);
  if (unmapped.length === 0) return null;

  return (
    <div className="mx-6 mt-4 rounded-lg border border-amber-300 bg-amber-50 dark:border-amber-500/40 dark:bg-amber-950/30 px-3 py-2">
      <div className="text-xs font-semibold text-amber-800 dark:text-amber-200">
        {unmapped.length} of {config.rows.length} still have no account
      </div>
      <div className="text-[11px] text-amber-700 dark:text-amber-300 mt-0.5">
        {unmapped.map((row) => row.label).join(", ")}. Anything that posts through these will fail
        until they are set — applying a chart-of-accounts template fills them all in.
      </div>
    </div>
  );
}
