/**
 * BillEditor — the Bills editor form, shared by /bills/create and the Inbox v2 reading pane.
 *
 * It owns the form state, seeded once from `draft` (key the component to load another draft), and
 * hands the edited draft to `onSubmit`. It never saves and never navigates: /bills/create posts
 * createBill and returns to the list, the Inbox runs the existing candidate correction.
 *
 * Amounts stay the strings the inputs hold. Converting them is the caller's job, so each save path
 * keeps its own money rules.
 */
import {
  useCallback,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from "react";
import { VendorCombobox } from "./VendorCombobox";
import { formatCurrency } from "@/utils/format";

// ============================================================================
// Draft
// ============================================================================

export interface BillDraftLine {
  id: string;
  description: string;
  amount: string;
  accountId: string;
  /** Carried through untouched: the form has no dimension fields, but an Inbox line may. */
  departmentId?: string | null;
  locationId?: string | null;
}

export interface BillDraft {
  vendorId: string;
  billNumber: string;
  billDate: string;
  dueDate: string;
  memo: string;
  lineItems: BillDraftLine[];
}

export interface BillCategoryAccount {
  id: string;
  accountNumber?: string | null;
  name: string;
}

export interface BillEditorHandle {
  /** The form as it stands, unvalidated. */
  getDraft: () => BillDraft;
  /** Whether anything differs from the draft the editor was seeded with. */
  isDirty: () => boolean;
  /** Move keyboard focus into the form (the vendor field). */
  focus: () => void;
}

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

export function createEmptyBillLine(defaultAccountId: string): BillDraftLine {
  return {
    id: generateId(),
    description: "",
    amount: "",
    accountId: defaultAccountId,
  };
}

/** A new bill: dated today, due in 30 days, no lines yet. */
export function emptyBillDraft(): BillDraft {
  return {
    vendorId: "",
    billNumber: "",
    billDate: todayISO(),
    dueDate: addDays(todayISO(), 30),
    memo: "",
    lineItems: [],
  };
}

/** The create page's rule for a line worth saving: a category and a positive amount. */
export function isSubmittableBillLine(line: BillDraftLine): boolean {
  return Boolean(line.accountId) && Number.parseFloat(line.amount) > 0;
}

// ============================================================================
// Component
// ============================================================================

export interface BillEditorProps {
  draft: BillDraft;
  onSubmit: (draft: BillDraft) => void;
  /** The categories a line may use. */
  categoryAccounts: BillCategoryAccount[];
  /** The org's mapped default expense; new lines start on it. */
  defaultLineAccountId?: string;
  /**
   * Seed one empty line when the draft has none, once this turns true. /bills/create holds it
   * false until the default-category lookup has settled, so the line never starts uncategorized.
   */
  seedFirstLine?: boolean;
  pending?: boolean;
  /** Keep the save button off (the Inbox, while the item cannot be edited). */
  submitDisabled?: boolean;
  submitLabel?: string;
  pendingLabel?: string;
  /** A failed save, shown under the form. */
  errorMessage?: string | null;
  /** Rendered left of the save button (the create page's "Back to Bills" link). */
  leading?: ReactNode;
  title?: string;
  subtitle?: string;
  headingLevel?: "h1" | "h2";
  /** The Inbox cannot store a due date on a candidate, so it hides the field. */
  showDueDate?: boolean;
  /** Currency of the displayed total (the formatter's default when omitted). */
  currency?: string;
  ref?: Ref<BillEditorHandle>;
}

export function BillEditor({
  draft,
  onSubmit,
  categoryAccounts,
  defaultLineAccountId = "",
  seedFirstLine = false,
  pending = false,
  submitDisabled = false,
  submitLabel = "Save Bill",
  pendingLabel = "Saving…",
  errorMessage = null,
  leading,
  title = "New Bill",
  subtitle = "Create a bill manually — attach receipt later",
  headingLevel = "h1",
  showDueDate = true,
  currency,
  ref,
}: BillEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [initialDraft] = useState(draft);

  // Form state
  const [vendorId, setVendorId] = useState(draft.vendorId);
  const [billNumber, setBillNumber] = useState(draft.billNumber);
  const [billDate, setBillDate] = useState(draft.billDate);
  const [dueDate, setDueDate] = useState(draft.dueDate);
  const [memo, setMemo] = useState(draft.memo);
  const [lineItems, setLineItems] = useState<BillDraftLine[]>(draft.lineItems);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const [initialized, setInitialized] = useState(false);
  if (!initialized && seedFirstLine && lineItems.length === 0) {
    setLineItems([createEmptyBillLine(defaultLineAccountId)]);
    setInitialized(true);
  }

  const currentDraft = useCallback(
    (): BillDraft => ({ vendorId, billNumber, billDate, dueDate, memo, lineItems }),
    [vendorId, billNumber, billDate, dueDate, memo, lineItems],
  );

  useImperativeHandle(
    ref,
    () => ({
      getDraft: currentDraft,
      isDirty: () => JSON.stringify(currentDraft()) !== JSON.stringify(initialDraft),
      focus: () => containerRef.current?.querySelector<HTMLInputElement>("input")?.focus(),
    }),
    [currentDraft, initialDraft],
  );

  // Line item handlers
  const updateLineItem = useCallback((id: string, field: keyof BillDraftLine, value: string) => {
    setLineItems((prev) =>
      prev.map((item) => (item.id === id ? { ...item, [field]: value } : item)),
    );
  }, []);

  const addLineItem = useCallback(() => {
    setLineItems((prev) => [...prev, createEmptyBillLine(defaultLineAccountId)]);
  }, [defaultLineAccountId]);

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
    if (!lineItems.some(isSubmittableBillLine)) {
      // Reachable whenever no default expense category is configured: the
      // category selector starts empty rather than guessing an account, so say
      // that plainly instead of having Save do nothing.
      setSubmitError(
        defaultLineAccountId
          ? "Add at least one line with a category and an amount."
          : "No default expense category is configured. Pick a category for each line, or set the default under Settings → Mappings.",
      );
      return;
    }
    onSubmit(currentDraft());
  };

  const Heading = headingLevel;

  return (
    <div ref={containerRef}>
      {/* Header */}
      <div className="max-w-3xl mx-auto mb-6 flex items-center justify-between">
        {leading ?? <span />}
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!vendorId || lineItems.every((l) => !l.amount) || pending || submitDisabled}
          className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-gradient-to-r from-[#f59e0b] to-[#d97706] text-white text-sm font-medium shadow-sm hover:shadow-md transition-all disabled:opacity-50"
        >
          {pending ? pendingLabel : submitLabel}
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
            <Heading className="text-lg font-semibold text-[#1e293b] dark:text-white">
              {title}
            </Heading>
            <p className="text-xs text-[#64748b] dark:text-white/40 mt-0.5">{subtitle}</p>
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
            {showDueDate && (
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
            )}

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
                            aria-label="Category"
                            className="w-full px-2.5 py-2 rounded-md border border-[#e2e8f0] dark:border-white/10 bg-white dark:bg-[#0f172a] text-base sm:text-sm text-[#1e293b] dark:text-white focus:outline-none focus:ring-2 focus:ring-[#f59e0b]/30 focus:border-[#f59e0b] transition-all"
                          >
                            {/* Without this a line with no category displays the first account
                                while its value is still empty. */}
                            {!item.accountId && (
                              <option value="" disabled>
                                Choose a category
                              </option>
                            )}
                            {categoryAccounts.map((a) => (
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
                  {formatCurrency(total, currency)}
                </span>
              </div>
            </div>
          </div>

          {/* Error */}
          {errorMessage && (
            <div className="px-8 py-3 bg-[#fef2f2] dark:bg-red-900/20 border-t border-[#fecaca] dark:border-red-800/30">
              <p className="text-sm text-[#ef4444]">{errorMessage}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
