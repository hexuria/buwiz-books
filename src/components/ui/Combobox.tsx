import React, { useState, useEffect, useLayoutEffect, useRef, useMemo } from "react";
import { createPortal } from "react-dom";

export interface ComboboxOption {
  value: string;
  label: string;
  icon?: React.ReactNode;
  disabled?: boolean;
}

export interface SuggestedItem {
  label: string;
  sublabel?: string;
  description?: string;
  data?: unknown;
}

interface ComboboxProps {
  value?: string;
  onChange: (value: string) => void;
  onSearch?: (query: string) => void;
  options: ComboboxOption[];
  placeholder?: string;
  searchPlaceholder?: string;
  disabled?: boolean;
  className?: string;
  /** Override the display text shown in the closed button (e.g. "Multiple") */
  displayValue?: string;
  placeholderIcon?: React.ReactNode;
  renderOption?: (option: ComboboxOption, isSelected: boolean) => React.ReactNode;
  /** Callback to create a new entry from the current query */
  onCreate?: (query: string) => void;
  /** Label for the create option, e.g. "vendor" → "+ Create new vendor 'X'" */
  createLabel?: string;
  /** Suggested items shown in a "Create New" section when query matches */
  suggestions?: SuggestedItem[];
  /** Callback when user clicks a suggested item */
  onCreateSuggestion?: (item: SuggestedItem) => void;
}

/** Desktop row height. Below `sm` rows relax to the 44px touch minimum instead. */
const ITEM_HEIGHT = 40;
const TOUCH_ITEM_HEIGHT = 44;
const MAX_VISIBLE = 7;
/** Narrower than this and long labels are unreadable; wider than the viewport and it is clipped. */
const MIN_PANEL_WIDTH = 200;
/** Breathing room kept between the panel and every viewport edge. */
const EDGE_GAP = 8;
/** Gap between the trigger and the panel. */
const TRIGGER_GAP = 4;
/** Below this the panel is too short to be worth opening downwards — flip it above the trigger. */
const MIN_PANEL_HEIGHT = 160;

interface PanelPosition {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
}

/**
 * The panel is portalled to `<body>` and positioned against the trigger's viewport rect.
 *
 * Rendering it in flow made it the child of whatever `overflow-hidden` card or row the combobox
 * sits in — inline ledger dropdowns were clipped to a table cell — and let it run off the bottom
 * of a phone viewport with no way to scroll to the options.
 */
function measurePanel(trigger: HTMLElement): PanelPosition {
  const rect = trigger.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  const width = Math.min(Math.max(rect.width, MIN_PANEL_WIDTH), vw - EDGE_GAP * 2);
  const left = Math.min(Math.max(rect.left, EDGE_GAP), Math.max(EDGE_GAP, vw - width - EDGE_GAP));

  const below = vh - rect.bottom - TRIGGER_GAP - EDGE_GAP;
  const above = rect.top - TRIGGER_GAP - EDGE_GAP;
  const flip = below < MIN_PANEL_HEIGHT && above > below;

  const rowHeight = window.matchMedia("(min-width: 640px)").matches
    ? ITEM_HEIGHT
    : TOUCH_ITEM_HEIGHT;
  const available = Math.max(flip ? above : below, MIN_PANEL_HEIGHT);
  const maxHeight = Math.min(MAX_VISIBLE * rowHeight, available);
  const top = flip
    ? Math.max(EDGE_GAP, rect.top - TRIGGER_GAP - maxHeight)
    : rect.bottom + TRIGGER_GAP;

  return { top, left, width, maxHeight };
}

