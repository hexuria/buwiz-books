/**
 * TransferForm — Reusable transfer (from → to) form
 * Used by both /transactions/new and /transactions/$transactionId
 */
import { useMemo } from "react";
import Combobox from "../../ui/Combobox";
import type { SuggestedItem } from "../../ui/Combobox";
import CategoryPartyCombobox from "./CategoryPartyCombobox";
import { ICON_PATHS } from "../../accounts/icons";
import type { AccountOption, CreatePartyFn, ListPartiesFn } from "../shared/types";
import { labelClass, CATEGORY_ICON } from "../shared/constants";
import { buildAccountOptions, filterCategoryOptions } from "../shared/helpers";
import type { PartyMappingOverride } from "../../../lib/party-scoping";

interface TransferFormProps {
  accounts: AccountOption[];
  fromParty: string;
  fromCategory: string;
  toParty: string;
  toCategory: string;
  amount: string;
  onAmountChange: (v: string) => void;
  onFromPartyChange: (v: string) => void;
  onFromCategoryChange: (v: string) => void;
  onToPartyChange: (v: string) => void;
  onToCategoryChange: (v: string) => void;
  listPartiesFn: ListPartiesFn;
  createPartyFn?: CreatePartyFn;
  partyOverrides?: Record<string, PartyMappingOverride>;
  readOnly?: boolean;
  /** Create from-category from query */
  onCreateFromCategory?: (query: string) => void;
  /** Create to-category from query */
  onCreateToCategory?: (query: string) => void;
  /** Propagate combobox search for suggestion matching */
  onCategorySugQuery?: (query: string) => void;
  /** Pre-computed category suggestions */
  categorySuggestions?: SuggestedItem[];
  /** User clicked a suggested category for From */
  onCreateFromCategorySuggestion?: (item: SuggestedItem) => void;
  /** User clicked a suggested category for To */
  onCreateToCategorySuggestion?: (item: SuggestedItem) => void;
  /** Notify parent of resolved From party name (for avatar) */
  onFromPartyNameChange?: (name: string) => void;
  /** Notify parent of resolved To party name (for avatar) */
  onToPartyNameChange?: (name: string) => void;
}

