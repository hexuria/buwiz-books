/**
 * Product Combobox — inline creation form within dropdown
 */
import { useState, useRef, useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { listProducts, createProduct } from "@/routes/api/-products";
import { formatCurrency } from "./invoice-shared";

export function ProductCombobox({
  value,
  onSelect,
  onChange,
}: {
  value: string;
  onSelect: (name: string, price: string) => void;
  onChange?: (text: string) => void;
}) {
  const [search, setSearch] = useState(value);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"search" | "create">("search");
  const [newName, setNewName] = useState("");
  const [newPrice, setNewPrice] = useState("");
  const [highlightIndex, setHighlightIndex] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();

  // Keep display synced with external value changes
  useEffect(() => {
    setSearch(value);
  }, [value]);

  const { data: productList = [] } = useQuery({
    queryKey: ["products", search],
    queryFn: () => listProducts({ data: { search: search || undefined, limit: 20 } }),
    enabled: mode === "search",
  });

  const createMutation = useMutation({
    mutationFn: (data: any) =>
      (createProduct as (opts: { data: unknown }) => Promise<any>)({
        data,
      }),
    onSuccess: (created) => {
      queryClient.invalidateQueries({ queryKey: ["products"] });
      const price = created.defaultPrice || "0";
      onSelect(created.name, price);
      setSearch(created.name);
      setMode("search");
      setNewName("");
      setNewPrice("");
      setOpen(false);
    },
  });

  // Exact match check — hide "Add" if search text matches an existing product
  const hasExactMatch = productList.some(
    (p: any) => p.name.toLowerCase() === search.trim().toLowerCase(),
  );

  // Build option list: products + optional "add" action
  const showAddOption = search.trim().length > 0 && !hasExactMatch;
  const totalOptions = productList.length + (showAddOption ? 1 : 0);

  const handleSubmitNew = () => {
    const trimmedName = newName.trim();
    if (!trimmedName) return;
    createMutation.mutate({
      name: trimmedName,
      defaultPrice: newPrice || "0",
    });
  };

  const enterCreateMode = () => {
    setNewName(search.trim());
    setNewPrice("");
    setMode("create");
    // Focus the name input after React renders
    setTimeout(() => nameInputRef.current?.focus(), 0);
  };

  const exitCreateMode = () => {
    setMode("search");
    setHighlightIndex(-1);
    setTimeout(() => searchInputRef.current?.focus(), 0);
  };

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setMode("search");
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // Reset highlight when results change
  useEffect(() => {
    setHighlightIndex(-1);
  }, [search, productList.length]);

  const handleSearchKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "Enter") {
        setOpen(true);
        e.preventDefault();
      }
      return;
    }

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightIndex((prev) => (prev < totalOptions - 1 ? prev + 1 : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightIndex((prev) => (prev > 0 ? prev - 1 : totalOptions - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      // Cmd+Enter or Ctrl+Enter → jump straight to add product
      if ((e.metaKey || e.ctrlKey) && showAddOption) {
        enterCreateMode();
        return;
      }
      if (highlightIndex >= 0 && highlightIndex < productList.length) {
        // Select product
        const p = productList[highlightIndex];
        const price = (p as { defaultPrice?: string }).defaultPrice || "0";
        setSearch((p as { name: string }).name);
        onSelect((p as { name: string }).name, price);
        setOpen(false);
      } else if (
        showAddOption &&
        (highlightIndex === productList.length || highlightIndex === -1)
      ) {
        // Enter create mode
        enterCreateMode();
      }
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  return (
    <div ref={containerRef} className="relative">
      <div className="relative">
        <input
          ref={searchInputRef}
          type="text"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            onChange?.(e.target.value);
            setOpen(true);
            setMode("search");
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={handleSearchKeyDown}
          placeholder="Search products..."
          className="w-full pl-2.5 pr-7 py-2 rounded-md border border-[#e2e8f0] dark:border-white/10 bg-white dark:bg-[#0f172a] text-base sm:text-sm text-[#1e293b] dark:text-white placeholder-[#cbd5e1] dark:placeholder-white/20 focus:outline-none focus:ring-2 focus:ring-[#6366f1]/30 focus:border-[#6366f1] transition-all"
        />
        <svg
          className="absolute right-2 top-1/2 -translate-y-1/2 text-[#94a3b8] dark:text-white/30 pointer-events-none"
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </div>

      {open && (
        <div className="absolute top-full left-0 right-0 mt-1 bg-white dark:bg-[#1e293b] rounded-lg border border-[#e2e8f0] dark:border-white/10 shadow-xl z-30 min-w-[260px] overflow-hidden">
          {mode === "search" ? (
            <>
              {/* Product list */}
              <div className="max-h-48 overflow-y-auto">
                {productList.length > 0
                  ? productList.map((p: any, idx: number) => (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => {
                          const price = p.defaultPrice || "0";
                          setSearch(p.name);
                          onSelect(p.name, price);
                          setOpen(false);
                        }}
                        className={`w-full text-left px-4 py-2.5 text-sm transition-colors flex items-center justify-between ${
                          idx === highlightIndex
                            ? "bg-[#f1f5f9] dark:bg-white/5"
                            : "hover:bg-[#f1f5f9] dark:hover:bg-white/5"
                        }`}
                      >
                        <span className="font-medium text-[#1e293b] dark:text-white truncate">
                          {p.name}
                        </span>
                        {p.defaultPrice && Number(p.defaultPrice) > 0 && (
                          <span className="text-xs text-[#94a3b8] dark:text-white/40 ml-2 shrink-0">
                            {formatCurrency(Number(p.defaultPrice))}
                          </span>
                        )}
                      </button>
                    ))
                  : search.trim() && (
                      <div className="px-4 py-3 text-sm text-[#94a3b8] dark:text-white/40">
                        No products found
                      </div>
                    )}
              </div>

              {/* + Add product action — shown when search has text & no exact match */}
              {showAddOption && (
                <button
                  type="button"
                  onClick={enterCreateMode}
                  className={`w-full text-left px-4 py-2.5 text-sm font-medium transition-colors border-t border-[#e2e8f0] dark:border-white/10 flex items-center gap-2.5 ${
                    highlightIndex === productList.length
                      ? "bg-[#f0fdfa] dark:bg-cyan-900/20 text-[#0891b2]"
                      : "text-[#06b6d4] hover:bg-[#f0fdfa] dark:hover:bg-cyan-900/20"
                  }`}
                >
                  <div className="w-5 h-5 rounded-full bg-[#06b6d4] flex items-center justify-center shrink-0">
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="white"
                      strokeWidth="3"
                      strokeLinecap="round"
                    >
                      <line x1="12" y1="5" x2="12" y2="19" />
                      <line x1="5" y1="12" x2="19" y2="12" />
                    </svg>
                  </div>
                  Add product
                </button>
              )}
            </>
          ) : (
            /* ── Inline create form ── */
            <div>
              {/* Header row: back arrow + title + Add button */}
              <div className="flex items-center gap-2 px-3 py-2.5 border-b border-[#e2e8f0] dark:border-white/10 bg-[#f8fafc] dark:bg-[#0f172a]/50">
                <button
                  type="button"
                  onClick={exitCreateMode}
                  className="p-0.5 rounded text-[#94a3b8] dark:text-white/40 hover:text-[#1e293b] dark:hover:text-white transition-colors"
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
                </button>
                <span className="text-sm font-semibold text-[#1e293b] dark:text-white flex-1">
                  Add a product
                </span>
                <button
                  type="button"
                  onClick={handleSubmitNew}
                  disabled={!newName.trim() || createMutation.isPending}
                  className="px-3 py-1 rounded-md text-xs font-semibold text-white bg-[#16a34a] hover:bg-[#15803d] transition-colors disabled:opacity-50"
                >
                  {createMutation.isPending ? "…" : "Add"}
                </button>
              </div>

              {/* Form fields */}
              <div className="px-3 py-2.5 space-y-2">
                {/* Name field */}
                <div className="flex items-center gap-3">
                  <svg
                    className="text-[#94a3b8] dark:text-white/30 shrink-0"
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
                  </svg>
                  <input
                    ref={nameInputRef}
                    type="text"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        handleSubmitNew();
                      } else if (e.key === "Escape") {
                        exitCreateMode();
                      }
                    }}
                    placeholder="Name"
                    className="flex-1 text-base sm:text-sm text-[#1e293b] dark:text-white placeholder-[#94a3b8] dark:placeholder-white/30 bg-transparent outline-none border-none"
                  />
                </div>

                {/* Price field */}
                <div className="flex items-center gap-3">
                  <svg
                    className="text-[#94a3b8] dark:text-white/30 shrink-0"
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <line x1="12" y1="1" x2="12" y2="23" />
                    <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
                  </svg>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={newPrice}
                    onChange={(e) => setNewPrice(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        handleSubmitNew();
                      } else if (e.key === "Escape") {
                        exitCreateMode();
                      }
                    }}
                    placeholder="0.00"
                    className="flex-1 text-base sm:text-sm text-[#1e293b] dark:text-white placeholder-[#94a3b8] dark:placeholder-white/30 bg-transparent outline-none border-none"
                  />
                  <span className="text-xs text-[#94a3b8] dark:text-white/30">Optional</span>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
