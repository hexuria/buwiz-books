/**
 * Manual Bill Creation Page — /bills/create
 * form with vendor combobox + expense account selector.
 */
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, useCallback, useRef } from "react";
import { createBill } from "./api/-bills";
import { listAccounts } from "./api/-accounts";
import { VendorCombobox } from "../components/bills/VendorCombobox";
import { getMappedAccounts } from "./api/-category-mappings";
import { keys as queryKeys } from "../lib/query-keys";
import { formatCurrency } from "@/utils/format";

// ============================================================================
// Helpers
// ============================================================================

function generateId(): string {
  return Math.random().toString(36).slice(2, 11);
}

function todayISO(): string {
  return new Date().toISOString().split("T")[0];
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + days);
  return d.toISOString().split("T")[0];
}

// ============================================================================
// Types
// ============================================================================

interface LineItem {
  id: string;
  description: string;
  amount: string;
  accountId: string;
}

function createEmptyLineItem(defaultAccountId: string): LineItem {
  return {
    id: generateId(),
    description: "",
    amount: "",
    accountId: defaultAccountId,
  };
}

// ============================================================================
// Route
// ============================================================================

export const Route = createFileRoute("/bills_/create")({
  component: BillCreatePage,
});

// ============================================================================
// Page Component
// ============================================================================

