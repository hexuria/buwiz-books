import { CaretDown, Check, MagnifyingGlass } from "@phosphor-icons/react";
import { useEffect, useId, useMemo, useRef, useState } from "react";

export interface MultiCheckboxOption {
  value: string;
  label: string;
  description?: string;
}

interface MultiCheckboxComboboxProps {
  options: MultiCheckboxOption[];
  value: string[];
  onChange: (value: string[]) => void;
  ariaLabel: string;
  placeholder?: string;
  searchPlaceholder?: string;
  disabled?: boolean;
  className?: string;
}

export function MultiCheckboxCombobox({
  options,
  value,
  onChange,
  ariaLabel,
  placeholder = "Select groups",
  searchPlaceholder = "Search groups",
  disabled = false,
  className = "",
}: MultiCheckboxComboboxProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listboxId = useId();
  const selected = useMemo(() => new Set(value), [value]);
  const filteredOptions = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return options;
    return options.filter((option) => option.label.toLowerCase().includes(normalized));
  }, [options, query]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
        setQuery("");
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        setQuery("");
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    const focusFrame = requestAnimationFrame(() => searchRef.current?.focus());
    return () => {
      cancelAnimationFrame(focusFrame);
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const selectedOptions = options.filter((option) => selected.has(option.value));
  const triggerLabel =
    selectedOptions.length === 0
      ? placeholder
      : selectedOptions.length === options.length && options.length > 1
        ? `All ${options.length} groups`
        : selectedOptions.length === 1
          ? selectedOptions[0].label
          : `${selectedOptions.length} groups selected`;

  const emitInOptionOrder = (next: Set<string>) => {
    onChange(options.filter((option) => next.has(option.value)).map((option) => option.value));
  };

  const toggle = (optionValue: string) => {
    const next = new Set(selected);
    if (next.has(optionValue)) {
      if (next.size === 1) return;
      next.delete(optionValue);
    } else {
      next.add(optionValue);
    }
    emitInOptionOrder(next);
  };

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <button
        type="button"
        role="combobox"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-controls={listboxId}
        aria-haspopup="listbox"
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        className="flex min-h-11 w-full min-w-64 items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-3.5 py-2 text-left text-sm text-slate-800 outline-none transition hover:border-slate-300 focus:border-emerald-600 focus:ring-2 focus:ring-emerald-600/10 disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/10 dark:bg-[#0e141c] dark:text-white dark:hover:border-white/20"
      >
        <span className="min-w-0 flex-1 truncate font-medium">{triggerLabel}</span>
        <span className="flex shrink-0 items-center gap-2">
          {selectedOptions.length > 1 && (
            <span className="rounded-md bg-emerald-50 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-emerald-800 dark:bg-emerald-400/10 dark:text-emerald-300">
              {selectedOptions.length}
            </span>
          )}
          <CaretDown
            size={15}
            weight="bold"
            className={`text-slate-400 transition-transform ${open ? "rotate-180" : ""}`}
          />
        </span>
      </button>

      {open && (
        <div className="absolute left-0 z-30 mt-2 w-[min(24rem,calc(100vw-2rem))] overflow-hidden rounded-xl border border-slate-200 bg-white shadow-[0_18px_45px_-18px_rgba(15,23,42,0.35)] dark:border-white/10 dark:bg-[#111820]">
          <div className="border-b border-slate-200 p-2.5 dark:border-white/10">
            <div className="flex min-h-10 items-center gap-2 rounded-lg bg-slate-50 px-3 text-slate-500 focus-within:ring-2 focus-within:ring-emerald-600/15 dark:bg-white/[0.05] dark:text-white/45">
              <MagnifyingGlass size={16} />
              <input
                ref={searchRef}
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={searchPlaceholder}
                aria-label={searchPlaceholder}
                className="min-w-0 flex-1 bg-transparent text-base text-slate-800 outline-none placeholder:text-slate-400 sm:text-sm dark:text-white dark:placeholder:text-white/30"
              />
            </div>
          </div>

          <div
            id={listboxId}
            role="listbox"
            aria-multiselectable="true"
            className="max-h-72 overflow-y-auto p-1.5"
          >
            {filteredOptions.length === 0 ? (
              <p className="px-3 py-6 text-center text-sm text-slate-500 dark:text-white/40">
                No groups match your search.
              </p>
            ) : (
              filteredOptions.map((option) => {
                const isSelected = selected.has(option.value);
                const isLastSelection = isSelected && selected.size === 1;
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    aria-disabled={isLastSelection}
                    title={isLastSelection ? "At least one group must remain selected" : undefined}
                    onClick={() => toggle(option.value)}
                    className={`flex min-h-11 w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition active:scale-[0.99] ${
                      isSelected
                        ? "bg-emerald-50 text-emerald-950 dark:bg-emerald-400/10 dark:text-emerald-100"
                        : "text-slate-700 hover:bg-slate-50 dark:text-white/70 dark:hover:bg-white/[0.05]"
                    }`}
                  >
                    <span
                      aria-hidden="true"
                      className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                        isSelected
                          ? "border-emerald-700 bg-emerald-700 text-white"
                          : "border-slate-300 bg-white dark:border-white/25 dark:bg-transparent"
                      }`}
                    >
                      {isSelected && <Check size={11} weight="bold" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{option.label}</span>
                      {option.description && (
                        <span className="mt-0.5 block text-[11px] text-slate-500 dark:text-white/40">
                          {option.description}
                        </span>
                      )}
                    </span>
                  </button>
                );
              })
            )}
          </div>

          <div className="flex items-center justify-between border-t border-slate-200 px-3 py-2.5 dark:border-white/10">
            <span className="text-[11px] text-slate-500 dark:text-white/40">
              {selected.size} of {options.length} selected
            </span>
            {selected.size < options.length && (
              <button
                type="button"
                onClick={() => emitInOptionOrder(new Set(options.map((option) => option.value)))}
                className="rounded-md px-2 py-1 text-xs font-semibold text-emerald-700 transition hover:bg-emerald-50 active:scale-[0.98] dark:text-emerald-300 dark:hover:bg-emerald-400/10"
              >
                Select all
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
