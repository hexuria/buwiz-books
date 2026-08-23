/**
 * Edit Line Items Panel — replaces the right-hand column
 * when "Split Line Items" is clicked from Bookkeeping.
 *
 * Shows AI-decoded line items with editable description, category, and amount.
 * Footer: Difference, Bill Amount, Items Amount
 */
import { useState, useCallback, useMemo } from "react";
import { keys } from "../../lib/query-keys";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { saveBillLineItems } from "../../routes/api/-bills";
import { listAccounts } from "../../routes/api/-accounts";
import Combobox from "../ui/Combobox";
import { buildAccountOptions } from "../transactions/shared/helpers";
import { formatCurrency } from "@/utils/format";

// ============================================================================
// Types
// ============================================================================

interface LineItem {
  id?: string;
  description: string;
  amount: string;
  accountId: string;
  accountName?: string;
}

interface EditLineItemsPanelProps {
  billId: string;
  billAmount: string | number;
  lineItems: Array<{
    id: string;
    description: string | null;
    amount: string;
    accountId: string;
    accountName: string;
    accountNumber: string | null;
  }>;
  onClose: () => void;
  onSave: () => void;
}

// ============================================================================
// Helpers
// ============================================================================

// ============================================================================
// Component
// ============================================================================

export function EditLineItemsPanel({
  billId,
  billAmount,
  lineItems: initialLineItems,
  onClose,
  onSave,
}: EditLineItemsPanelProps) {
  const queryClient = useQueryClient();

  // Local editable line items
  const [items, setItems] = useState<LineItem[]>(() =>
    initialLineItems.map((li) => ({
      id: li.id,
      description: li.description ?? "",
      amount: li.amount,
      accountId: li.accountId,
      accountName: li.accountName,
    })),
  );

  // Fetch accounts for category dropdowns
  const { data: accounts = [] } = useQuery({
    queryKey: ["accounts-expense"],
    queryFn: () =>
      (listAccounts as (opts: { data: unknown }) => Promise<any[]>)({
        data: {
          types: ["expense", "cost_of_revenue", "other_expense"],
        },
      }),
  });

  // Expense accounts only (for bill line items)
  const expenseAccounts = accounts.filter(
    (a: any) =>
      a.accountType === "expense" ||
      a.accountType === "cost_of_revenue" ||
      a.accountType === "other_expense",
  );

  // Build combobox options from expense accounts
  const categoryOptions = useMemo(() => buildAccountOptions(expenseAccounts), [expenseAccounts]);

  const updateItem = useCallback((index: number, updates: Partial<LineItem>) => {
    setItems((prev) => prev.map((item, i) => (i === index ? { ...item, ...updates } : item)));
  }, []);

  const removeItem = useCallback((index: number) => {
    setItems((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const addItem = useCallback(() => {
    setItems((prev) => [
      ...prev,
      {
        description: "",
        amount: "0.00",
        accountId: expenseAccounts[0]?.id ?? "",
        accountName: expenseAccounts[0]?.name ?? "Select category",
      },
    ]);
  }, [expenseAccounts]);

  // Totals
  const itemsTotal = items.reduce((sum, item) => sum + (Number.parseFloat(item.amount) || 0), 0);
  const billTotal = Number.parseFloat(String(billAmount)) || 0;
  const difference = billTotal - itemsTotal;

  // Save mutation
  const mutation = useMutation({
    mutationFn: () =>
      (saveBillLineItems as (opts: { data: unknown }) => Promise<unknown>)({
        data: {
          billId,
          lineItems: items.map((item, i) => ({
            description: item.description || undefined,
            amount: item.amount,
            accountId: item.accountId,
            sortOrder: i,
          })),
        },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: keys.bills.detail(billId) });
      onSave();
    },
  });

  return (
    <div className="flex flex-col h-full">
      {/* Scrollable body */}
      <div className="flex-1 overflow-y-auto p-5 flex flex-col gap-4">
        {/* Header */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onClose}
            className="w-7 h-7 min-h-11 min-w-11 lg:min-h-0 lg:min-w-0 flex items-center justify-center rounded-lg text-[#64748b] dark:text-white/50 hover:bg-[#f1f5f9] dark:hover:bg-white/5 transition-colors"
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
          <div className="flex items-center gap-1.5">
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#10b981"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
            </svg>
            <h3 className="text-sm font-semibold text-[#1e293b] dark:text-white">
              Edit Line Items
            </h3>
          </div>
        </div>

        {/* Line items */}
        <div className="flex flex-col gap-3">
          {items.map((item, idx) => (
            <div
              key={idx}
              className="p-3 rounded-lg border border-[#e2e8f0] dark:border-white/10 bg-[#f8fafc] dark:bg-[#0f172a]/50"
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-[11px] font-medium text-[#94a3b8] dark:text-white/40">
                  Line {idx + 1}
                </span>
                {items.length > 1 && (
                  <button
                    type="button"
                    onClick={() => removeItem(idx)}
                    className="w-5 h-5 flex items-center justify-center rounded text-[#94a3b8] hover:text-[#ef4444] hover:bg-[#fef2f2] dark:hover:bg-red-900/20 transition-colors"
                  >
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                )}
              </div>

              {/* Description */}
              <input
                type="text"
                value={item.description}
                onChange={(e) => updateItem(idx, { description: e.target.value })}
                className="w-full px-3 py-1.5 mb-2 rounded-lg border border-[#e2e8f0] dark:border-white/10 bg-white dark:bg-[#111827] text-base sm:text-sm text-[#1e293b] dark:text-white focus:outline-none focus:ring-2 focus:ring-[#10b981]/30 focus:border-[#10b981] transition-all"
                placeholder="Description"
              />

              <div className="grid grid-cols-[1fr_100px] gap-2">
                {/* Category combobox */}
                <Combobox
                  value={item.accountId}
                  onChange={(val) => {
                    const acc = expenseAccounts.find((a: any) => a.id === val);
                    updateItem(idx, {
                      accountId: val,
                      accountName: acc?.name ?? "Unknown",
                    });
                  }}
                  options={categoryOptions}
                  placeholder="Select category"
                  searchPlaceholder="Search categories..."
                  className="text-xs"
                />

                {/* Amount */}
                <input
                  type="number"
                  step="0.01"
                  value={item.amount}
                  onChange={(e) => updateItem(idx, { amount: e.target.value })}
                  className="px-2 py-1.5 rounded-lg border border-[#e2e8f0] dark:border-white/10 bg-white dark:bg-[#111827] text-base sm:text-sm text-right text-[#1e293b] dark:text-white focus:outline-none focus:ring-2 focus:ring-[#10b981]/30 focus:border-[#10b981] transition-all font-mono"
                  placeholder="0.00"
                />
              </div>
            </div>
          ))}
        </div>

        {/* Add line */}
        <button
          type="button"
          onClick={addItem}
          className="flex items-center justify-center gap-1.5 py-2 rounded-lg border border-dashed border-[#cbd5e1] dark:border-white/15 text-xs font-medium text-[#64748b] dark:text-white/50 hover:border-[#10b981] hover:text-[#10b981] transition-colors"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          Add Line Item
        </button>
      </div>

      {/* ─── Footer ─── */}
      <div className="shrink-0 border-t border-[#e2e8f0] dark:border-white/10 bg-white dark:bg-[#111827]">
        {/* Stats */}
        <div className="px-5 py-3 flex flex-col gap-1.5 text-xs">
          <div className="flex items-center justify-between">
            <span className="text-[#94a3b8] dark:text-white/40">Bill Amount</span>
            <span className="text-[#1e293b] dark:text-white font-medium">
              {formatCurrency(billTotal)}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[#94a3b8] dark:text-white/40">Items Amount</span>
            <span className="text-[#1e293b] dark:text-white font-medium">
              {formatCurrency(itemsTotal)}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[#94a3b8] dark:text-white/40">Difference</span>
            <span
              className={`font-semibold ${
                Math.abs(difference) < 0.01 ? "text-[#10b981]" : "text-[#f59e0b]"
              }`}
            >
              {formatCurrency(difference)}
            </span>
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-[#e2e8f0] dark:border-white/10">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-sm font-medium text-[#64748b] dark:text-white/50 hover:bg-[#f1f5f9] dark:hover:bg-white/5 transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending || items.length === 0}
            className="px-4 py-2 rounded-lg bg-[#10b981] hover:bg-[#059669] text-white text-sm font-medium transition-all disabled:opacity-50"
          >
            {mutation.isPending ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
