/**
 * AIChatPanel — Natural language AI assistant for transaction form filling.
 * Supports text prompts for quick data entry.
 * Renders as a sidebar panel (inside the right sidebar tabs).
 */
import { useState, useRef, useCallback, useEffect } from "react";
import type { ParsedTransactionResult } from "../../routes/api/-ai-transaction-parse";
import { callServerFn } from "../../lib/server-fn-client";

interface AccountCtx {
  id: string;
  name: string;
  accountNumber?: string | null;
  accountType: string;
}

interface DimensionCtx {
  id: string;
  name: string;
}

export interface AIChatPanelProps {
  accounts: AccountCtx[];
  parties: DimensionCtx[];
  departments: DimensionCtx[];
  locations: DimensionCtx[];
  currentDate: string;
  onApply: (result: ParsedTransactionResult) => void;
  initialPrompt?: string | null;
}

const QUICK_PROMPTS = [
  { label: "💸 Pay expense", prompt: "Paid $500 for office supplies" },
  { label: "💰 Receive payment", prompt: "Received $3,000 from client for services" },
  { label: "🔄 Transfer", prompt: "Transfer $10,000 from checking to savings" },
  { label: "📝 Journal", prompt: "Record depreciation $200 on equipment" },
  { label: "🏠 Rent", prompt: "Pay rent $2,000 for this month" },
  { label: "⚡ Utility", prompt: "Electric bill $150" },
];

export default function AIChatPanel({
  accounts,
  parties,
  departments,
  locations,
  currentDate,
  onApply,
  initialPrompt,
}: AIChatPanelProps) {
  const [prompt, setPrompt] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const initialPromptFired = useRef(false);

  const handleSubmit = useCallback(async () => {
    const text = prompt.trim();
    if (!text || isLoading) return;

    setIsLoading(true);
    setError(null);

    try {
      const { parseTransactionPrompt } = await import("../../routes/api/-ai-transaction-parse");

      const parsed = (await callServerFn(parseTransactionPrompt, {
        data: {
          prompt: text,
          currentDate,
          accounts: accounts.map((a) => ({
            id: a.id,
            name: a.name,
            accountNumber: a.accountNumber,
            accountType: a.accountType,
          })),
          parties: parties.map((p) => ({ id: p.id, name: p.name })),
          departments: departments.map((d) => ({ id: d.id, name: d.name })),
          locations: locations.map((l) => ({ id: l.id, name: l.name })),
        },
      })) as any;

      // For text prompts, we apply immediately and don't require review,
      // as they are typically used directly from the transaction form UI.
      onApply(parsed);
      setPrompt("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to parse transaction");
    } finally {
      setIsLoading(false);
    }
  }, [prompt, isLoading, currentDate, accounts, parties, departments, locations, onApply]);

  const [pendingAutoSubmit, setPendingAutoSubmit] = useState(false);

  useEffect(() => {
    if (!initialPrompt || initialPromptFired.current || accounts.length === 0) return;
    initialPromptFired.current = true;
    setPrompt(initialPrompt);
    setPendingAutoSubmit(true);
  }, [initialPrompt, accounts]);

  useEffect(() => {
    if (!pendingAutoSubmit || !prompt || isLoading) return;
    setPendingAutoSubmit(false);
    handleSubmit();
  }, [pendingAutoSubmit, prompt, isLoading, handleSubmit]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit],
  );

  const handleQuickPrompt = useCallback((text: string) => {
    setPrompt(text);
    setError(null);
    setTimeout(() => textareaRef.current?.focus(), 50);
  }, []);

  const handleClear = useCallback(() => {
    setPrompt("");
    setError(null);
  }, []);

  return (
    <div className="flex flex-col gap-3 h-full transition-all">
      {/* Quick prompts */}
      <div className="flex flex-wrap gap-1.5">
        {QUICK_PROMPTS.map((qp) => (
          <button
            key={qp.label}
            type="button"
            onClick={() => handleQuickPrompt(qp.prompt)}
            className="px-2 py-1 rounded-full text-[10px] font-medium text-[#475569] dark:text-slate-400 bg-[#f1f5f9] dark:bg-slate-800 hover:bg-[#e2e8f0] dark:hover:bg-slate-700 border border-[#e2e8f0] dark:border-slate-700 transition-colors cursor-pointer"
          >
            {qp.label}
          </button>
        ))}
      </div>

      {/* Input area */}
      <div>
        <div className="relative">
          <textarea
            ref={textareaRef}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder='"Paid $500 for office supplies"'
            rows={3}
            className="w-full px-3 py-2 rounded-lg border border-[#e2e8f0] dark:border-slate-600 bg-[#f8f9fb] dark:bg-slate-800 text-base sm:text-xs text-[#1e293b] dark:text-slate-200 placeholder-[#94a3b8] dark:placeholder-slate-500 focus:outline-none focus:border-[var(--color-app-header-teal)] focus:ring-1 focus:ring-[var(--color-app-header-teal)] transition-colors resize-none"
            disabled={isLoading}
          />
          {prompt && !isLoading && (
            <button
              type="button"
              onClick={handleClear}
              className="absolute right-2 top-2 w-4 h-4 rounded flex items-center justify-center text-[#94a3b8] hover:text-[#475569] transition-colors cursor-pointer"
            >
              <svg
                width="10"
                height="10"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
              >
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>

        {/* Error */}
        {error && (
          <div className="mt-2 px-2.5 py-2 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800">
            <p className="text-[10px] text-red-700 dark:text-red-300">{error}</p>
          </div>
        )}

        <div className="flex items-center justify-between mt-1.5">
          <div className="flex items-center gap-2">
            <p className="text-[9px] text-[#94a3b8] dark:text-slate-500">
              <kbd className="px-1 py-0.5 rounded bg-[#f1f5f9] dark:bg-slate-800 text-[8px] font-mono border border-[#e2e8f0] dark:border-slate-600">
                ⌘ ↵
              </kbd>{" "}
              to apply
            </p>
          </div>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!prompt.trim() || isLoading}
            className="flex items-center gap-1 px-3 py-1.5 rounded-md bg-[var(--color-app-header-teal)] hover:bg-[#248f82] disabled:opacity-40 disabled:cursor-not-allowed text-white text-[10px] font-medium transition-colors shrink-0 cursor-pointer"
          >
            {isLoading ? (
              <>
                <svg
                  className="animate-spin"
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                >
                  <circle
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="3"
                    strokeDasharray="32"
                    strokeLinecap="round"
                  />
                </svg>
                Applying…
              </>
            ) : (
              <>
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />
                </svg>
                Apply
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
