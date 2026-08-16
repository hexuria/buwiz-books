import React, { useState } from "react";
import type { AccountType } from "./CategoryRow";

// ============================================================================
// Types
// ============================================================================

export interface CategoryPrefill {
  name?: string;
  parentId?: string;
  accountNumber?: string;
  description?: string;
  accountType?: AccountType;
  subtype?: string;
}

interface NewCategoryFormProps {
  parentCategories?: Array<{ id: string; name: string; accountNumber?: string }>;
  onSubmit: (data: NewCategoryData) => void;
  onCancel: () => void;
  prefill?: CategoryPrefill;
}

export interface NewCategoryData {
  name: string;
  parentId?: string;
  accountNumber?: string;
  description?: string;
  accountType: AccountType;
}

// ============================================================================
// Icon Options
// ============================================================================

const accountTypeOptions: { value: AccountType; label: string }[] = [
  { value: "asset", label: "Assets" },
  { value: "liability", label: "Liabilities" },
  { value: "equity", label: "Equity" },
  { value: "revenue", label: "Revenue" },
  { value: "expense", label: "Expenses" },
  { value: "cost_of_revenue", label: "Cost of Goods Sold" },
  { value: "other_income", label: "Other Income" },
  { value: "other_expense", label: "Other Expenses" },
];

// ============================================================================
// Shared Tailwind class strings
// ============================================================================

const formInput =
  "w-full px-3 py-2.5 text-base sm:text-sm border border-gray-200 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 text-[var(--color-app-text-navy)] dark:text-slate-200 transition-colors focus:outline-none focus:border-[var(--color-app-header-teal)]";

const formLabel = "block text-xs font-medium text-[var(--color-app-text-light)] mb-1.5";

// ============================================================================
// Component
// ============================================================================

export const NewCategoryForm: React.FC<NewCategoryFormProps> = ({
  parentCategories = [],
  onSubmit,
  onCancel,
  prefill,
}) => {
  const [name, setName] = useState(prefill?.name ?? "");
  const [parentId, setParentId] = useState(prefill?.parentId ?? "");
  const [accountNumber, setAccountNumber] = useState(prefill?.accountNumber ?? "");
  const [description, setDescription] = useState(prefill?.description ?? "");
  const [accountType, setAccountType] = useState<AccountType>(prefill?.accountType ?? "asset");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    onSubmit({
      name: name.trim(),
      parentId: parentId || undefined,
      accountNumber: accountNumber || undefined,
      description: description || undefined,
      accountType,
    });
  };

  return (
    <div className="bg-[var(--color-app-card)] rounded-2xl shadow-[0_4px_24px_rgba(0,0,0,0.08)] overflow-hidden w-[360px] shrink-0">
      {/* Header */}
      <div className="bg-[var(--color-app-header-teal)] text-white px-5 py-4 flex items-center gap-3 font-semibold text-base">
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
        <span>New Category</span>
      </div>

      {/* Form */}
      <form onSubmit={handleSubmit} className="p-4 bg-white dark:bg-slate-800">
        {/* Category Name */}
        <div className="mb-4">
          <label className={formLabel}>Category Name</label>
          <input
            type="text"
            className={formInput}
            placeholder="Activate or create new..."
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </div>

        {/* Parent Category */}
        <div className="mb-4">
          <label className={formLabel}>Parent Category</label>
          <select
            className={formInput}
            value={parentId}
            onChange={(e) => setParentId(e.target.value)}
          >
            <option value="">Select parent...</option>
            {parentCategories.map((cat) => (
              <option key={cat.id} value={cat.id}>
                {cat.name} {cat.accountNumber && `(${cat.accountNumber})`}
              </option>
            ))}
          </select>
        </div>

        {/* Account Type */}
        <div className="mb-4">
          <label className={formLabel}>Subtype</label>
          <select
            className={formInput}
            value={accountType}
            onChange={(e) => setAccountType(e.target.value as AccountType)}
          >
            <option value="">Select subtype...</option>
            {accountTypeOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        {/* Icon and Category Number */}
        <div className="flex gap-3 [&>*]:flex-1">
          <div className="mb-4">
            <label className={formLabel}>Icon</label>
            <button type="button" className={`${formInput} flex items-center justify-center`}>
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="#6b7c93"
                strokeWidth="2"
              >
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <path d="M3 9h18" />
                <path d="M9 21V9" />
              </svg>
            </button>
          </div>
          <div className="mb-4">
            <label className={formLabel}>Category Number (Optional)</label>
            <input
              type="text"
              className={formInput}
              placeholder="00000"
              value={accountNumber}
              onChange={(e) => setAccountNumber(e.target.value)}
            />
          </div>
        </div>

        {/* Description */}
        <div className="mb-4">
          <label className={formLabel}>Description (Optional)</label>
          <textarea
            className={`${formInput} resize-y min-h-[80px]`}
            placeholder="Enter a description..."
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>

        {/* Buttons */}
        <div className="flex justify-end gap-3 pt-4 border-t border-gray-200 -mx-4 -mb-4 px-4 pb-4">
          <button
            type="button"
            className="inline-flex items-center justify-center gap-2 px-5 py-2.5 text-sm font-semibold rounded-lg cursor-pointer transition-all bg-white dark:bg-slate-700 text-[var(--color-app-text-navy)] dark:text-slate-200 border border-gray-200 dark:border-slate-600 hover:bg-[#f5f6f9] dark:hover:bg-slate-600"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="inline-flex items-center justify-center gap-2 px-5 py-2.5 text-sm font-semibold rounded-lg cursor-pointer transition-all border-none bg-[var(--color-app-header-teal)] text-white hover:bg-[#248f82]"
          >
            Create
          </button>
        </div>
      </form>
    </div>
  );
};

export default NewCategoryForm;