export default function TransferForm({
  accounts,
  fromParty,
  fromCategory,
  toParty,
  toCategory,
  amount: _amount,
  onAmountChange: _onAmountChange,
  onFromPartyChange,
  onFromCategoryChange,
  onToPartyChange,
  onToCategoryChange,
  listPartiesFn,
  createPartyFn,
  partyOverrides,
  readOnly = false,
  onCreateFromCategory,
  onCreateToCategory,
  onCategorySugQuery,
  categorySuggestions,
  onCreateFromCategorySuggestion,
  onCreateToCategorySuggestion,
  onFromPartyNameChange,
  onToPartyNameChange,
}: TransferFormProps) {
  // Filter accounts for Transfer (Assets/Liab/Equity)
  const filteredAccounts = useMemo(() => filterCategoryOptions(accounts, "transfer"), [accounts]);
  const categoryOptions = useMemo(() => {
    const base = buildAccountOptions(filteredAccounts);
    // Ensure currently-selected from/to categories always appear in options,
    // even if they fall outside the transfer type filter (e.g. after Journal → Transfer swap).
    const baseIds = new Set(filteredAccounts.map((a) => a.id));
    for (const catId of [fromCategory, toCategory]) {
      if (catId && !baseIds.has(catId)) {
        const match = accounts.find((a) => a.id === catId);
        if (match) {
          base.unshift(buildAccountOptions([match])[0]);
          baseIds.add(catId);
        }
      }
    }
    return base;
  }, [filteredAccounts, accounts, fromCategory, toCategory]);

  // ── Read-only view ──
  if (readOnly) {
    const fromCat = categoryOptions.find((o) => o.value === fromCategory);
    const toCat = categoryOptions.find((o) => o.value === toCategory);

    return (
      <div>
        <div className="flex flex-col gap-2 md:grid md:grid-cols-[1fr_auto_1fr] md:gap-4 md:items-start">
          {/* Transfer From */}
          <div>
            <div className={labelClass}>
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                dangerouslySetInnerHTML={{ __html: ICON_PATHS.Bank }}
              />
              Transfer From
            </div>
            <div className="bg-white dark:bg-slate-800 rounded-md border border-[#e2e8f0] dark:border-slate-700 px-3 py-2 text-sm text-[#1e293b] dark:text-slate-200 font-medium">
              {fromCat?.label || "—"}
            </div>
          </div>

          {/* Arrow — down on mobile, right on md+ */}
          <div className="flex items-center justify-center py-1 md:pt-8 md:py-0">
            {/* Down arrow (mobile) */}
            <svg
              className="md:hidden"
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#94a3b8"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="12" y1="5" x2="12" y2="19" />
              <polyline points="19 12 12 19 5 12" />
            </svg>
            {/* Right arrow (md+) */}
            <svg
              className="hidden md:block"
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#94a3b8"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="5" y1="12" x2="19" y2="12" />
              <polyline points="12 5 19 12 12 19" />
            </svg>
          </div>

          {/* Transfer To */}
          <div>
            <div className={labelClass}>
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                dangerouslySetInnerHTML={{ __html: ICON_PATHS.Bank }}
              />
              Transfer To
            </div>
            <div className="bg-white dark:bg-slate-800 rounded-md border border-[#e2e8f0] dark:border-slate-700 px-3 py-2 text-sm text-[#1e293b] dark:text-slate-200 font-medium">
              {toCat?.label || "—"}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── Edit mode ──
  return (
    <div>
      <div className="flex flex-col gap-2 md:grid md:grid-cols-[1fr_auto_1fr] md:gap-4 md:items-start">
        {/* Transfer From */}
        <div>
          <div className={labelClass}>
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              dangerouslySetInnerHTML={{ __html: ICON_PATHS.Bank }}
            />
            Transfer From
          </div>
          <div className="space-y-2">
            <Combobox
              value={fromCategory}
              onChange={onFromCategoryChange}
              options={categoryOptions}
              placeholder="Category..."
              placeholderIcon={CATEGORY_ICON}
              searchPlaceholder="Select or Create New"
              onCreate={onCreateFromCategory}
              createLabel="category"
              onSearch={onCategorySugQuery}
              suggestions={categorySuggestions}
              onCreateSuggestion={onCreateFromCategorySuggestion}
            />
            <CategoryPartyCombobox
              value={fromParty}
              onChange={onFromPartyChange}
              onNameChange={onFromPartyNameChange}
              categoryId={fromCategory}
              flatAccounts={accounts}
              listPartiesFn={listPartiesFn}
              createPartyFn={createPartyFn}
              overrides={partyOverrides}
            />
          </div>
        </div>

        {/* Arrow — down on mobile, right on md+ */}
        <div className="flex items-center justify-center py-1 md:pt-8 md:py-0">
          {/* Down arrow (mobile) */}
          <svg
            className="md:hidden"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#94a3b8"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <line x1="12" y1="5" x2="12" y2="19" />
            <polyline points="19 12 12 19 5 12" />
          </svg>
          {/* Right arrow (md+) */}
          <svg
            className="hidden md:block"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#94a3b8"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <line x1="5" y1="12" x2="19" y2="12" />
            <polyline points="12 5 19 12 12 19" />
          </svg>
        </div>

        {/* Transfer To */}
        <div>
          <div className={labelClass}>
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              dangerouslySetInnerHTML={{ __html: ICON_PATHS.Bank }}
            />
            Transfer To
          </div>
          <div className="space-y-2">
            <Combobox
              value={toCategory}
              onChange={onToCategoryChange}
              options={categoryOptions}
              placeholder="Category..."
              placeholderIcon={CATEGORY_ICON}
              searchPlaceholder="Select or Create New"
              onCreate={onCreateToCategory}
              createLabel="category"
              onSearch={onCategorySugQuery}
              suggestions={categorySuggestions}
              onCreateSuggestion={onCreateToCategorySuggestion}
            />
            <CategoryPartyCombobox
              value={toParty}
              onChange={onToPartyChange}
              onNameChange={onToPartyNameChange}
              categoryId={toCategory}
              flatAccounts={accounts}
              listPartiesFn={listPartiesFn}
              createPartyFn={createPartyFn}
              overrides={partyOverrides}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
