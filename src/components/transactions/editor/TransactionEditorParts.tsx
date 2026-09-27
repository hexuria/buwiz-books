/**
 * The New transaction editor's visible pieces, driven by `useTransactionEditor`.
 *
 * /transactions/new arranges them in its full-page layout (tab rail, top bar, card, sidebar); the
 * Inbox reading pane arranges the same pieces through `TransactionEditor`. Markup moved here
 * unchanged from the route.
 */
import { createParty, listParties } from "@/routes/api/-parties";
import { callServerFn } from "@/lib/server-fn-client";
import Combobox from "../../ui/Combobox";
import DayPicker from "../../ui/DayPicker";
import NewCategoryModal from "../../accounts/NewCategoryModal";
import { ICON_PATHS } from "../../accounts/icons";
import MultiAvatar from "../shared/MultiAvatar";
import { PARTY_ICON, TABS, TYPE_LABELS } from "../shared/constants";
import { formatCurrency } from "../shared/helpers";
import JournalForm from "../forms/JournalForm";
import PayForm from "../forms/PayForm";
import TransferForm from "../forms/TransferForm";
import type { TransactionEditorState } from "./useTransactionEditor";

// ============================================================================
// Type tabs
// ============================================================================

/**
 * Journal / Pay In / Pay Out / Transfer. `vertical` is the full-page left rail; `horizontal` is
 * the compact row the reading pane uses.
 */
