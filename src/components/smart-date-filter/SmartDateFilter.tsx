/**
 * SmartDateFilter — Combo box date picker with presets, AI parsing, & granularity tabs
 *
 * Features:
 * - Type-to-filter presets (Today, This Month, Last Quarter, etc.)
 * - Keyboard navigation (↑↓ navigate, Enter select, Esc close)
 * - AI mode: Alt+Enter sends natural language to Gemini (e.g. "all wednesdays in Jan 2026")
 * - Granularity tabs: Day (dual-month calendar range), Month, Quarter, Year
 * - Custom date range with start/end inputs
 */

import { useState, useRef, useEffect, useCallback } from "react";
import type { DateGranularity, AIDateParseResult, DatePreset } from "./types";
import { getPresetList, computePreset, computeGranularityRange, formatRangeLabel } from "./presets";
import { createPortal } from "react-dom";
import { parseNaturalDate } from "../../routes/api/-ai-date-parse";
import { usePermission } from "../../lib/use-permission";

// ============================================================================
// Props
// ============================================================================

interface SmartDateFilterProps {
  dateFrom: string;
  dateTo: string;
  onChange: (from: string, to: string) => void;
  /** Override the displayed label */
  label?: string;
  /** When true, hide the dropdown chevron arrow */
  hideChevron?: boolean;
  /** Optional class name to style the trigger button */
  className?: string;
}

// ============================================================================
// Sub-views
// ============================================================================

type FilterView = "presets" | "custom" | "granularity";

// ============================================================================
// Component
// ============================================================================

