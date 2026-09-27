/**
 * Manual Bill Creation Page — /bills/create
 * form with vendor combobox + expense account selector.
 *
 * The form itself is the shared BillEditor (the Inbox reading pane renders the same component);
 * this route owns the data it needs, the createBill save, and the return to /bills.
 */
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { createBill } from "./api/-bills";
import { listAccounts } from "./api/-accounts";
import {
  BillEditor,
  emptyBillDraft,
  isSubmittableBillLine,
  type BillDraft,
} from "../components/bills/BillEditor";
import { getMappedAccounts } from "./api/-category-mappings";
import { keys as queryKeys } from "../lib/query-keys";

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

  const [initialDraft] = useState(emptyBillDraft);
  const submissionIdempotencyKeyRef = useRef<string | null>(null);

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

  // Submit handler — the editor has already checked for a vendor and a saveable line.
  const handleSubmit = (draft: BillDraft) => {
    const validItems = draft.lineItems.filter(isSubmittableBillLine);
    const idempotencyKey =
      submissionIdempotencyKeyRef.current ??
      (submissionIdempotencyKeyRef.current = crypto.randomUUID());

    createMutation.mutate({
      idempotencyKey,
      vendorId: draft.vendorId,
      billNumber: draft.billNumber || undefined,
      billDate: draft.billDate,
      dueDate: draft.dueDate,
      memo: draft.memo || undefined,
      lineItems: validItems.map((item) => ({
        description: item.description || undefined,
        amount: Number.parseFloat(item.amount).toFixed(2),
        accountId: item.accountId,
      })),
    });
  };

  return (
    <div className="min-h-full bg-[#f1f5f9] dark:bg-[#0c1322] py-8 px-4">
      <BillEditor
        draft={initialDraft}
        onSubmit={handleSubmit}
        categoryAccounts={expenseAccounts}
        defaultLineAccountId={defaultExpenseId}
        // Seed the first line only once the default-category lookup has SETTLED.
        // Gating on `expenseAccounts` alone seeded it while the mapping query was
        // still in flight, so line one kept an empty accountId forever and was
        // silently dropped at submit — the old `expenseAccounts[0]` fallback hid it.
        seedFirstLine={expenseAccounts.length > 0 && mappedAccounts !== undefined}
        pending={createMutation.isPending}
        submitLabel="Save Bill"
        errorMessage={createMutation.isError ? "Failed to create bill. Please try again." : null}
        leading={
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
        }
      />
    </div>
  );
}