export function TransactionTypeTabs({
  editor,
  orientation = "vertical",
}: {
  editor: TransactionEditorState;
  orientation?: "vertical" | "horizontal";
}) {
  const { activeTab, handleTabChange } = editor;

  if (orientation === "horizontal") {
    return (
      <div
        role="tablist"
        aria-label="Transaction type"
        className="flex gap-1 rounded-lg bg-[#f7f8fa] p-1 dark:bg-slate-900"
      >
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            onClick={() => handleTabChange(tab.id)}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-md py-1.5 text-[11px] font-medium transition-all [&_svg]:h-4 [&_svg]:w-4 ${
              activeTab === tab.id
                ? "bg-white text-[var(--color-app-header-teal)] shadow-sm dark:bg-slate-800"
                : "text-[#64748b] hover:text-[#475569] dark:text-slate-500 dark:hover:text-slate-300"
            }`}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </div>
    );
  }

  return (
    <div className="w-16 bg-[#f7f8fa] dark:bg-slate-900 border-r border-[#e2e8f0] dark:border-slate-700 flex flex-col items-center pt-4 gap-1">
      {TABS.map((tab) => (
        <button
          key={tab.id}
          type="button"
          onClick={() => handleTabChange(tab.id)}
          className={`w-14 flex flex-col items-center gap-1 py-2.5 rounded-lg text-[10px] font-medium transition-all ${
            activeTab === tab.id
              ? "bg-white dark:bg-slate-800 text-[var(--color-app-header-teal)] shadow-sm border border-[#e2e8f0] dark:border-slate-600"
              : "text-[#64748b] dark:text-slate-500 hover:text-[#475569] dark:hover:text-slate-300 hover:bg-white/60 dark:hover:bg-slate-800/50"
          }`}
        >
          {tab.icon}
          {tab.label}
        </button>
      ))}
    </div>
  );
}

// ============================================================================
// Entry card
// ============================================================================

/** Header (party, reference, amount, date, type), memo, the active tab's form, and totals. */
export function TransactionEntryCard({ editor }: { editor: TransactionEditorState }) {
  const {
    partyMode,
    activeTab,
    payPartyId,
    setPayPartyId,
    partyOptions,
    setPartyQuery,
    aggregatedPartyTypes,
    transferFromPartyName,
    transferToPartyName,
    referenceNumber,
    setReferenceNumber,
    transferAmount,
    setTransferAmount,
    headerAmount,
    date,
    setDate,
    memo,
    handleMemoChange,
    avatarItems,
    avatarFallbackIcon,
    journalLines,
    flatAccounts,
    updateJournalLine,
    addJournalLine,
    addJournalLineAfter,
    copyJournalLine,
    removeJournalLine,
    journalTotals,
    validationErrors,
    departmentOptions,
    locationOptions,
    typedOverrides,
    handleCreateCategoryFromQuery,
    setCatSugQuery,
    catSuggestions,
    handleCreateCategorySuggestion,
    handleJournalPartyNameChange,
    payCategoryId,
    setPayCategoryId,
    payForLines,
    updatePayForLine,
    addPayForLine,
    removePayForLine,
    copyPayForLine,
    addPayForLineAfter,
    payForTotal,
    transferFromParty,
    transferFromCategory,
    transferToParty,
    transferToCategory,
    setTransferFromParty,
    setTransferFromCategory,
    setTransferToParty,
    setTransferToCategory,
    setTransferFromPartyName,
    setTransferToPartyName,
  } = editor;
  // One party for the whole entry (the Inbox) vs. the page's per-tab party pickers.
  const headerParty = partyMode === "header";

  return (
    <div className="flex-1 bg-[var(--color-app-card)] dark:bg-[#1e293b] rounded-2xl shadow-[0_4px_24px_rgba(0,0,0,0.08)] flex flex-col overflow-hidden">
      {/* Card header — green gradient matching entity page */}
      <div className="relative px-6 pt-6 pb-12 flex flex-wrap items-start gap-5 transition-colors duration-300 bg-gradient-to-r from-[#1a6b3c] to-[#27ae60] dark:from-[#145a30] dark:to-[#1e8c4c] text-white shrink-0">
        {/* Left Column: Avatar + Title/Party + Ref */}
        <div className="flex items-center gap-5 flex-1 min-w-[280px]">
          {/* Circle avatar — dynamic multi-avatar based on selected parties */}
          <MultiAvatar items={avatarItems} fallbackIcon={avatarFallbackIcon} />

          <div className="flex flex-col gap-1 min-w-0">
            {/* Party selector or Title */}
            <div className="relative">
              {headerParty || (activeTab !== "transfer" && activeTab !== "journal") ? (
                <Combobox
                  value={payPartyId}
                  onChange={setPayPartyId}
                  options={partyOptions}
                  placeholder="Select Party"
                  placeholderIcon={PARTY_ICON}
                  searchPlaceholder="Find party..."
                  onSearch={setPartyQuery}
                  className="[&>button]:bg-black/20 [&>button]:border-transparent [&>button]:text-white [&>button]:text-xs [&>button]:font-medium [&>button]:hover:bg-black/30 [&>button]:py-0 [&>button]:px-2 [&>button]:rounded-md [&>button]:h-[36px] [&>button]:min-h-0 w-[200px]"
                  onCreate={
                    aggregatedPartyTypes
                      ? async (name: string) => {
                          const partyType = aggregatedPartyTypes[0];
                          if (!partyType) return;
                          const newParty = await callServerFn(createParty, {
                            data: { name, partyType },
                          });
                          if (newParty?.id) {
                            setPayPartyId(newParty.id);
                            setPartyQuery("");
                          }
                        }
                      : undefined
                  }
                  createLabel={aggregatedPartyTypes ? aggregatedPartyTypes.join(" or ") : undefined}
                />
              ) : (
                <h1 className="text-2xl font-bold text-white">
                  {activeTab === "transfer"
                    ? transferFromPartyName && transferToPartyName
                      ? `${transferFromPartyName} → ${transferToPartyName}`
                      : transferFromPartyName
                        ? `${transferFromPartyName} → ...`
                        : transferToPartyName
                          ? `... → ${transferToPartyName}`
                          : "Transfer"
                    : "Journal"}
                </h1>
              )}
            </div>

            {/* Reference Number */}
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={referenceNumber}
                onChange={(e) => setReferenceNumber(e.target.value)}
                placeholder="Reference Number"
                className="text-base sm:text-xs min-h-11 lg:min-h-0 px-2 rounded-md transition-colors focus:outline-none bg-black/20 text-white placeholder-white/50 focus:bg-black/30"
                style={{ width: "200px", height: "36px" }}
              />
            </div>
          </div>
        </div>

        {/* Right Column: Amount + Date + Type Pill */}
        <div className="text-right flex flex-col items-end gap-1 ml-auto">
          {/* Amount */}
          {activeTab === "transfer" ? (
            <div className="flex items-center justify-end gap-1 border border-white/20 rounded-lg px-3 py-1.5 bg-white/10 focus-within:border-white/40 focus-within:ring-1 focus-within:ring-white/30 transition-colors">
              <span className="text-xl font-semibold text-white/60">$</span>
              <input
                type="number"
                step="0.01"
                value={transferAmount}
                onChange={(e) => setTransferAmount(e.target.value)}
                placeholder="0.00"
                className="w-28 text-right text-xl font-semibold text-white tabular-nums bg-transparent border-none outline-none placeholder-white/40 focus:ring-0 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
              />
            </div>
          ) : (
            <p className="text-2xl font-bold tabular-nums text-white">
              {formatCurrency(headerAmount)}
            </p>
          )}

          {/* Date */}
          <div className="flex items-center gap-2 justify-end mt-1">
            <DayPicker value={date} onChange={setDate} variant="header" />
          </div>

          {/* Type Pill — static translucent label */}
          <div className="mt-4">
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-semibold shadow-sm bg-black/20 text-white backdrop-blur-md">
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                dangerouslySetInnerHTML={{
                  __html:
                    activeTab === "transfer"
                      ? ICON_PATHS.ArrowSwitch
                      : activeTab === "pay_in"
                        ? ICON_PATHS.CoinsHand
                        : activeTab === "pay_out"
                          ? ICON_PATHS.CoinsHand02
                          : ICON_PATHS.Journal,
                }}
              />
              {TYPE_LABELS[activeTab] || activeTab}
            </div>
          </div>
        </div>
      </div>

      {/* Memo — overlap card pattern matching edit page */}
      <div className="px-6 relative z-10 -mt-12">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-white mb-2 pl-1">
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
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
          </svg>
          Memo
        </div>
        {/* Memo Overlap Card */}
        <div className="bg-white dark:bg-slate-800 rounded-xl shadow-sm border border-[#e2e8f0] dark:border-slate-700 p-4 min-h-16">
          <textarea
            value={memo}
            onChange={(e) => handleMemoChange(e.target.value)}
            onInput={(e) => {
              const el = e.currentTarget;
              el.style.height = "auto";
              el.style.height = `${Math.min(el.scrollHeight, 96)}px`;
            }}
            placeholder="Add a memo..."
            rows={1}
            className="w-full text-base sm:text-sm text-[#1e293b] dark:text-slate-200 placeholder-[#cbd5e1] dark:placeholder-slate-500 focus:outline-none focus:border-b focus:border-[var(--color-app-header-teal)] pb-1 resize-none overflow-y-auto bg-transparent"
            style={{ maxHeight: 96 }}
          />
        </div>
      </div>

      {/* ── Tab-specific content (scrollable) ── */}
      <div className="px-6 py-4 pb-12 flex-1 overflow-y-auto bg-[#f8f9fb] dark:bg-slate-950/40">
        {activeTab === "journal" && (
          <JournalForm
            lines={journalLines}
            accounts={flatAccounts}
            onUpdateLine={updateJournalLine}
            onAddLine={addJournalLine}
            onAddLineAfter={addJournalLineAfter}
            onCopyLine={copyJournalLine}
            onRemoveLine={removeJournalLine}
            totals={journalTotals}
            validationErrors={validationErrors}
            departmentOptions={departmentOptions}
            locationOptions={locationOptions}
            listPartiesFn={listParties}
            createPartyFn={createParty}
            partyOverrides={typedOverrides}
            onCreateCategory={(lineKey, query) =>
              handleCreateCategoryFromQuery(`journal-${lineKey}`)(query)
            }
            onCategorySugQuery={setCatSugQuery}
            categorySuggestions={catSuggestions}
            onCreateCategorySuggestion={(lineKey, item) =>
              handleCreateCategorySuggestion(`journal-${lineKey}`)(item)
            }
            onPartyNameChange={handleJournalPartyNameChange}
            showLineParty={!headerParty}
          />
        )}

        {(activeTab === "pay_in" || activeTab === "pay_out") && (
          <PayForm
            type={activeTab}
            categoryId={payCategoryId}
            onCategoryChange={setPayCategoryId}
            lines={payForLines}
            accounts={flatAccounts}
            onUpdateLine={updatePayForLine}
            onAddLine={addPayForLine}
            onRemoveLine={removePayForLine}
            onCopyLine={copyPayForLine}
            onAddLineAfter={addPayForLineAfter}
            total={payForTotal}
            partyOptions={partyOptions}
            onPartyQueryChange={setPartyQuery}
            partyId={payPartyId}
            onPartyChange={setPayPartyId}
            departmentOptions={departmentOptions}
            locationOptions={locationOptions}
            validationErrors={validationErrors}
            onCreateCategory={handleCreateCategoryFromQuery("pay")}
            onCategorySugQuery={setCatSugQuery}
            categorySuggestions={catSuggestions}
            onCreateCategorySuggestion={handleCreateCategorySuggestion("pay")}
            onCreateLineCategory={(lineKey, query) =>
              handleCreateCategoryFromQuery(`payline-${lineKey}`)(query)
            }
            onCreateLineCategorySuggestion={(lineKey, item) =>
              handleCreateCategorySuggestion(`payline-${lineKey}`)(item)
            }
          />
        )}

        {activeTab === "transfer" && (
          <TransferForm
            accounts={flatAccounts}
            fromParty={transferFromParty}
            fromCategory={transferFromCategory}
            toParty={transferToParty}
            toCategory={transferToCategory}
            amount={transferAmount}
            onAmountChange={setTransferAmount}
            onFromPartyChange={setTransferFromParty}
            onFromCategoryChange={setTransferFromCategory}
            onToPartyChange={setTransferToParty}
            onToCategoryChange={setTransferToCategory}
            listPartiesFn={listParties}
            createPartyFn={createParty}
            partyOverrides={typedOverrides}
            onCreateFromCategory={handleCreateCategoryFromQuery("transfer-from")}
            onCreateToCategory={handleCreateCategoryFromQuery("transfer-to")}
            onCategorySugQuery={setCatSugQuery}
            categorySuggestions={catSuggestions}
            onCreateFromCategorySuggestion={handleCreateCategorySuggestion("transfer-from")}
            onCreateToCategorySuggestion={handleCreateCategorySuggestion("transfer-to")}
            onFromPartyNameChange={setTransferFromPartyName}
            onToPartyNameChange={setTransferToPartyName}
            showParties={!headerParty}
          />
        )}
      </div>

      {/* Bottom totals bar */}
      {activeTab === "journal" && (
        <div className="px-6 py-3 border-t border-[#e2e8f0] dark:border-slate-700 flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            {journalTotals.balanced ? (
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="#14b8a6"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="20 6 9 17 4 12" />
              </svg>
            ) : (
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="#ef4444"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="12" cy="12" r="10" />
                <line x1="15" y1="9" x2="9" y2="15" />
                <line x1="9" y1="9" x2="15" y2="15" />
              </svg>
            )}
            <span
              className={`text-xs font-medium ${journalTotals.balanced ? "text-[#14b8a6]" : "text-[#ef4444]"}`}
            >
              {formatCurrency(journalTotals.debit)}
            </span>
          </div>
          <div className="flex gap-6 text-xs">
            <div>
              <span className="text-[#94a3b8] dark:text-slate-500">Debit</span>{" "}
              <span className="font-semibold text-[#1e293b] dark:text-white tabular-nums">
                {formatCurrency(journalTotals.debit)}
              </span>
            </div>
            <div>
              <span className="text-[#94a3b8] dark:text-slate-500">Credit</span>{" "}
              <span className="font-semibold text-[#1e293b] dark:text-white tabular-nums">
                {formatCurrency(journalTotals.credit)}
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Create-category modal
// ============================================================================

/** The "new category" modal the category comboboxes open (portal, outside the card). */
export function TransactionCategoryModal({ editor }: { editor: TransactionEditorState }) {
  const {
    categoryModalOpen,
    closeCategoryModal,
    handleCreateCategorySubmit,
    categoryPrefill,
    flatAccounts,
  } = editor;
  return (
    <NewCategoryModal
      open={categoryModalOpen}
      onClose={closeCategoryModal}
      onSubmit={handleCreateCategorySubmit}
      prefill={categoryPrefill}
      parentCategories={flatAccounts
        .filter((a) => !a.parentId)
        .map((a) => ({ id: a.id, name: a.name, accountNumber: a.accountNumber ?? undefined }))}
    />
  );
}