export default function Combobox({
  value,
  onChange,
  options,
  placeholder = "Select...",
  searchPlaceholder = "Type to filter...",
  disabled = false,
  className = "",
  displayValue,
  placeholderIcon,
  renderOption,
  onSearch,
  onCreate,
  createLabel,
  suggestions = [],
  onCreateSuggestion,
}: ComboboxProps) {
  const listboxId = useMemo(
    () => `combobox-listbox-${Math.random().toString(36).slice(2, 10)}`,
    [],
  );
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlightIdx, setHighlightIdx] = useState(-1);
  const [panel, setPanel] = useState<PanelPosition | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Notify parent of search query changes
  useEffect(() => {
    if (onSearch) {
      onSearch(query);
    }
  }, [query, onSearch]);

  // Filter options based on query
  const filtered = useMemo(() => {
    if (!query.trim()) return options;
    const q = query.toLowerCase();
    return options.filter((o) => o.label.toLowerCase().includes(q));
  }, [options, query]);

  // Show create option when query is non-empty and onCreate is provided
  const showCreateOption = !!(onCreate && query.trim());

  // Filtered suggestions (only when query has text and onCreateSuggestion is provided)
  const activeSuggestions = onCreateSuggestion && query.trim() ? suggestions : [];

  // Close on outside click. The panel is portalled, so it is *not* inside the container — without
  // the second check a mousedown on an option would close the list before its click landed.
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (containerRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      setOpen(false);
      setQuery("");
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // Keep the portalled panel anchored to the trigger.
  useLayoutEffect(() => {
    if (!open) {
      setPanel(null);
      return;
    }
    const reposition = () => {
      if (containerRef.current) setPanel(measurePanel(containerRef.current));
    };
    reposition();
    window.addEventListener("resize", reposition);
    // Capture phase so scrolling any ancestor scrollport moves the panel, not just the window.
    window.addEventListener("scroll", reposition, true);
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [open, filtered.length, activeSuggestions.length, showCreateOption]);

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
    if (open && inputRef.current) {
      inputRef.current.focus();
    }
  }, [open]);

  const handleSelect = (val: string) => {
    onChange(val);
    setOpen(false);
    setQuery("");
  };

  const handleCreate = () => {
    if (onCreate && query.trim()) {
      onCreate(query.trim());
      setOpen(false);
      setQuery("");
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      if ((e.key === "Enter" || e.key === "ArrowDown") && !disabled) {
        setOpen(true);
        e.preventDefault();
      }
      return;
    }

    // Total navigable items = filtered options + suggestions + optional create row
    const sugCount = activeSuggestions.length;
    const totalItems = filtered.length + sugCount + (showCreateOption ? 1 : 0);
    const sugStartIdx = filtered.length;
    const createIdx = showCreateOption ? filtered.length + sugCount : -1;

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setHighlightIdx((i) => Math.min(i + 1, totalItems - 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setHighlightIdx((i) => Math.max(i - 1, 0));
        break;
      case "Enter":
        e.preventDefault();
        // Cmd+Enter / Ctrl+Enter = create shortcut
        if ((e.metaKey || e.ctrlKey) && showCreateOption) {
          handleCreate();
        } else if (highlightIdx === createIdx) {
          handleCreate();
        } else if (highlightIdx >= sugStartIdx && highlightIdx < sugStartIdx + sugCount) {
          // Suggestion selected
          const sugItem = activeSuggestions[highlightIdx - sugStartIdx];
          if (sugItem && onCreateSuggestion) {
            onCreateSuggestion(sugItem);
            setOpen(false);
            setQuery("");
          }
        } else if (filtered[highlightIdx]) {
          handleSelect(filtered[highlightIdx].value);
        }
        break;
      case "Escape":
        e.preventDefault();
        setOpen(false);
        setQuery("");
        break;
    }
  };

  const selectedOption = options.find((o) => o.value === value);

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      {!open ? (
        <button
          type="button"
          onClick={() => !disabled && setOpen(true)}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          role="combobox"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-haspopup="listbox"
          className={`flex items-center gap-2 w-full min-h-11 sm:min-h-0 px-3 py-2 text-sm border rounded-lg transition-all cursor-pointer justify-between ${
            disabled
              ? "bg-gray-50 dark:bg-slate-900 border-gray-200 dark:border-slate-700 opacity-60 cursor-not-allowed"
              : "bg-white dark:bg-slate-800 border-gray-200 dark:border-slate-600 hover:border-gray-300 dark:hover:border-slate-500 text-[#1e293b] dark:text-slate-100"
          }`}
        >
          <span className="truncate flex items-center gap-2">
            {!displayValue && (selectedOption?.icon ?? placeholderIcon) && (
              <span className="w-5 h-5 flex items-center justify-center shrink-0 [&>svg]:w-full [&>svg]:h-full">
                {selectedOption?.icon ?? placeholderIcon}
              </span>
            )}
            <span className={selectedOption || displayValue ? "" : "opacity-50"}>
              {displayValue || (selectedOption ? selectedOption.label : placeholder)}
            </span>
          </span>
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className="shrink-0 opacity-40"
          >
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>
      ) : (
        <div className="flex items-center gap-2 w-full min-h-11 sm:min-h-0 px-3 py-2 text-sm border-2 border-[var(--color-app-header-teal,#3b82f6)] rounded-lg bg-white dark:bg-slate-800 text-[#1e293b] dark:text-slate-100">
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className="shrink-0 text-gray-400"
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
            placeholder={searchPlaceholder}
            role="combobox"
            aria-expanded={open}
            aria-controls={listboxId}
            aria-autocomplete="list"
            /* 16px below `sm`: iOS Safari zooms the viewport on focus for anything smaller and
               never zooms back out. */
            className="flex-1 bg-transparent outline-none placeholder:text-gray-400 dark:placeholder:text-slate-500 min-w-0 text-base sm:text-sm"
          />
        </div>
      )}

      {/* Dropdown list */}
      {open &&
        panel &&
        createPortal(
          <div
            ref={panelRef}
            style={{
              position: "fixed",
              top: panel.top,
              left: panel.left,
              width: panel.width,
              // Above `Modal` (z-100) — comboboxes are used inside dialogs.
              zIndex: 200,
            }}
            className="bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-xl overflow-hidden shadow-xl animate-in fade-in zoom-in-95 duration-100"
          >
            {/* Scoped to this listbox — the unscoped `div::-webkit-scrollbar` this replaces hid
                every scrollbar on the page for as long as any combobox was open. */}
            <style>{`#${listboxId}::-webkit-scrollbar { display: none; }`}</style>
            <div
              ref={listRef}
              id={listboxId}
              role="listbox"
              className="overflow-y-auto overscroll-contain"
              style={{
                maxHeight: panel.maxHeight,
                scrollbarWidth: "none",
              }}
            >
              {/* Empty state */}
              {filtered.length === 0 && (
                <div className="px-4 min-h-11 sm:h-10 sm:min-h-10 text-sm text-gray-400 flex items-center">
                  No matches found
                </div>
              )}

              {/* Options */}
              {filtered.map((opt, idx) => {
                const isSelected = opt.value === value;
                const isHighlighted = idx === highlightIdx;

                return (
                  <button
                    key={opt.value}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    onMouseEnter={() => setHighlightIdx(idx)}
                    onClick={() => handleSelect(opt.value)}
                    disabled={opt.disabled}
                    className={`flex items-center gap-3 w-full px-4 min-h-11 sm:h-10 sm:min-h-10 text-sm transition-colors cursor-pointer text-left ${
                      isSelected
                        ? "text-[var(--color-app-header-teal)] bg-[var(--color-app-bg-light-teal,#eaf6f6)] dark:bg-teal-900/30"
                        : isHighlighted
                          ? "bg-slate-50 dark:bg-slate-700 text-[#1e293b] dark:text-slate-100"
                          : "text-[#1e293b] dark:text-slate-100"
                    } ${opt.disabled ? "opacity-50 cursor-not-allowed" : ""}`}
                  >
                    {renderOption ? (
                      renderOption(opt, isSelected)
                    ) : (
                      <>
                        {opt.icon && (
                          <span className="w-5 h-5 flex items-center justify-center shrink-0 opacity-70 [&>svg]:w-full [&>svg]:h-full">
                            {opt.icon}
                          </span>
                        )}
                        <span className="flex-1 truncate">{opt.label}</span>
                        {isSelected && (
                          <svg
                            width="16"
                            height="16"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2.5"
                            className="shrink-0 opacity-70"
                          >
                            <path d="M20 6L9 17l-5-5" />
                          </svg>
                        )}
                      </>
                    )}
                  </button>
                );
              })}

              {/* Suggested items ("Create New" section) */}
              {activeSuggestions.length > 0 && (
                <>
                  <div className="px-4 py-1.5 text-[11px] sm:text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-slate-500 border-t border-gray-100 dark:border-slate-700 bg-gray-50/50 dark:bg-slate-900/40">
                    Create New
                  </div>
                  {activeSuggestions.map((sug, i) => {
                    const sugIdx = filtered.length + i;
                    return (
                      <button
                        key={sug.label}
                        type="button"
                        onMouseEnter={() => setHighlightIdx(sugIdx)}
                        onClick={() => {
                          onCreateSuggestion?.(sug);
                          setOpen(false);
                          setQuery("");
                        }}
                        className={`flex items-center gap-3 w-full px-4 min-h-11 sm:h-10 sm:min-h-10 text-sm transition-colors cursor-pointer text-left ${
                          highlightIdx === sugIdx
                            ? "bg-teal-50 dark:bg-teal-900/30 text-[var(--color-app-header-teal)]"
                            : "text-[#1e293b] dark:text-slate-100"
                        }`}
                      >
                        <svg
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2.5"
                          className="shrink-0 text-[var(--color-app-header-teal)] dark:text-teal-400"
                        >
                          <line x1="12" y1="5" x2="12" y2="19" />
                          <line x1="5" y1="12" x2="19" y2="12" />
                        </svg>
                        <span className="flex-1 truncate">{sug.label}</span>
                        {sug.sublabel && (
                          <span className="text-xs text-gray-400 dark:text-slate-500 truncate">
                            {sug.sublabel}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </>
              )}

              {/* Create option (generic fallback) */}
              {showCreateOption && (
                <button
                  type="button"
                  onMouseEnter={() => setHighlightIdx(filtered.length + activeSuggestions.length)}
                  onClick={handleCreate}
                  className={`flex items-center gap-3 w-full px-4 min-h-11 sm:h-10 sm:min-h-10 text-sm transition-colors cursor-pointer text-left border-t border-gray-100 dark:border-slate-700 ${
                    highlightIdx === filtered.length + activeSuggestions.length
                      ? "bg-teal-50 dark:bg-teal-900/30 text-[var(--color-app-header-teal)]"
                      : "text-[var(--color-app-header-teal)] dark:text-teal-400"
                  }`}
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
                    <line x1="12" y1="5" x2="12" y2="19" />
                    <line x1="5" y1="12" x2="19" y2="12" />
                  </svg>
                  <span className="flex-1 truncate">
                    Create {createLabel ? `${createLabel} ` : ""}"{query.trim()}"
                  </span>
                  {/* Keyboard shortcut hint — meaningless without a keyboard. */}
                  <kbd className="hidden sm:inline-block text-[10px] font-mono opacity-50 bg-gray-100 dark:bg-slate-700 px-1 rounded">
                    ⌘↵
                  </kbd>
                </button>
              )}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