function BillCreatePage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // Fetch expense accounts for line item category selector
  const { data: expenseAccounts = [] } = useQuery({
    queryKey: ["accounts", "expense"],
    queryFn: () =>
      (listAccounts as (opts: { data: unknown }) => Promise<any[]>)({
        data: { accountType: "expense" },
      }),
  });

  // Resolve the default expense account SERVER-side, so the org's configured
  // mapping is actually honored. The old client-side resolver was called
  // without the saved mappings and fell back to `expenseAccounts[0]` — an
  // arbitrary expense account presented as if it were the configured default.
  const { data: mappedAccounts } = useQuery({
    queryKey: queryKeys.categoryMappings.resolved("bill", ["default_expense"]),
    queryFn: () =>
      (getMappedAccounts as (opts: { data: unknown }) => Promise<Record<string, string | null>>)({
        data: { mappingType: "bill", sourceKeys: ["default_expense"] },
      }),
    staleTime: 5 * 60 * 1000,
  });
  const defaultExpenseId = mappedAccounts?.default_expense ?? "";

  // Form state
  const [vendorId, setVendorId] = useState("");
  const [billNumber, setBillNumber] = useState("");
  const [billDate, setBillDate] = useState(todayISO());
  const [dueDate, setDueDate] = useState(addDays(todayISO(), 30));
  const [memo, setMemo] = useState("");
  const [lineItems, setLineItems] = useState<LineItem[]>([]);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const submissionIdempotencyKeyRef = useRef<string | null>(null);

  // Seed the first line only once the default-category lookup has SETTLED.
  // Gating on `expenseAccounts` alone seeded it while the mapping query was
  // still in flight, so line one kept an empty accountId forever and was
  // silently dropped at submit — the old `expenseAccounts[0]` fallback hid it.
  const [initialized, setInitialized] = useState(false);
  if (
    !initialized &&
    expenseAccounts.length > 0 &&
    mappedAccounts !== undefined &&
    lineItems.length === 0
  ) {
    setLineItems([createEmptyLineItem(defaultExpenseId)]);
    setInitialized(true);
  }

  // Create mutation
  const createMutation = useMutation({
    mutationFn: (data: any) =>
      (createBill as (opts: { data: unknown }) => Promise<unknown>)({
        data,
      }),
    onSuccess: () => {
      submissionIdempotencyKeyRef.current = null;
      queryClient.invalidateQueries({ queryKey: ["bills"] });
      navigate({ to: "/bills" });
    },
  });

  // Line item handlers
  const updateLineItem = useCallback((id: string, field: keyof LineItem, value: string) => {
    setLineItems((prev) =>
      prev.map((item) => (item.id === id ? { ...item, [field]: value } : item)),
    );
  }, []);

  const addLineItem = useCallback(() => {
    setLineItems((prev) => [...prev, createEmptyLineItem(defaultExpenseId)]);
  }, [defaultExpenseId]);

  const removeLineItem = useCallback((id: string) => {
    setLineItems((prev) => (prev.length > 1 ? prev.filter((i) => i.id !== id) : prev));
  }, []);

  // Totals
  const total = lineItems.reduce((sum, item) => sum + (Number.parseFloat(item.amount) || 0), 0);

  // Term days
  const termDays = Math.round(
    (new Date(`${dueDate}T00:00:00`).getTime() - new Date(`${billDate}T00:00:00`).getTime()) /
      (1000 * 60 * 60 * 24),
  );

  // Submit handler
  const handleSubmit = () => {
    setSubmitError(null);
    if (!vendorId) return;
    const validItems = lineItems.filter(
      (item) => item.accountId && Number.parseFloat(item.amount) > 0,
    );
    if (validItems.length === 0) {
      // Reachable whenever no default expense category is configured: the
      // category selector starts empty rather than guessing an account, so say
      // that plainly instead of having Save do nothing.
      setSubmitError(
        defaultExpenseId
          ? "Add at least one line with a category and an amount."
          : "No default expense category is configured. Pick a category for each line, or set the default under Settings → Mappings.",
      );
      return;
    }
    const idempotencyKey =
      submissionIdempotencyKeyRef.current ??
      (submissionIdempotencyKeyRef.current = crypto.randomUUID());

    createMutation.mutate({
      idempotencyKey,
      vendorId,
      billNumber: billNumber || undefined,
      billDate,
      dueDate,
      memo: memo || undefined,
      lineItems: validItems.map((item) => ({
        description: item.description || undefined,
        amount: Number.parseFloat(item.amount).toFixed(2),
        accountId: item.accountId,
      })),
    });
  };

  return (
    <div className="min-h-full bg-[#f1f5f9] dark:bg-[#0c1322] py-8 px-4">
      {/* Header */}
      <div className="max-w-3xl mx-auto mb-6 flex items-center justify-between">
        <Link
          to={"/bills" as string & {}}
          className="flex items-center gap-1.5 text-sm text-[#f59e0b] hover:text-[#d97706] font-medium no-underline transition-colors"
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
          Back to Bills
        </Link>
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!vendorId || lineItems.every((l) => !l.amount) || createMutation.isPending}
          className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-gradient-to-r from-[#f59e0b] to-[#d97706] text-white text-sm font-medium shadow-sm hover:shadow-md transition-all disabled:opacity-50"
        >
          {createMutation.isPending ? "Saving…" : "Save Bill"}
        </button>
      </div>

      {submitError && (
        <div className="max-w-3xl mx-auto mb-4 rounded-lg border border-amber-300 bg-amber-50 dark:border-amber-500/40 dark:bg-amber-950/30 px-3 py-2 text-sm text-amber-800 dark:text-amber-200">
          {submitError}
        </div>
      )}

      {/* Form Card */}
      <div className="max-w-3xl mx-auto">
        <div className="bg-white dark:bg-[#111827] rounded-xl border border-[#e2e8f0] dark:border-white/10 shadow-sm overflow-hidden">
          {/* Title */}
          <div className="px-8 py-5 bg-gradient-to-r from-[#fffbeb] to-[#fef3c7] dark:from-[#1a1508] dark:to-[#1f1b0a] border-b border-[#e2e8f0] dark:border-white/10">
            <h1 className="text-lg font-semibold text-[#1e293b] dark:text-white">New Bill</h1>
            <p className="text-xs text-[#64748b] dark:text-white/40 mt-0.5">
              Create a bill manually — attach receipt later
            </p>
          </div>

          {/* Metadata Fields */}
          <div className="px-8 py-6 grid grid-cols-2 gap-5">
            {/* Vendor Selection — Combobox */}
            <div className="col-span-2">
              <label className="block text-[11px] font-medium text-[#94a3b8] dark:text-white/40 uppercase tracking-wider mb-1.5">
                Vendor
              </label>
              <VendorCombobox vendorId={vendorId} onSelect={(id: string) => setVendorId(id)} />
            </div>

            {/* Bill Number */}
            <div>
              <label className="block text-[11px] font-medium text-[#94a3b8] dark:text-white/40 uppercase tracking-wider mb-1.5">
                Bill / Invoice Number{" "}
                <span className="text-[10px] font-normal text-[#94a3b8] dark:text-white/30">
                  (Optional)
                </span>
              </label>
              <input
                type="text"
                value={billNumber}
                onChange={(e) => setBillNumber(e.target.value)}
                placeholder="e.g. INV-2026-001"
                className="w-full px-3 py-2.5 rounded-lg border border-[#e2e8f0] dark:border-white/10 bg-white dark:bg-[#0f172a] text-base sm:text-sm text-[#1e293b] dark:text-white placeholder-[#94a3b8] dark:placeholder-white/30 focus:outline-none focus:ring-2 focus:ring-[#f59e0b]/30 focus:border-[#f59e0b] transition-all"
              />
            </div>

            {/* Bill Date */}
            <div>
              <label className="block text-[11px] font-medium text-[#94a3b8] dark:text-white/40 uppercase tracking-wider mb-1.5">
                Bill Date
              </label>
              <input
                type="date"
                value={billDate}
                onChange={(e) => setBillDate(e.target.value)}
                className="w-full px-3 py-2.5 rounded-lg border border-[#e2e8f0] dark:border-white/10 bg-white dark:bg-[#0f172a] text-base sm:text-sm text-[#1e293b] dark:text-white focus:outline-none focus:ring-2 focus:ring-[#f59e0b]/30 focus:border-[#f59e0b] transition-all"
              />
            </div>

            {/* Due Date */}
            <div>
              <label className="block text-[11px] font-medium text-[#94a3b8] dark:text-white/40 uppercase tracking-wider mb-1.5">
                Due Date
                <span className="ml-2 text-[10px] font-normal text-[#94a3b8] dark:text-white/30">
                  ({termDays} days)
                </span>
              </label>
              <input
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
                className="w-full px-3 py-2.5 rounded-lg border border-[#e2e8f0] dark:border-white/10 bg-white dark:bg-[#0f172a] text-base sm:text-sm text-[#1e293b] dark:text-white focus:outline-none focus:ring-2 focus:ring-[#f59e0b]/30 focus:border-[#f59e0b] transition-all"
              />
            </div>

            {/* Memo */}
            <div className="col-span-2">
              <label className="block text-[11px] font-medium text-[#94a3b8] dark:text-white/40 uppercase tracking-wider mb-1.5">
                Memo
              </label>
              <textarea
                value={memo}
                onChange={(e) => setMemo(e.target.value)}
                placeholder="Add any notes for this bill..."
                rows={2}
                className="w-full px-3 py-2.5 rounded-lg border border-[#e2e8f0] dark:border-white/10 bg-white dark:bg-[#0f172a] text-base sm:text-sm text-[#1e293b] dark:text-white placeholder-[#94a3b8] dark:placeholder-white/30 focus:outline-none focus:ring-2 focus:ring-[#f59e0b]/30 focus:border-[#f59e0b] transition-all resize-none"
              />
            </div>
          </div>

          {/* Line Items */}
          <div className="border-t border-[#e2e8f0] dark:border-white/10">
            <div className="px-8 py-4">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-sm font-semibold text-[#1e293b] dark:text-white">Line Items</h2>
                <button
                  type="button"
                  onClick={addLineItem}
                  className="inline-flex items-center gap-1 text-xs font-medium text-[#f59e0b] hover:text-[#d97706] transition-colors"
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
                    <line x1="12" y1="5" x2="12" y2="19" />
                    <line x1="5" y1="12" x2="19" y2="12" />
                  </svg>
                  Add Item
                </button>
              </div>

              <div className="scroll-x scroll-x-shadow">
                <table className="w-full border-separate border-spacing-0 min-w-[34rem]">
                  <thead>
                    <tr className="text-left text-[11px] font-medium text-[#94a3b8] dark:text-white/40 uppercase tracking-wider">
                      <th className="pb-2 pr-3">Description</th>
                      <th className="pb-2 pr-3 w-52">Category</th>
                      <th className="pb-2 w-28 text-right">Amount</th>
                      <th className="pb-2 w-8" />
                    </tr>
                  </thead>
                  <tbody>
                    {lineItems.map((item) => (
                      <tr key={item.id} className="group">
                        {/* Description */}
                        <td className="py-1.5 pr-3">
                          <input
                            type="text"
                            value={item.description}
                            onChange={(e) => updateLineItem(item.id, "description", e.target.value)}
                            placeholder="Item description..."
                            className="w-full px-2.5 py-2 rounded-md border border-[#e2e8f0] dark:border-white/10 bg-white dark:bg-[#0f172a] text-base sm:text-sm text-[#1e293b] dark:text-white placeholder-[#94a3b8] dark:placeholder-white/30 focus:outline-none focus:ring-2 focus:ring-[#f59e0b]/30 focus:border-[#f59e0b] transition-all"
                          />
                        </td>
                        {/* Category */}
                        <td className="py-1.5 pr-3">
                          <select
                            value={item.accountId}
                            onChange={(e) => updateLineItem(item.id, "accountId", e.target.value)}
                            className="w-full px-2.5 py-2 rounded-md border border-[#e2e8f0] dark:border-white/10 bg-white dark:bg-[#0f172a] text-base sm:text-sm text-[#1e293b] dark:text-white focus:outline-none focus:ring-2 focus:ring-[#f59e0b]/30 focus:border-[#f59e0b] transition-all"
                          >
                            {expenseAccounts.map((a: any) => (
                              <option key={a.id} value={a.id}>
                                {a.accountNumber} — {a.name}
                              </option>
                            ))}
                          </select>
                        </td>
                        {/* Amount */}
                        <td className="py-1.5">
                          <input
                            type="number"
                            step="0.01"
                            min="0"
                            value={item.amount}
                            onChange={(e) => updateLineItem(item.id, "amount", e.target.value)}
                            placeholder="0.00"
                            className="w-full px-2.5 py-2 rounded-md border border-[#e2e8f0] dark:border-white/10 bg-white dark:bg-[#0f172a] text-base sm:text-sm text-[#1e293b] dark:text-white text-right placeholder-[#94a3b8] dark:placeholder-white/30 focus:outline-none focus:ring-2 focus:ring-[#f59e0b]/30 focus:border-[#f59e0b] transition-all"
                          />
                        </td>
                        {/* Remove */}
                        <td className="py-1.5 pl-2">
                          <button
                            type="button"
                            onClick={() => removeLineItem(item.id)}
                            className="p-1 rounded-full text-[#94a3b8] dark:text-white/30 hover:text-[#ef4444] hover:bg-[#fef2f2] dark:hover:bg-red-900/20 transition-all opacity-0 group-hover:opacity-100"
                            title="Remove line"
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
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Total */}
            <div className="px-8 py-4 border-t border-[#e2e8f0] dark:border-white/10 bg-[#f8fafc] dark:bg-[#0d1322]">
              <div className="flex justify-end items-baseline gap-4">
                <span className="text-sm font-medium text-[#64748b] dark:text-white/50">Total</span>
                <span className="text-xl font-bold text-[#1e293b] dark:text-white">
                  {formatCurrency(total)}
                </span>
              </div>
            </div>
          </div>

          {/* Error */}
          {createMutation.isError && (
            <div className="px-8 py-3 bg-[#fef2f2] dark:bg-red-900/20 border-t border-[#fecaca] dark:border-red-800/30">
              <p className="text-sm text-[#ef4444]">Failed to create bill. Please try again.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
