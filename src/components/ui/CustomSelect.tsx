import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

interface SelectOption {
  value: string;
  label: string;
}

interface CustomSelectProps {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  className?: string;
  /** Width class for the wrapper, e.g. "w-[240px]" */
  width?: string;
}

export function CustomSelect({
  value,
  onChange,
  options,
  className = "",
  width = "w-[240px]",
}: CustomSelectProps) {
  const listboxId = useRef(`custom-select-listbox-${Math.random().toString(36).slice(2, 10)}`);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [highlightIdx, setHighlightIdx] = useState(-1);
  const [pos, setPos] = useState({ top: 0, left: 0, width: 0 });
  const [dropUp, setDropUp] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const selectedLabel = options.find((o) => o.value === value)?.label ?? value;

  const filtered = search
    ? options.filter((o) => o.label.toLowerCase().includes(search.toLowerCase()))
    : options;

  // Auto-highlight the top match when search changes
  useEffect(() => {
    if (search && filtered.length > 0) {
      setHighlightIdx(0);
    } else {
      setHighlightIdx(-1);
    }
  }, [search, filtered.length]);

  // Scroll highlighted item into view
  useEffect(() => {
    if (highlightIdx >= 0 && itemRefs.current[highlightIdx]) {
      itemRefs.current[highlightIdx]?.scrollIntoView({ block: "nearest" });
    }
  }, [highlightIdx]);

  // Position the dropdown relative to the button via portal
  useLayoutEffect(() => {
    if (!open || !btnRef.current) return;
    const rect = btnRef.current.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    const dropdownHeight = Math.min(filtered.length * 36 + 52, 280);
    const shouldDropUp = spaceBelow < dropdownHeight && rect.top > dropdownHeight;
    setDropUp(shouldDropUp);
    setPos({
      top: shouldDropUp ? rect.top - dropdownHeight : rect.bottom + 4,
      left: rect.left,
      width: rect.width,
    });
  }, [open, filtered.length]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (btnRef.current?.contains(e.target as Node) || listRef.current?.contains(e.target as Node))
        return;
      setOpen(false);
      setSearch("");
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  // Focus search input when opened
  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightIdx((prev) => (prev < filtered.length - 1 ? prev + 1 : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightIdx((prev) => (prev > 0 ? prev - 1 : filtered.length - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const idx = highlightIdx >= 0 ? highlightIdx : 0;
      if (filtered[idx]) {
        onChange(filtered[idx].value);
        setOpen(false);
        setSearch("");
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      setSearch("");
    }
  }

  return (
    <div className={`relative ${width} ${className}`}>
      <button
        ref={btnRef}
        type="button"
        role="combobox"
        aria-expanded={open}
        aria-controls={listboxId.current}
        aria-haspopup="listbox"
        onClick={() => {
          setOpen((p) => !p);
          setSearch("");
          setHighlightIdx(-1);
        }}
        className="w-full h-10 pl-3 pr-10 text-sm text-left border border-[#d6dbe5] dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 text-[#374151] dark:text-slate-300 focus:outline-none focus:border-teal-500 cursor-pointer transition-colors"
      >
        {selectedLabel}
      </button>
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="24"
        height="24"
        fill="none"
        viewBox="0 0 24 24"
        className={`absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none transition-transform ${open ? "rotate-180" : ""}`}
      >
        <path
          stroke="#9ca3af"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.5"
          d="m6 9 6 6 6-6"
        />
      </svg>

      {open &&
        createPortal(
          <div
            ref={listRef}
            style={{
              position: "fixed",
              top: `${pos.top}px`,
              left: `${pos.left}px`,
              width: `${pos.width}px`,
              zIndex: 99999,
            }}
            className={`rounded-lg border border-[#d6dbe5] dark:border-slate-600 bg-white dark:bg-slate-800 shadow-xl ${dropUp ? "flex flex-col-reverse" : ""}`}
          >
            {/* Search input */}
            <div className="p-1.5 border-b border-[#e5e7eb] dark:border-slate-700">
              <input
                ref={inputRef}
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Type to search…"
                role="combobox"
                aria-expanded={open}
                aria-controls={listboxId.current}
                aria-autocomplete="list"
                className="w-full px-2.5 py-1.5 text-sm bg-[#f9fafb] dark:bg-slate-900 border border-[#e5e7eb] dark:border-slate-700 rounded-md text-[#374151] dark:text-slate-300 placeholder-[#9ca3af] focus:outline-none focus:border-teal-500"
              />
            </div>

            {/* Options list */}
            <ul id={listboxId.current} role="listbox" className="max-h-52 overflow-auto py-1">
              {filtered.length === 0 ? (
                <li className="px-3 py-2 text-sm text-[#9ca3af]">No matches</li>
              ) : (
                filtered.map((opt, i) => (
                  <li key={opt.value}>
                    <button
                      ref={(el) => {
                        itemRefs.current[i] = el;
                      }}
                      type="button"
                      role="option"
                      aria-selected={opt.value === value}
                      onMouseEnter={() => setHighlightIdx(i)}
                      onClick={() => {
                        onChange(opt.value);
                        setOpen(false);
                        setSearch("");
                      }}
                      className={`w-full text-left px-3 py-2 text-sm cursor-pointer transition-colors ${
                        opt.value === value && highlightIdx !== i
                          ? "bg-teal-500 text-white"
                          : highlightIdx === i
                            ? "bg-teal-100 dark:bg-teal-900/40 text-[#374151] dark:text-slate-200"
                            : "text-[#374151] dark:text-slate-300 hover:bg-teal-50 dark:hover:bg-teal-900/30"
                      }`}
                    >
                      {opt.label}
                    </button>
                  </li>
                ))
              )}
            </ul>
          </div>,
          document.body,
        )}
    </div>
  );
}