export default function SmartDateFilter({
  dateFrom,
  dateTo,
  onChange,
  label,
  hideChevron,
  className = "",
}: SmartDateFilterProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [view, setView] = useState<FilterView>("presets");
  const [query, setQuery] = useState("");
  const [highlightIndex, setHighlightIndex] = useState(0);
  const [granularity, setGranularity] = useState<DateGranularity>("day");
  const [granYear, setGranYear] = useState(() => new Date().getFullYear());
  const [customFrom, setCustomFrom] = useState(dateFrom);
  const [customTo, setCustomTo] = useState(dateTo);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiResult, setAiResult] = useState<AIDateParseResult | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);
  const { canAccess: aiEnabled } = usePermission("aiTask", "run");

  const [popoverPos, setPopoverPos] = useState<{ top: number; left: number; width: number } | null>(
    null,
  );

  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Sync custom inputs when props change
  useEffect(() => {
    setCustomFrom(dateFrom);
    setCustomTo(dateTo);
  }, [dateFrom, dateTo]);

  // Focus input when popover opens
  useEffect(() => {
    if (isOpen && inputRef.current) {
      // Small timeout to allow portal to render
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen, view]);

  // Calculate position when opening (with edge-aware boundary checks)
  useEffect(() => {
    if (isOpen && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      const popoverWidth = 320; // default popover width
      const popoverHeight = 400; // estimated max popover height
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const gap = 6;

      // Horizontal: prefer left-aligned, but clamp to viewport
      let left = rect.left;
      if (left + popoverWidth > vw - 12) {
        // Would overflow right edge — align to right edge of trigger
        left = Math.max(12, rect.right - popoverWidth);
      }

      // Vertical: prefer below trigger, flip above if insufficient space
      const spaceBelow = vh - rect.bottom - gap;
      const spaceAbove = rect.top - gap;
      let top: number;
      if (spaceBelow >= popoverHeight || spaceBelow >= spaceAbove) {
        top = rect.bottom + gap;
      } else {
        top = rect.top - gap - Math.min(popoverHeight, spaceAbove);
      }

      setPopoverPos({
        top,
        left,
        width: rect.width,
      });
    }
  }, [isOpen]);

  // Handle window resize / scroll to close or reposition (simplified: just close on resize)
  useEffect(() => {
    const handleResize = () => setIsOpen(false);
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  // Close on click outside
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      // Check if click is inside popover or trigger
      if (popoverRef.current && popoverRef.current.contains(e.target as Node)) {
        return;
      }
      if (triggerRef.current && triggerRef.current.contains(e.target as Node)) {
        return;
      }

      // If in granularity view, only strict cancel/set closes it (per requirements),
      // BUT typically clicking outside should close it. The original code said:
      // "Granularity view (which shows calendar) is closed by Cancel / Set only"
      // We will preserve that logic.
      if (view === "granularity") {
        return;
      }

      setIsOpen(false);
      setView("presets");
      setQuery("");
      setAiResult(null);
      setAiError(null);
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen, view]);

  // Filter presets by query
  const presets = getPresetList();
  const filtered = query.trim()
    ? presets.filter((p) => p.label.toLowerCase().includes(query.toLowerCase()))
    : presets;

  // Reset highlight when filter changes
  useEffect(() => {
    setHighlightIndex(0);
  }, [query]);

  // ── Handlers ──────────────────────────────────────────────────────────

  const handleSelectPreset = useCallback(
    (presetValue: string) => {
      const result = computePreset(presetValue as DatePreset);
      onChange(result.from, result.to);
      setIsOpen(false);
      setQuery("");
      setView("presets");
      setAiResult(null);
      setAiError(null);
    },
    [onChange],
  );

  const handleGranularitySelect = useCallback(
    (value: number) => {
      const result = computeGranularityRange(granularity, granYear, value);
      onChange(result.from, result.to);
      setIsOpen(false);
      setQuery("");
      setView("presets");
    },
    [granularity, granYear, onChange],
  );

  const handleCustomApply = useCallback(() => {
    onChange(customFrom, customTo);
    setIsOpen(false);
    setQuery("");
    setView("presets");
  }, [customFrom, customTo, onChange]);

  const handleAiParse = useCallback(async () => {
    if (!aiEnabled || !query.trim()) return;
    setAiLoading(true);
    setAiError(null);
    setAiResult(null);

    try {
      const today = new Date();
      const y = today.getFullYear();
      const m = String(today.getMonth() + 1).padStart(2, "0");
      const day = String(today.getDate()).padStart(2, "0");
      const currentDate = `${y}-${m}-${day}`;

      const result = (await parseNaturalDate({
        data: { query: query.trim(), currentDate },
      })) as any;

      setAiResult(result);

      // Auto-apply
      if (result.type === "single") {
        onChange(result.start_date, result.start_date);
      } else if (result.type === "range" && result.end_date) {
        onChange(result.start_date, result.end_date);
      } else if (result.type === "multiple" && result.dates && result.dates.length > 0) {
        // For multiple dates, use the min and max as the range
        const sorted = [...result.dates].sort();
        onChange(sorted[0], sorted[sorted.length - 1]);
      } else if (result.start_date && result.end_date) {
        // Fallback: AI returned start+end without dates array (e.g. interpreted as a span)
        onChange(result.start_date, result.end_date);
      } else if (result.start_date) {
        onChange(result.start_date, result.start_date);
      }

      // Keep open briefly to show result, then close
      setTimeout(() => {
        setIsOpen(false);
        setQuery("");
        setView("presets");
        setAiResult(null);
      }, 1500);
    } catch (err) {
      setAiError(err instanceof Error ? err.message : "AI parsing failed");
    } finally {
      setAiLoading(false);
    }
  }, [aiEnabled, query, onChange]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (view !== "presets") return;

      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setHighlightIndex((prev) => (prev < filtered.length - 1 ? prev + 1 : prev));
          break;
        case "ArrowUp":
          e.preventDefault();
          setHighlightIndex((prev) => (prev > 0 ? prev - 1 : 0));
          break;
        case "Enter":
          e.preventDefault();
          if (e.altKey || e.metaKey || e.ctrlKey) {
            // AI mode — Alt+Enter, Cmd+Enter, or Ctrl+Enter
            handleAiParse();
          } else if (filtered[highlightIndex]) {
            handleSelectPreset(filtered[highlightIndex].value);
          } else if (query.trim()) {
            // No matching presets — plain Enter triggers AI parse
            handleAiParse();
          }
          break;
        case "Escape":
          e.preventDefault();
          setIsOpen(false);
          setQuery("");
          setView("presets");
          setAiResult(null);
          setAiError(null);
          break;
      }
    },
    [view, filtered, highlightIndex, handleSelectPreset, handleAiParse],
  );

  // ── Display label ─────────────────────────────────────────────────────

  const displayLabel = label ?? formatRangeLabel(dateFrom, dateTo);

  // ── Render ─────────────────────────────────────────────────────────────

  // Portal content
  const popoverContent = isOpen && popoverPos && (
    <div
      ref={popoverRef}
      className="fixed z-[9999] bg-white dark:bg-slate-900 rounded-xl shadow-[0_8px_30px_rgba(0,0,0,0.12),0_2px_8px_rgba(0,0,0,0.08)] dark:shadow-[0_8px_30px_rgba(0,0,0,0.4)] border border-[#e5e7eb] dark:border-slate-700 overflow-hidden animate-[sdfSlideDown_0.15s_ease-out]"
      style={{
        top: popoverPos.top,
        left: popoverPos.left,
        width: view === "granularity" && granularity === "day" ? "580px" : "320px",
        // Ensure it doesn't go off screen (basic)
        maxWidth: "calc(100vw - 24px)",
      }}
    >
      {view === "presets" && (
        <PresetView
          query={query}
          onQueryChange={setQuery}
          filtered={filtered}
          highlightIndex={highlightIndex}
          onSelect={handleSelectPreset}
          onKeyDown={handleKeyDown}
          onGranularity={() => setView("granularity")}
          onCancel={() => {
            setIsOpen(false);
            setQuery("");
            setAiResult(null);
            setAiError(null);
          }}
          onClear={() => {
            const now = new Date();
            const from = new Date(now.getFullYear(), now.getMonth() - 11, 1);
            const to = new Date(now.getFullYear(), now.getMonth() + 1, 0);
            const fmtD = (d: Date) => {
              const y = d.getFullYear();
              const m = String(d.getMonth() + 1).padStart(2, "0");
              const day = String(d.getDate()).padStart(2, "0");
              return `${y}-${m}-${day}`;
            };
            onChange(fmtD(from), fmtD(to));
            setIsOpen(false);
            setQuery("");
          }}
          inputRef={inputRef}
          aiEnabled={aiEnabled}
          aiLoading={aiLoading}
          aiResult={aiResult}
          aiError={aiError}
          onAiParse={handleAiParse}
          setHighlightIndex={setHighlightIndex}
        />
      )}

      {view === "custom" && (
        <CustomRangeView
          customFrom={customFrom}
          customTo={customTo}
          onFromChange={setCustomFrom}
          onToChange={setCustomTo}
          onApply={handleCustomApply}
          onBack={() => setView("presets")}
          onCancel={() => {
            setIsOpen(false);
            setView("presets");
          }}
        />
      )}

      {view === "granularity" && (
        <GranularityView
          granularity={granularity}
          onGranularityChange={setGranularity}
          year={granYear}
          onYearChange={setGranYear}
          onSelect={handleGranularitySelect}
          onBack={() => setView("presets")}
          onCancel={() => {
            setIsOpen(false);
            setView("presets");
          }}
          dateFrom={dateFrom}
          dateTo={dateTo}
          onRangeSet={(from, to) => {
            onChange(from, to);
            setIsOpen(false);
            setView("presets");
          }}
        />
      )}
    </div>
  );

  return (
    <>
      {/* Trigger button */}
      <button
        ref={triggerRef}
        type="button"
        data-testid="smart-date-filter-trigger"
        onClick={() => setIsOpen(!isOpen)}
        // `min-w-0` so the label below can actually truncate: a full-year range renders as
        // "Aug 1, 2025 – Jul 31, 2026", which is wider than the space this trigger gets inside
        // the ledger header on a phone.
        className={`flex min-w-0 items-center gap-2 rounded-lg border px-3 py-1.5 transition-colors ${
          className ||
          "hover:bg-[#f1f5f9] dark:hover:bg-slate-800 border-transparent hover:border-[#e2e8f0] dark:hover:border-slate-700"
        }`}
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
          <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
          <line x1="16" y1="2" x2="16" y2="6" />
          <line x1="8" y1="2" x2="8" y2="6" />
          <line x1="3" y1="10" x2="21" y2="10" />
        </svg>
        <span
          className={`truncate text-[13px] font-medium ${className?.includes("text-white") ? "text-current" : "text-[#1e293b] dark:text-slate-100"}`}
        >
          {displayLabel}
        </span>
        {!hideChevron && (
          <svg
            width="10"
            height="10"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        )}
      </button>

      {/* Popover Portal */}
      {typeof document !== "undefined" && createPortal(popoverContent, document.body)}

      {/* Animation keyframes (injected once) */}
      <style>{`
        @keyframes sdfSlideDown {
          from { opacity: 0; transform: translateY(-4px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes sdfSpin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </>
  );
}

// ============================================================================
// PresetView — Main combo box list with search input
// ============================================================================

function PresetView({
  query,
  onQueryChange,
  filtered,
  highlightIndex,
  onSelect,
  onKeyDown,

  onGranularity,
  onCancel,
  onClear,
  inputRef,
  aiEnabled,
  aiLoading,
  aiResult,
  aiError,
  onAiParse,
  setHighlightIndex,
}: {
  query: string;
  onQueryChange: (q: string) => void;
  filtered: ReturnType<typeof getPresetList>;
  highlightIndex: number;
  onSelect: (value: string) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;

  onGranularity: () => void;
  onCancel: () => void;
  onClear: () => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
  aiEnabled: boolean;
  aiLoading: boolean;
  aiResult: AIDateParseResult | null;
  aiError: string | null;
  onAiParse: () => void;
  setHighlightIndex: (i: number) => void;
}) {
  return (
    <div>
      {/* Search input */}
      <div className="p-2 border-b border-[#f1f5f9] dark:border-slate-800">
        <div className="relative">
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={aiEnabled ? "Type to filter or search with AI..." : "Type to filter..."}
            className="w-full px-3 py-2 text-base sm:text-sm bg-[#f8fafc] dark:bg-slate-800 border border-[#e2e8f0] dark:border-slate-700 rounded-lg outline-none focus:border-[#2a9d8f] focus:ring-1 focus:ring-[#2a9d8f]/20 transition-all placeholder:text-[#94a3b8] dark:placeholder:text-slate-500 text-[#1e293b] dark:text-slate-100"
          />
          {aiLoading && (
            <div className="absolute right-2.5 top-1/2 -translate-y-1/2">
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                style={{ animation: "sdfSpin 0.8s linear infinite" }}
              >
                <circle cx="12" cy="12" r="10" stroke="#2a9d8f" strokeWidth="3" opacity="0.25" />
                <path
                  d="M12 2a10 10 0 019.95 9"
                  stroke="#2a9d8f"
                  strokeWidth="3"
                  strokeLinecap="round"
                />
              </svg>
            </div>
          )}
        </div>

        {/* Keyboard hints */}
        <div className="flex flex-wrap items-center gap-3 mt-2 px-2 py-2 border-t border-[#f1f5f9] dark:border-slate-700">
          <span className="text-[10px] text-[#94a3b8] dark:text-slate-500">
            <kbd className="px-1 py-0.5 bg-[#f1f5f9] dark:bg-slate-800 rounded text-[9px] font-mono border border-[#e2e8f0] dark:border-slate-700">
              ↑↓
            </kbd>{" "}
            Navigate
          </span>
          <span className="text-[10px] text-[#94a3b8] dark:text-slate-500">
            <kbd className="px-1 py-0.5 bg-[#f1f5f9] dark:bg-slate-800 rounded text-[9px] font-mono border border-[#e2e8f0] dark:border-slate-700">
              Enter
            </kbd>{" "}
            Select
          </span>
          <span className="text-[10px] text-[#94a3b8] dark:text-slate-500">
            <kbd className="px-1 py-0.5 bg-[#f1f5f9] dark:bg-slate-800 rounded text-[9px] font-mono border border-[#e2e8f0] dark:border-slate-700">
              Esc
            </kbd>{" "}
            Cancel
          </span>
          {aiEnabled && (
            <span className="text-[10px] text-[#94a3b8] dark:text-slate-500">
              <kbd className="px-1 py-0.5 bg-[#f1f5f9] dark:bg-slate-800 rounded text-[9px] font-mono border border-[#e2e8f0] dark:border-slate-700">
                ⌘/Ctrl+↵
              </kbd>{" "}
              AI parse
            </span>
          )}
          {aiEnabled && query.trim() && !aiLoading && (
            <button
              type="button"
              onClick={onAiParse}
              className="text-[10px] text-[var(--color-app-header-teal)] hover:text-[#248f82] font-medium transition-colors"
            >
              ✨ Ask AI
            </button>
          )}
        </div>
      </div>

      {/* AI result / error */}
      {aiResult && (
        <div className="mx-2 mt-2 p-2.5 bg-[#e6f7f5] dark:bg-teal-900/20 border border-[#b2e0db] dark:border-teal-700/50 rounded-lg">
          <div className="flex items-center gap-1.5 mb-1">
            <span className="text-[11px] font-semibold text-[#1f7a6f] dark:text-teal-400">
              ✨ AI Resolved
            </span>
            <span className="text-[10px] px-1.5 py-0.5 bg-[#2a9d8f] text-white rounded-full font-medium">
              {Math.round(aiResult.confidence * 100)}%
            </span>
          </div>
          <p className="text-[11px] text-[#334155] dark:text-slate-300">
            {aiResult.interpretation}
          </p>
          {aiResult.type === "multiple" && aiResult.dates && (
            <p className="text-[10px] text-[#64748b] mt-0.5">{aiResult.dates.length} dates found</p>
          )}
        </div>
      )}

      {aiError && (
        <div className="mx-2 mt-2 p-2.5 bg-[#fef2f2] dark:bg-red-950/20 border border-[#fecaca] dark:border-red-800/50 rounded-lg">
          <p className="text-[11px] text-[#dc2626]">{aiError}</p>
        </div>
      )}

      {/* Preset list */}
      <div className="max-h-[240px] overflow-y-auto py-1">
        {filtered.map((preset, idx) => (
          <button
            key={preset.value}
            type="button"
            onClick={() => onSelect(preset.value)}
            onMouseEnter={() => setHighlightIndex(idx)}
            className={`w-full text-left px-4 py-2 text-[13px] transition-colors ${
              idx === highlightIndex
                ? "bg-[#f0fdfa] dark:bg-emerald-950/40 text-[#1f7a6f] dark:text-emerald-400 font-medium"
                : "text-[#374151] dark:text-slate-300 hover:bg-[#f9fafb] dark:hover:bg-slate-800"
            }`}
          >
            {preset.label}
          </button>
        ))}

        {filtered.length === 0 && !query.trim() && (
          <p className="px-4 py-3 text-[12px] text-[#94a3b8] text-center">No presets available</p>
        )}

        {filtered.length === 0 && query.trim() && (
          <div className="px-4 py-3 text-center">
            <p className="text-[12px] text-[#94a3b8]">No presets match &ldquo;{query}&rdquo;</p>
            {aiEnabled && (
              <button
                type="button"
                onClick={onAiParse}
                disabled={aiLoading}
                className="mt-1.5 text-[12px] text-[#2a9d8f] hover:text-[#1f7a6f] font-medium transition-colors"
              >
                {aiLoading ? "Parsing..." : "✨ Try AI to resolve this"}
              </button>
            )}
          </div>
        )}
      </div>

      {/* Divider + extra options */}
      <div className="border-t border-[#f1f5f9] dark:border-slate-800">
        <button
          type="button"
          onClick={onGranularity}
          className="w-full text-left px-4 py-2 text-[13px] text-[#374151] dark:text-slate-300 hover:bg-[#f9fafb] dark:hover:bg-slate-800 transition-colors flex items-center gap-2"
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#64748b"
            strokeWidth="2"
          >
            <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
            <line x1="16" y1="2" x2="16" y2="6" />
            <line x1="8" y1="2" x2="8" y2="6" />
            <line x1="3" y1="10" x2="21" y2="10" />
          </svg>
          Custom
        </button>
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between px-3 py-2 border-t border-[#e5e7eb] dark:border-slate-700 bg-[#fafbfc] dark:bg-slate-800/50">
        <button
          type="button"
          onClick={onCancel}
          className="px-3 py-1 text-[12px] text-[#64748b] hover:text-[#374151] transition-colors"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onClear}
          className="px-3 py-1 text-[12px] text-[#64748b] hover:text-[#374151] transition-colors"
        >
          Clear
        </button>
      </div>
    </div>
  );
}

// ============================================================================
// CustomRangeView — Start / End date inputs
// ============================================================================

function CustomRangeView({
  customFrom,
  customTo,
  onFromChange,
  onToChange,
  onApply,
  onBack,
  onCancel,
}: {
  customFrom: string;
  customTo: string;
  onFromChange: (d: string) => void;
  onToChange: (d: string) => void;
  onApply: () => void;
  onBack: () => void;
  onCancel: () => void;
}) {
  return (
    <div>
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-[#e5e7eb] dark:border-slate-700">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1 text-[12px] text-[#64748b] hover:text-[#374151] transition-colors"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <span className="text-[13px] font-semibold text-[#1e293b] dark:text-slate-100">
          Custom Date Range
        </span>
      </div>

      {/* Date inputs */}
      <div className="p-4 space-y-3">
        <div>
          <label className="block text-[11px] font-medium text-[#64748b] mb-1 uppercase tracking-wide">
            Start Date
          </label>
          <input
            type="date"
            value={customFrom}
            onChange={(e) => onFromChange(e.target.value)}
            className="w-full px-3 py-2 text-base sm:text-sm border border-[#e2e8f0] dark:border-slate-700 rounded-lg outline-none bg-white dark:bg-slate-800 text-[#1e293b] dark:text-slate-100 focus:border-[#2a9d8f] focus:ring-1 focus:ring-[#2a9d8f]/20 transition-all"
          />
        </div>
        <div>
          <label className="block text-[11px] font-medium text-[#64748b] mb-1 uppercase tracking-wide">
            End Date
          </label>
          <input
            type="date"
            value={customTo}
            onChange={(e) => onToChange(e.target.value)}
            className="w-full px-3 py-2 text-base sm:text-sm border border-[#e2e8f0] dark:border-slate-700 rounded-lg outline-none bg-white dark:bg-slate-800 text-[#1e293b] dark:text-slate-100 focus:border-[#2a9d8f] focus:ring-1 focus:ring-[#2a9d8f]/20 transition-all"
          />
        </div>
      </div>

      {/* Shortcut hints */}
      <div className="px-4 pb-2">
        <div className="flex items-center gap-2 text-[10px] text-[#94a3b8]">
          <button type="button" onClick={onBack} className="hover:text-[#374151] transition-colors">
            ← Back
          </button>
          <span>·</span>
          <span>Ctrl+Enter: Apply</span>
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center justify-end gap-2 px-3 py-2 border-t border-[#e5e7eb] dark:border-slate-700 bg-[#fafbfc] dark:bg-slate-800/50">
        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-1.5 text-[12px] text-[#64748b] hover:text-[#374151] transition-colors"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onApply}
          className="px-4 py-1.5 text-[12px] font-semibold text-white bg-[#2a9d8f] rounded-lg hover:bg-[#238b7f] transition-colors"
        >
          Apply
        </button>
      </div>
    </div>
  );
}

// ============================================================================
// GranularityView — Day / Month / Quarter / Year tabs
// ============================================================================

const MONTH_NAMES_FULL = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const MONTH_ABBR = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

const GRANULARITY_TABS: { value: DateGranularity; label: string }[] = [
  { value: "day", label: "Day" },
  { value: "month", label: "Month" },
  { value: "quarter", label: "Quarter" },
  { value: "year", label: "Year" },
];

// ── Calendar helpers ──────────────────────────────────────────────────────

function getDaysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

function getStartDayOfWeek(year: number, month: number): number {
  return new Date(year, month, 1).getDay(); // 0=Sun
}

function toDateStr(year: number, month: number, day: number): string {
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function parseDateStr(s: string): { year: number; month: number; day: number } {
  const [y, m, d] = s.split("-").map(Number);
  return { year: y, month: m - 1, day: d };
}

function isSameDay(a: string, b: string): boolean {
  return a === b;
}

function isInRange(dateStr: string, start: string, end: string): boolean {
  return dateStr >= start && dateStr <= end;
}

const TODAY = new Date();
const TODAY_STR = toDateStr(TODAY.getFullYear(), TODAY.getMonth(), TODAY.getDate());

// ── Dual-month calendar (Day tab) ─────────────────────────────────────────

function DayCalendarView({
  dateFrom,
  dateTo,
  onCancel,
  onSet,
  onBack: _onBack,
}: {
  dateFrom: string;
  dateTo: string;
  onCancel: () => void;
  onSet: (from: string, to: string) => void;
  onBack: () => void;
}) {
  // The two visible months: left and right
  const initial = parseDateStr(dateFrom);
  const [leftYear, setLeftYear] = useState(initial.year);
  const [leftMonth, setLeftMonth] = useState(initial.month);

  // Range selection state
  const [rangeStart, setRangeStart] = useState<string | null>(dateFrom);
  const [rangeEnd, setRangeEnd] = useState<string | null>(dateTo);
  const [hoverDate, setHoverDate] = useState<string | null>(null);

  // right month is always leftMonth + 1
  const rightYear = leftMonth === 11 ? leftYear + 1 : leftYear;
  const rightMonth = leftMonth === 11 ? 0 : leftMonth + 1;

  // Can't navigate past current month
  const todayParsed = parseDateStr(TODAY_STR);
  const canGoForward =
    rightYear < todayParsed.year ||
    (rightYear === todayParsed.year && rightMonth < todayParsed.month);

  const handlePrevMonth = () => {
    if (leftMonth === 0) {
      setLeftYear(leftYear - 1);
      setLeftMonth(11);
    } else {
      setLeftMonth(leftMonth - 1);
    }
  };

  const handleNextMonth = () => {
    if (!canGoForward) return;
    if (leftMonth === 11) {
      setLeftYear(leftYear + 1);
      setLeftMonth(0);
    } else {
      setLeftMonth(leftMonth + 1);
    }
  };

  const handleDayClick = (dateStr: string) => {
    // Don't allow future dates
    if (dateStr > TODAY_STR) return;

    if (!rangeStart || (rangeStart && rangeEnd)) {
      // Starting a new selection
      setRangeStart(dateStr);
      setRangeEnd(null);
      setHoverDate(null);
    } else {
      // Completing the selection
      if (dateStr < rangeStart) {
        setRangeEnd(rangeStart);
        setRangeStart(dateStr);
      } else {
        setRangeEnd(dateStr);
      }
    }
  };

  const handleDayHover = (dateStr: string) => {
    if (rangeStart && !rangeEnd) {
      setHoverDate(dateStr);
    }
  };

  // Determine effective range for highlighting
  const effectiveStart = rangeStart ?? "";
  const effectiveEnd = rangeEnd ?? (rangeStart && hoverDate ? hoverDate : "");
  const highlightFrom = effectiveStart <= effectiveEnd ? effectiveStart : effectiveEnd;
  const highlightTo = effectiveStart <= effectiveEnd ? effectiveEnd : effectiveStart;

  const handleSet = () => {
    if (rangeStart && rangeEnd) {
      const from = rangeStart <= rangeEnd ? rangeStart : rangeEnd;
      const to = rangeStart <= rangeEnd ? rangeEnd : rangeStart;
      onSet(from, to);
    } else if (rangeStart) {
      onSet(rangeStart, rangeStart);
    }
  };

  return (
    <div>
      {/* Dual calendar grid */}
      <div className="flex gap-4 px-4 pt-3 pb-2">
        {/* Left month */}
        <MonthCalendar
          year={leftYear}
          month={leftMonth}
          highlightFrom={highlightFrom}
          highlightTo={highlightTo}
          rangeStart={effectiveStart}
          rangeEnd={rangeEnd ? effectiveEnd : ""}
          onDayClick={handleDayClick}
          onDayHover={handleDayHover}
          showNav={true}
          navSide="left"
          onPrev={handlePrevMonth}
        />
        {/* Right month */}
        <MonthCalendar
          year={rightYear}
          month={rightMonth}
          highlightFrom={highlightFrom}
          highlightTo={highlightTo}
          rangeStart={effectiveStart}
          rangeEnd={rangeEnd ? effectiveEnd : ""}
          onDayClick={handleDayClick}
          onDayHover={handleDayHover}
          showNav={true}
          navSide="right"
          onNext={canGoForward ? handleNextMonth : undefined}
        />
      </div>

      {/* Footer: Cancel / Set */}
      <div className="flex items-center justify-end gap-3 px-4 py-3 border-t border-[#e5e7eb] dark:border-slate-700">
        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-1.5 text-[13px] text-[#64748b] hover:text-[#374151] dark:hover:text-slate-200 transition-colors"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={handleSet}
          className="px-5 py-1.5 text-[13px] font-semibold text-white bg-[#2a9d8f] rounded-lg hover:bg-[#238b7f] transition-colors"
        >
          Set
        </button>
      </div>
    </div>
  );
}

// ── Single month calendar grid ─────────────────────────────────────────────

function MonthCalendar({
  year,
  month,
  highlightFrom,
  highlightTo,
  rangeStart,
  rangeEnd,
  onDayClick,
  onDayHover,
  showNav,
  navSide,
  onPrev,
  onNext,
}: {
  year: number;
  month: number;
  highlightFrom: string;
  highlightTo: string;
  rangeStart: string;
  rangeEnd: string;
  onDayClick: (dateStr: string) => void;
  onDayHover: (dateStr: string) => void;
  showNav?: boolean;
  navSide?: "left" | "right";
  onPrev?: () => void;
  onNext?: () => void;
}) {
  const daysInMonth = getDaysInMonth(year, month);
  const startDay = getStartDayOfWeek(year, month);

  const days: (number | null)[] = [];
  for (let i = 0; i < startDay; i++) {
    days.push(null);
  }
  for (let d = 1; d <= daysInMonth; d++) {
    days.push(d);
  }

  const DAY_HEADERS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

  return (
    <div className="w-[250px]">
      {/* Month/Year header with optional nav */}
      <div className="flex items-center justify-between mb-2">
        {showNav && navSide === "left" ? (
          <button
            type="button"
            onClick={onPrev}
            className="w-6 h-6 min-h-11 min-w-11 lg:min-h-0 lg:min-w-0 flex items-center justify-center text-[#64748b] hover:text-[#1e293b] dark:hover:text-slate-200 transition-colors rounded hover:bg-[#f1f5f9] dark:hover:bg-slate-800"
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
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
        ) : (
          <div className="w-6" />
        )}
        <span className="text-[13px] font-semibold text-[#1e293b] dark:text-slate-100">
          {MONTH_NAMES_FULL[month]} {year}
        </span>
        {showNav && navSide === "right" ? (
          onNext ? (
            <button
              type="button"
              onClick={onNext}
              className="w-6 h-6 min-h-11 min-w-11 lg:min-h-0 lg:min-w-0 flex items-center justify-center text-[#64748b] hover:text-[#1e293b] dark:hover:text-slate-200 transition-colors rounded hover:bg-[#f1f5f9] dark:hover:bg-slate-800"
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
                <polyline points="9 18 15 12 9 6" />
              </svg>
            </button>
          ) : (
            <div className="w-6 h-6 flex items-center justify-center text-[#d1d5db] dark:text-slate-700">
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
                <polyline points="9 18 15 12 9 6" />
              </svg>
            </div>
          )
        ) : (
          <div className="w-6" />
        )}
      </div>

      {/* Day-of-week headers */}
      <div className="grid grid-cols-7 mb-1">
        {DAY_HEADERS.map((dh) => (
          <div
            key={dh}
            className="text-center text-[11px] font-medium text-[#94a3b8] dark:text-slate-500 py-1"
          >
            {dh}
          </div>
        ))}
      </div>

      {/* Day cells */}
      <div className="grid grid-cols-7">
        {days.map((day, idx) => {
          if (day === null) {
            return <div key={`e-${String(idx)}`} className="h-8" />;
          }

          const dateStr = toDateStr(year, month, day);
          const isFuture = dateStr > TODAY_STR;
          const isToday = isSameDay(dateStr, TODAY_STR);
          const isStart = isSameDay(dateStr, rangeStart);
          const isEnd = rangeEnd ? isSameDay(dateStr, rangeEnd) : false;
          const inRange =
            highlightFrom && highlightTo && isInRange(dateStr, highlightFrom, highlightTo);

          let cellBg = "";
          let cellText = "text-[#374151] dark:text-slate-300";
          let cellRound = "";

          if (isFuture) {
            cellText = "text-[#d1d5db] dark:text-slate-700";
          } else if (isStart || isEnd) {
            cellBg = "bg-[#1a5c53] dark:bg-[#1a5c53]";
            cellText = "text-white font-semibold";
            cellRound = isStart ? "rounded-l-full" : "rounded-r-full";
            if (isStart && isEnd) cellRound = "rounded-full";
          } else if (inRange) {
            cellBg = "bg-[#d5f0ed] dark:bg-slate-700/60";
            cellText = "text-[#1a5c53] dark:text-slate-200 font-medium";
          }

          return (
            <button
              key={dateStr}
              type="button"
              disabled={isFuture}
              onClick={() => onDayClick(dateStr)}
              onMouseEnter={() => onDayHover(dateStr)}
              className={`h-8 min-h-11 lg:min-h-0 flex items-center justify-center text-[12px] transition-all ${cellBg} ${cellText} ${cellRound} ${
                isFuture
                  ? "cursor-not-allowed"
                  : "hover:bg-[#e2e8f0] dark:hover:bg-slate-700 cursor-pointer"
              } ${isToday && !isStart && !isEnd ? "underline underline-offset-2" : ""}`}
            >
              {day}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── GranularityView (wraps Day calendar + Month/Quarter/Year pickers) ─────

function GranularityView({
  granularity,
  onGranularityChange,
  year,
  onYearChange,
  onSelect: _onSelect,
  onBack,
  onCancel,
  dateFrom,
  dateTo,
  onRangeSet,
}: {
  granularity: DateGranularity;
  onGranularityChange: (g: DateGranularity) => void;
  year: number;
  onYearChange: (y: number) => void;
  onSelect: (value: number) => void;
  onBack: () => void;
  onCancel: () => void;
  dateFrom: string;
  dateTo: string;
  onRangeSet: (from: string, to: string) => void;
}) {
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth();
  const currentQuarter = Math.floor(currentMonth / 3) + 1;

  // ── Range selection state for Month/Quarter/Year pickers ──
  // Each stores a "key" that uniquely identifies the cell:
  //   month: "YYYY-M" (0-based month)   quarter: "YYYY-Q" (1-based quarter)   year: "YYYY"
  const [rangeStart, setRangeStart] = useState<string | null>(null);
  const [rangeEnd, setRangeEnd] = useState<string | null>(null);

  // Reset selection when granularity changes
  useEffect(() => {
    setRangeStart(null);
    setRangeEnd(null);
  }, [granularity]);

  // ── Key helpers ──
  const monthKey = (y: number, m: number) => `${y}-${m}`;
  const quarterKey = (y: number, q: number) => `${y}-Q${q}`;
  const yearKey = (y: number) => `${y}`;

  // ── Ordering helpers (for range highlighting) ──
  const keyToOrder = (key: string): number => {
    if (granularity === "month") {
      const [y, m] = key.split("-").map(Number);
      return y * 12 + m;
    }
    if (granularity === "quarter") {
      const parts = key.split("-Q");
      return Number(parts[0]) * 4 + Number(parts[1]);
    }
    return Number(key);
  };

  const isInSelectionRange = (key: string): boolean => {
    if (!rangeStart) return false;
    const s = keyToOrder(rangeStart);
    const e = rangeEnd ? keyToOrder(rangeEnd) : s;
    const lo = Math.min(s, e);
    const hi = Math.max(s, e);
    const k = keyToOrder(key);
    return k >= lo && k <= hi;
  };

  const isRangeEndpoint = (key: string): boolean => {
    return key === rangeStart || key === rangeEnd;
  };

  // ── Click handler (two-click range selection) ──
  const handleCellClick = (key: string) => {
    if (!rangeStart || rangeEnd) {
      // First click or restarting
      setRangeStart(key);
      setRangeEnd(null);
    } else {
      // Second click — set end (swap if needed)
      const s = keyToOrder(rangeStart);
      const e = keyToOrder(key);
      if (e < s) {
        setRangeEnd(rangeStart);
        setRangeStart(key);
      } else {
        setRangeEnd(key);
      }
    }
  };

  // ── Compute date range from selection ──
  const computeSelectionRange = (): { from: string; to: string } | null => {
    if (!rangeStart) return null;
    const startKey = rangeStart;
    const endKey = rangeEnd ?? rangeStart;

    // Ensure correct order
    const sOrd = keyToOrder(startKey);
    const eOrd = keyToOrder(endKey);
    const lo = sOrd <= eOrd ? startKey : endKey;
    const hi = sOrd <= eOrd ? endKey : startKey;

    if (granularity === "month") {
      const [sy, sm] = lo.split("-").map(Number);
      const [ey, em] = hi.split("-").map(Number);
      const from = `${sy}-${String(sm + 1).padStart(2, "0")}-01`;
      const lastDay = new Date(ey, em + 1, 0).getDate();
      const to = `${ey}-${String(em + 1).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
      return { from, to };
    }
    if (granularity === "quarter") {
      const sp = lo.split("-Q");
      const ep = hi.split("-Q");
      const sYear = Number(sp[0]);
      const sQ = Number(sp[1]);
      const eYear = Number(ep[0]);
      const eQ = Number(ep[1]);
      const fromMonth = (sQ - 1) * 3;
      const toMonth = (eQ - 1) * 3 + 2;
      const from = `${sYear}-${String(fromMonth + 1).padStart(2, "0")}-01`;
      const lastDay = new Date(eYear, toMonth + 1, 0).getDate();
      const to = `${eYear}-${String(toMonth + 1).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
      return { from, to };
    }
    // year
    const sY = Number(lo);
    const eY = Number(hi);
    return { from: `${sY}-01-01`, to: `${eY}-12-31` };
  };

  const handleSet = () => {
    const range = computeSelectionRange();
    if (range) onRangeSet(range.from, range.to);
  };

  const hasSelection = rangeStart !== null;

  // ── Cell styling helper ──
  const cellClass = (key: string, isFuture: boolean, baseClass: string): string => {
    if (isFuture) return `${baseClass} text-[#d1d5db] dark:text-slate-700 cursor-not-allowed`;
    if (isRangeEndpoint(key)) {
      return `${baseClass} bg-[#1a5c53] text-white font-semibold`;
    }
    if (isInSelectionRange(key)) {
      return `${baseClass} bg-[#d5f0ed] dark:bg-teal-900/30 text-[#1a5c53] dark:text-teal-300 font-medium`;
    }
    return `${baseClass} text-[#374151] dark:text-slate-300 hover:bg-[#f0fdfa] dark:hover:bg-emerald-950/40 hover:text-[#1f7a6f] dark:hover:text-emerald-400`;
  };

  return (
    <div>
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-[#e5e7eb] dark:border-slate-700">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center text-[12px] text-[#64748b] hover:text-[#374151] transition-colors"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <span className="text-[12px] text-[#64748b]">← Back to presets</span>
      </div>

      {/* Granularity tabs */}
      <div className="flex border-b border-[#e5e7eb] dark:border-slate-700">
        {GRANULARITY_TABS.map((tab) => (
          <button
            key={tab.value}
            type="button"
            onClick={() => onGranularityChange(tab.value)}
            className={`flex-1 py-2 text-[12px] font-medium transition-all border-b-2 ${
              granularity === tab.value
                ? "text-[#1e293b] dark:text-slate-100 border-[#2a9d8f]"
                : "text-[#94a3b8] dark:text-slate-500 border-transparent hover:text-[#64748b] dark:hover:text-slate-300"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* ── Day: Dual-month calendar ── */}
      {granularity === "day" && (
        <DayCalendarView
          dateFrom={dateFrom}
          dateTo={dateTo}
          onCancel={onCancel}
          onSet={onRangeSet}
          onBack={onBack}
        />
      )}

      {/* ── Month / Quarter / Year picker ── */}
      {granularity !== "day" && (
        <>
          {/* Year navigation (for month & quarter — shows two years side by side) */}
          {granularity !== "year" && (
            <div className="flex items-center justify-between px-4 py-2">
              <button
                type="button"
                onClick={() => onYearChange(year - 1)}
                className="flex items-center gap-0.5 text-[12px] text-[#64748b] hover:text-[#374151] transition-colors"
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <polyline points="15 18 9 12 15 6" />
                </svg>
              </button>
              <div className="flex items-center gap-6">
                <span className="text-[13px] font-semibold text-[#1e293b] dark:text-slate-100">
                  {year}
                </span>
                <span className="text-[13px] font-semibold text-[#1e293b] dark:text-slate-100">
                  {year + 1}
                </span>
              </div>
              <button
                type="button"
                onClick={() => onYearChange(year + 1)}
                className="flex items-center gap-0.5 text-[12px] text-[#64748b] hover:text-[#374151] transition-colors"
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <polyline points="9 18 15 12 9 6" />
                </svg>
              </button>
            </div>
          )}

          {/* Month picker — two years side by side */}
          {granularity === "month" && (
            <div className="grid grid-cols-6 gap-1.5 px-4 py-3">
              {/* First year months */}
              {MONTH_ABBR.map((m, idx) => {
                const key = monthKey(year, idx);
                const isFuture = year > currentYear || (year === currentYear && idx > currentMonth);
                return (
                  <button
                    key={key}
                    type="button"
                    disabled={isFuture}
                    onClick={() => handleCellClick(key)}
                    className={cellClass(
                      key,
                      isFuture,
                      "py-2 rounded-lg text-[12px] font-medium transition-all",
                    )}
                  >
                    {m}
                  </button>
                );
              })}
              {/* Second year months */}
              {MONTH_ABBR.map((m, idx) => {
                const y2 = year + 1;
                const key = monthKey(y2, idx);
                const isFuture = y2 > currentYear || (y2 === currentYear && idx > currentMonth);
                return (
                  <button
                    key={key}
                    type="button"
                    disabled={isFuture}
                    onClick={() => handleCellClick(key)}
                    className={cellClass(
                      key,
                      isFuture,
                      "py-2 rounded-lg text-[12px] font-medium transition-all",
                    )}
                  >
                    {m}
                  </button>
                );
              })}
            </div>
          )}

          {/* Quarter picker — two years side by side */}
          {granularity === "quarter" && (
            <div className="grid grid-cols-8 gap-1 px-4 py-3">
              {/* First year quarters */}
              {[1, 2, 3, 4].map((q) => {
                const key = quarterKey(year, q);
                const isFuture = year > currentYear || (year === currentYear && q > currentQuarter);
                return (
                  <button
                    key={key}
                    type="button"
                    disabled={isFuture}
                    onClick={() => handleCellClick(key)}
                    className={cellClass(
                      key,
                      isFuture,
                      "py-2.5 rounded-lg text-center transition-all",
                    )}
                  >
                    <div className="text-[13px] font-semibold">Q{q}</div>
                  </button>
                );
              })}
              {/* Second year quarters */}
              {[1, 2, 3, 4].map((q) => {
                const y2 = year + 1;
                const key = quarterKey(y2, q);
                const isFuture = y2 > currentYear || (y2 === currentYear && q > currentQuarter);
                return (
                  <button
                    key={key}
                    type="button"
                    disabled={isFuture}
                    onClick={() => handleCellClick(key)}
                    className={cellClass(
                      key,
                      isFuture,
                      "py-2.5 rounded-lg text-center transition-all",
                    )}
                  >
                    <div className="text-[13px] font-semibold">Q{q}</div>
                  </button>
                );
              })}
            </div>
          )}

          {/* Year picker — horizontal list with arrows */}
          {granularity === "year" && (
            <div className="flex items-center gap-1 px-3 py-3">
              <button
                type="button"
                onClick={() => onYearChange(year - 1)}
                className="p-1 text-[#64748b] hover:text-[#374151] transition-colors shrink-0"
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <polyline points="15 18 9 12 15 6" />
                </svg>
              </button>
              <div className="flex items-center gap-1 flex-1 justify-center">
                {Array.from({ length: 6 }, (_, i) => year - 2 + i).map((y) => {
                  const key = yearKey(y);
                  const isFuture = y > currentYear;
                  return (
                    <button
                      key={key}
                      type="button"
                      disabled={isFuture}
                      onClick={() => handleCellClick(key)}
                      className={cellClass(
                        key,
                        isFuture,
                        "px-3 py-2 rounded-lg text-[13px] font-medium transition-all",
                      )}
                    >
                      {y}
                    </button>
                  );
                })}
              </div>
              <button
                type="button"
                onClick={() => onYearChange(year + 1)}
                className="p-1 text-[#64748b] hover:text-[#374151] transition-colors shrink-0"
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <polyline points="9 18 15 12 9 6" />
                </svg>
              </button>
            </div>
          )}

          {/* Footer: Cancel + Set */}
          <div className="flex items-center justify-end gap-3 px-4 py-3 border-t border-[#e5e7eb] dark:border-slate-700">
            <button
              type="button"
              onClick={onCancel}
              className="px-4 py-1.5 text-[13px] text-[#64748b] hover:text-[#374151] dark:hover:text-slate-200 transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSet}
              disabled={!hasSelection}
              className={`px-5 py-1.5 text-[13px] font-semibold rounded-lg transition-colors ${
                hasSelection
                  ? "text-white bg-[#2a9d8f] hover:bg-[#238b7f]"
                  : "text-[#cbd5e1] bg-[#f1f5f9] dark:text-slate-500 dark:bg-slate-700 cursor-not-allowed"
              }`}
            >
              Set
            </button>
          </div>
        </>
      )}
    </div>
  );
}
