/**
 * DayPicker — Single-day calendar picker
 *
 * Displays the selected date as formatted text (e.g. "February 8, 2026").
 * Clicking opens a calendar grid with prev/next navigation.
 * Props:
 *   value  — ISO date string "YYYY-MM-DD"
 *   onChange — called with new ISO date string on selection
 *   variant — "default" | "header" for different trigger styles
 *
 * Presentation follows `internal-docs/architecture/responsive-ui.md` §7: a bottom sheet below
 * `md`, an anchored popover at and above it. The 280px popover shrunk onto a 375px screen gave
 * ~34px day cells — under the touch minimum, and adjacent enough to mis-tap a date on a journal
 * entry. The sheet spends the full width on 44px cells instead.
 */

import { useState, useRef, useEffect, useMemo } from "react";
import { useIsMobile } from "../../hooks/useBreakpoint";
import { Modal } from "./Modal";

const DAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
const MONTHS = [
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

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function toISO(y: number, m: number, d: number): string {
  return `${y}-${pad(m + 1)}-${pad(d)}`;
}

function parseISO(iso: string): { year: number; month: number; day: number } {
  const d = new Date(iso + "T00:00:00");
  return { year: d.getFullYear(), month: d.getMonth(), day: d.getDate() };
}

function formatDisplay(iso: string): string {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

/** Build day cells for one month. Returns array of { day, iso } or null for leading blanks. */
function buildMonth(year: number, month: number) {
  const firstDay = new Date(year, month, 1).getDay(); // 0=Sun
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells: Array<{ day: number; iso: string } | null> = [];

  // Leading blanks
  for (let i = 0; i < firstDay; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({ day: d, iso: toISO(year, month, d) });
  }
  return cells;
}

interface DayPickerProps {
  value: string;
  onChange: (iso: string) => void;
  /** "default" = teal link trigger, "header" = dark transparent field on green bg, "form" = form field style */
  variant?: "default" | "header" | "form";
}

export default function DayPicker({ value, onChange, variant = "default" }: DayPickerProps) {
  const [open, setOpen] = useState(false);
  const asSheet = useIsMobile();
  const ref = useRef<HTMLDivElement>(null);
  const parsed = parseISO(value);

  // Calendar view state
  const [viewYear, setViewYear] = useState(parsed.year);
  const [viewMonth, setViewMonth] = useState(parsed.month);

  // Sync view when value changes externally
  useEffect(() => {
    const p = parseISO(value);
    setViewYear(p.year);
    setViewMonth(p.month);
  }, [value]);

  // Click-outside to close. Only the popover lives inside `ref`; the sheet is portalled to
  // `<body>`, so this handler would see every tap inside it as an outside click.
  useEffect(() => {
    if (!open || asSheet) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open, asSheet]);

  // Navigate months
  const prev = () => {
    if (viewMonth === 0) {
      setViewYear((y) => y - 1);
      setViewMonth(11);
    } else {
      setViewMonth((m) => m - 1);
    }
  };
  const next = () => {
    if (viewMonth === 11) {
      setViewYear((y) => y + 1);
      setViewMonth(0);
    } else {
      setViewMonth((m) => m + 1);
    }
  };

  // Today ISO for highlighting
  const todayISO = useMemo(() => {
    const now = new Date();
    return toISO(now.getFullYear(), now.getMonth(), now.getDate());
  }, []);

  const cells = buildMonth(viewYear, viewMonth);

  const handleSelect = (iso: string) => {
    onChange(iso);
    setOpen(false);
  };

  const selectToday = () => {
    const now = new Date();
    onChange(toISO(now.getFullYear(), now.getMonth(), now.getDate()));
    setOpen(false);
  };

  /**
   * One calendar, two shells. `sheet` only changes density — the cells, labels and nav grow to
   * thumb size; the desktop popover keeps the compact figures it has always had.
   */
  const calendar = (sheet: boolean) => (
    <>
      {/* Nav row */}
      <div className={`flex items-center justify-between ${sheet ? "mb-4" : "mb-3"}`}>
        <button
          type="button"
          onClick={prev}
          aria-label="Previous month"
          className={`rounded-md flex items-center justify-center text-[#64748b] dark:text-slate-400 hover:bg-[#f1f5f9] dark:hover:bg-slate-800 transition-colors ${
            sheet ? "h-11 w-11" : "w-7 h-7"
          }`}
        >
          <svg
            width={sheet ? "18" : "14"}
            height={sheet ? "18" : "14"}
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
        <p
          className={`font-semibold text-[#1e293b] dark:text-white ${sheet ? "text-base" : "text-sm"}`}
        >
          {MONTHS[viewMonth]} {String(viewYear)}
        </p>
        <button
          type="button"
          onClick={next}
          aria-label="Next month"
          className={`rounded-md flex items-center justify-center text-[#64748b] dark:text-slate-400 hover:bg-[#f1f5f9] dark:hover:bg-slate-800 transition-colors ${
            sheet ? "h-11 w-11" : "w-7 h-7"
          }`}
        >
          <svg
            width={sheet ? "18" : "14"}
            height={sheet ? "18" : "14"}
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
      </div>

      {/* Day headers */}
      <div
        className={`grid grid-cols-7 text-center text-[#94a3b8] dark:text-slate-500 font-medium ${
          sheet ? "text-xs mb-2" : "text-[11px] mb-1"
        }`}
      >
        {DAYS.map((d) => (
          <span key={d} className={sheet ? "py-1" : "py-0.5"}>
            {d}
          </span>
        ))}
      </div>

      {/* Day grid */}
      <div className={`grid grid-cols-7 text-center ${sheet ? "gap-1 text-base" : "text-[13px]"}`}>
        {cells.map((cell, i) =>
          cell ? (
            <button
              key={cell.iso}
              type="button"
              onClick={() => handleSelect(cell.iso)}
              aria-pressed={cell.iso === value}
              className={`rounded-md transition-colors ${sheet ? "h-11 w-full" : "py-1.5"} ${
                cell.iso === value
                  ? "bg-[#27ae60] text-white font-semibold"
                  : cell.iso === todayISO
                    ? "ring-1 ring-[#27ae60] text-[#27ae60] dark:text-[#2ecc71] font-medium"
                    : "text-[#334155] dark:text-slate-300 hover:bg-[#f1f5f9] dark:hover:bg-slate-700"
              }`}
            >
              {cell.day}
            </button>
          ) : (
            <span key={`blank-${String(i)}`} />
          ),
        )}
      </div>
    </>
  );

  return (
    <div className="relative inline-block" ref={ref}>
      {/* Trigger */}
      {variant === "header" ? (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="inline-flex items-center justify-center gap-1.5 min-h-11 sm:min-h-0 text-sm font-medium bg-black/20 text-white/90 hover:bg-black/30 transition-colors rounded-md px-3 py-1.5 border-none outline-none cursor-pointer"
        >
          {formatDisplay(value)}
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
        </button>
      ) : variant === "form" ? (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="w-full flex items-center justify-between min-h-11 sm:min-h-0 px-3 py-2.5 text-sm sm:text-[13px] font-medium text-gray-800 dark:text-white bg-gray-50 dark:bg-white/5 border border-gray-200 dark:border-white/10 rounded-lg hover:border-emerald-400/40 focus:outline-none focus:ring-2 focus:ring-emerald-400/40 focus:border-emerald-400 transition-colors cursor-pointer"
        >
          <span>{formatDisplay(value)}</span>
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="text-gray-400 dark:text-white/40"
          >
            <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
            <line x1="16" y1="2" x2="16" y2="6" />
            <line x1="8" y1="2" x2="8" y2="6" />
            <line x1="3" y1="10" x2="21" y2="10" />
          </svg>
        </button>
      ) : (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="touch-target inline-flex items-center gap-1.5 text-xs font-medium text-[#27ae60] dark:text-[#2ecc71] hover:underline cursor-pointer bg-transparent border-none outline-none"
        >
          {formatDisplay(value)}
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
        </button>
      )}

      {/* Desktop: anchored popover */}
      {open && !asSheet && (
        <div
          className={`absolute ${variant === "form" ? "left-0" : "right-0"} top-full mt-2 z-50 bg-white dark:bg-slate-900 border border-[#e2e8f0] dark:border-slate-700 rounded-xl shadow-xl p-5 w-[280px]`}
        >
          {calendar(false)}

          {/* Footer */}
          <div className="flex items-center justify-between mt-4 pt-3 border-t border-[#e2e8f0] dark:border-slate-700">
            <button
              type="button"
              onClick={selectToday}
              className="text-xs font-medium text-[#27ae60] dark:text-[#2ecc71] hover:underline"
            >
              Today
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="px-4 py-1.5 text-xs font-medium text-[#64748b] dark:text-slate-400 hover:text-[#334155] dark:hover:text-slate-200 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Mobile: bottom sheet. Modal supplies the backdrop, focus trap, Escape and safe areas. */}
      {asSheet && (
        <Modal
          open={open}
          onClose={() => setOpen(false)}
          title="Select date"
          description={formatDisplay(value)}
          mobile="sheet"
          size="sm"
          footer={
            <button
              type="button"
              onClick={selectToday}
              className="h-11 rounded-lg border border-[#27ae60] px-4 text-sm font-semibold text-[#27ae60] transition-colors hover:bg-[#27ae60]/10 dark:text-[#2ecc71]"
            >
              Today
            </button>
          }
        >
          {calendar(true)}
        </Modal>
      )}
    </div>
  );
}
