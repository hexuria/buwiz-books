/**
 * StatusFilterPopover — Lightweight status-only filter for Departments / Locations.
 *
 * Provides:
 *  - StatusFilterChip: the "Active ×" / "Deactivated ×" chip shown in the search bar
 *  - StatusFilterPopover: the floating popover anchored to the filter icon
 */
import React, { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";

// ============================================================================
// Types
// ============================================================================

export type StatusFilterValue = "active" | "deactivated" | null;

// ============================================================================
// Constants
// ============================================================================

const STATUS_OPTIONS: { value: "active" | "deactivated"; label: string; color: string }[] = [
  { value: "active", label: "Active", color: "#22c55e" },
  { value: "deactivated", label: "Inactive", color: "#94a3b8" },
];

// ============================================================================
// Status Filter Chip — inline in search bar
// ============================================================================

export const StatusFilterChip: React.FC<{
  status: StatusFilterValue;
  onClear: () => void;
}> = ({ status, onClear }) => {
  if (!status) return null;
  const opt = STATUS_OPTIONS.find((o) => o.value === status);
  if (!opt) return null;

  return (
    <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-[20px] text-xs font-semibold border border-slate-300 dark:border-slate-600 bg-slate-50 dark:bg-slate-700 text-slate-700 dark:text-slate-200 whitespace-nowrap">
      <span className="w-[7px] h-[7px] rounded-full shrink-0" style={{ background: opt.color }} />
      {opt.label}
      <button
        type="button"
        className="bg-transparent border-none cursor-pointer p-0 flex items-center text-slate-400 dark:text-slate-500 text-[0.9rem] leading-none"
        onClick={onClear}
      >
        ×
      </button>
    </span>
  );
};

// ============================================================================
// SVG Icons
// ============================================================================

const StatusIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <circle cx="12" cy="12" r="10" />
    <path d="M8 14s1.5 2 4 2 4-2 4-2" />
    <line x1="9" y1="9" x2="9.01" y2="9" />
    <line x1="15" y1="9" x2="15.01" y2="9" />
  </svg>
);

// ============================================================================
// Status Filter Popover — floating context menu anchored to filter icon
// ============================================================================

export const StatusFilterPopover: React.FC<{
  open: boolean;
  onClose: () => void;
  status: StatusFilterValue;
  onChange: (status: StatusFilterValue) => void;
  anchorRef?: React.RefObject<HTMLButtonElement | null>;
}> = ({ open, onClose, status, onChange, anchorRef }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number }>({ top: 0, left: 0 });

  // Position the popover below the anchor
  useEffect(() => {
    if (open && anchorRef?.current) {
      const rect = anchorRef.current.getBoundingClientRect();
      setPosition({
        top: rect.bottom + 6,
        left: rect.left,
      });
    }
  }, [open, anchorRef]);

  useEffect(() => {
    if (!open) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        // Don't close if clicking the anchor button itself
        if (anchorRef?.current?.contains(e.target as Node)) return;
        onClose();
      }
    };

    // Delay registration so the opening click doesn't immediately dismiss
    const rafId = requestAnimationFrame(() => {
      document.addEventListener("mousedown", handleClickOutside);
    });

    return () => {
      cancelAnimationFrame(rafId);
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [open, onClose, anchorRef]);

  if (!open) return null;

  const toggleStatus = (value: "active" | "deactivated") => {
    onChange(status === value ? null : value);
  };

  return createPortal(
    <div
      ref={ref}
      className="fixed bg-white dark:bg-slate-800 rounded-xl border border-gray-200 dark:border-slate-700 z-50 overflow-y-auto overflow-x-hidden"
      style={{
        top: position.top,
        left: position.left,
        width: 264,
        maxHeight: "calc(100vh - 120px)",
        boxShadow: "0 8px 30px rgba(0,0,0,0.12), 0 2px 8px rgba(0,0,0,0.08)",
      }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-slate-700">
        <span className="font-bold text-sm text-slate-800 dark:text-slate-200">Filters</span>
        <button
          type="button"
          onClick={onClose}
          className="flex items-center justify-center w-6 h-6 min-h-11 min-w-11 lg:min-h-0 lg:min-w-0 rounded-full bg-transparent border-none cursor-pointer text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300"
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
            <path d="M18 6L6 18" />
            <path d="M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Status Section — always open */}
      <div className="border-b border-gray-200 dark:border-slate-700">
        <div className="flex items-center gap-2 px-4 py-3 font-semibold text-[0.85rem] text-slate-800 dark:text-slate-200">
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            style={{ transform: "rotate(90deg)" }}
          >
            <path d="M9 18l6-6-6-6" />
          </svg>
          <StatusIcon />
          <span className="flex-1">Status</span>
          {status && (
            <span className="bg-[#2a9d8f] text-white text-[0.7rem] font-bold rounded-full w-5 h-5 flex items-center justify-center">
              1
            </span>
          )}
        </div>
        <div className="px-4 pb-3 pl-9">
          {STATUS_OPTIONS.map((opt) => (
            <label
              key={opt.value}
              className="flex items-center gap-2 py-1 cursor-pointer text-[0.85rem] text-gray-700 dark:text-slate-300"
            >
              <span className="w-2 h-2 rounded-full shrink-0" style={{ background: opt.color }} />
              <span className="flex-1">{opt.label}</span>
              <input
                type="radio"
                name="status-filter"
                checked={status === opt.value}
                onChange={() => toggleStatus(opt.value)}
                className="w-[18px] h-[18px] accent-[#2a9d8f] cursor-pointer"
              />
            </label>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
};
