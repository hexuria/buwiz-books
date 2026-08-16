import { useState, useMemo } from "react";
import Combobox, { ComboboxOption } from "../ui/Combobox";
import { useToast } from "../ui/Toast";
import { formatCurrency } from "../../utils/format";

type ThirdSlot = "department" | "location" | "moveTo" | null;
type BarMode = "default" | "comment";

interface BatchActionBarProps {
  selectedTransactions: Array<{
    id: string;
    totalAmount?: string | number | null | undefined;
    transactionType?: string;
    source?: string;
    partyId?: string | null;
    partyName?: string | null;
    categoryName?: string | null;
    categoryAccountId?: string | null;
    departmentId?: string | null;
    locationId?: string | null;
  }>;
  allParties: Array<{ id: string; name: string }>;
  allCategories: Array<{ id: string; name: string; accountNumber?: string | null }>;
  allDepartments: Array<{ id: string; name: string }>;
  allLocations: Array<{ id: string; name: string }>;
  allMembers?: Array<{ id: string; name: string; email?: string }>;
  onClear: () => void;
  onUpdate: (updates: {
    partyId?: string;
    accountId?: string;
    departmentId?: string;
    locationId?: string;
    comment?: string;
    assigneeId?: string;
  }) => void;
  onDelete: () => void;
  onMatch?: (transactionIds: [string, string]) => void;
}

export default function BatchActionBar({
  selectedTransactions,
  allParties,
  allCategories,
  allDepartments,
  allLocations,
  allMembers = [],
  onClear,
  onUpdate,
  onDelete,
  onMatch,
}: BatchActionBarProps) {
  const count = selectedTransactions.length;
  const { showToast } = useToast();

  // Total Amount deduplicates by base transaction ID to avoid overcounting split lines
  const totalAmount = useMemo(() => {
    const seen = new Set<string>();
    let sum = 0;
    for (const t of selectedTransactions) {
      const baseId = t.id.length > 36 ? t.id.substring(0, 36) : t.id;
      if (!seen.has(baseId)) {
        seen.add(baseId);
        sum += Number(t.totalAmount || 0);
      }
    }
    return sum;
  }, [selectedTransactions]);

  // --- Bar mode: default pickers vs comment input ---
  const [barMode, setBarMode] = useState<BarMode>("default");

  // --- Dynamic third picker slot ---
  const [activeThirdSlot, setActiveThirdSlot] = useState<ThirdSlot>(null);

  const toggleThirdSlot = (slot: ThirdSlot) => {
    setActiveThirdSlot((prev) => (prev === slot ? null : slot));
  };

  // --- Compute preloaded values from selected transactions ---
  const preloaded = useMemo(() => {
    const uniqueParties = new Set(selectedTransactions.map((t) => t.partyId).filter(Boolean));
    const uniqueCategories = new Set(
      selectedTransactions.map((t) => t.categoryAccountId).filter(Boolean),
    );
    const uniqueDepts = new Set(selectedTransactions.map((t) => t.departmentId).filter(Boolean));
    const uniqueLocations = new Set(selectedTransactions.map((t) => t.locationId).filter(Boolean));

    // Find a common party name for the comment prompt
    const firstPartyName = selectedTransactions[0]?.partyName ?? "this transaction";

    return {
      partyId: uniqueParties.size === 1 ? [...uniqueParties][0] : undefined,
      partyIsMultiple: uniqueParties.size > 1,
      categoryAccountId: uniqueCategories.size === 1 ? [...uniqueCategories][0] : undefined,
      categoryIsMultiple: uniqueCategories.size > 1,
      departmentId: uniqueDepts.size === 1 ? [...uniqueDepts][0] : undefined,
      departmentIsMultiple: uniqueDepts.size > 1,
      locationId: uniqueLocations.size === 1 ? [...uniqueLocations][0] : undefined,
      locationIsMultiple: uniqueLocations.size > 1,
      commonPartyName: uniqueParties.size === 1 ? firstPartyName : "these transactions",
    };
  }, [selectedTransactions]);

  // User overrides — only tracks fields the user explicitly changed
  const [updates, setUpdates] = useState<{
    partyId?: string;
    accountId?: string;
    moveToAccountId?: string;
    departmentId?: string;
    locationId?: string;
  }>({});

  // --- Comment mode state ---
  const [commentText, setCommentText] = useState("");
  const [assigneeId, setAssigneeId] = useState<string>("");

  // Effective value = user override → preloaded shared value → undefined
  const effectiveParty = updates.partyId ?? preloaded.partyId;
  const effectiveCategory = updates.accountId ?? preloaded.categoryAccountId;
  const effectiveMoveTo = updates.moveToAccountId;
  const effectiveDept = updates.departmentId ?? preloaded.departmentId;
  const effectiveLocation = updates.locationId ?? preloaded.locationId;

  // Show "Multiple" label when values differ and user hasn't overridden
  const partyDisplay = !updates.partyId && preloaded.partyIsMultiple ? "Multiple" : undefined;
  const categoryDisplay =
    !updates.accountId && preloaded.categoryIsMultiple ? "Multiple" : undefined;
  const deptDisplay =
    !updates.departmentId && preloaded.departmentIsMultiple ? "Multiple" : undefined;
  const locationDisplay =
    !updates.locationId && preloaded.locationIsMultiple ? "Multiple" : undefined;

  // --- Options ---
  const partyOptions: ComboboxOption[] = useMemo(
    () => allParties.map((p) => ({ value: p.id, label: p.name })),
    [allParties],
  );

  const categoryOptions: ComboboxOption[] = useMemo(
    () =>
      allCategories.map((c) => ({
        value: c.id,
        label: c.accountNumber ? `${c.accountNumber} - ${c.name}` : c.name,
      })),
    [allCategories],
  );

  const deptOptions: ComboboxOption[] = useMemo(
    () => allDepartments.map((d) => ({ value: d.id, label: d.name })),
    [allDepartments],
  );

  const locationOptions: ComboboxOption[] = useMemo(
    () => allLocations.map((l) => ({ value: l.id, label: l.name })),
    [allLocations],
  );

  const memberOptions: ComboboxOption[] = useMemo(
    () =>
      allMembers.map((m) => ({
        value: m.id,
        label: m.name,
      })),
    [allMembers],
  );

  // "Move to" reuses category/account options
  const moveToOptions = categoryOptions;

  // --- Delete Constraints ---
  const systemSources = new Set(["mercury", "stripe", "plaid", "brex", "ramp"]);

  const undeletableTransactions = selectedTransactions.filter(
    (t) => t.source && systemSources.has(t.source.toLowerCase()),
  );

  const canDelete = undeletableTransactions.length === 0;

  const deleteTooltip = !canDelete
    ? `Cannot delete: transactions from ${Array.from(
        new Set(undeletableTransactions.map((t) => t.source)),
      ).join(", ")} are system-generated`
    : "Delete selected transactions";

  // This is only a lightweight UI gate. The server repeats the full fixed-point,
  // currency, period, reconciliation, and domain-ownership preflight under locks.
  const matchEligibility = useMemo(() => {
    if (count !== 2 || !onMatch) return { allowed: false, reason: "" };
    const txA = selectedTransactions[0];
    const txB = selectedTransactions[1];
    if (!txA || !txB) return { allowed: false, reason: "" };

    // Extract base UUIDs — composite IDs are "uuid-accountId"
    const baseA = txA.id.length > 36 ? txA.id.substring(0, 36) : txA.id;
    const baseB = txB.id.length > 36 ? txB.id.substring(0, 36) : txB.id;
    if (baseA === baseB) return { allowed: false, reason: "" };

    if (txA.transactionType !== txB.transactionType) {
      return {
        allowed: false,
        reason: "Only transactions with the same direction and type can be duplicate-merged",
      };
    }
    if (txA.transactionType === "transfer") {
      return { allowed: false, reason: "Transfers must remain separate accounting events" };
    }

    // Display values are rounded; the server checks exact fixed-point line totals.
    const a = Math.abs(Number(txA.totalAmount ?? 0));
    const b = Math.abs(Number(txB.totalAmount ?? 0));
    if (Math.abs(a - b) >= 0.005) {
      return { allowed: false, reason: "Transaction amounts must match" };
    }

    return { allowed: true, reason: "" };
  }, [count, selectedTransactions, onMatch]);

  const canMatch = matchEligibility.allowed;
  const matchBlockedReason = matchEligibility.reason;

  // Only send fields the user explicitly changed
  const handleApply = () => {
    // Remap moveToAccountId → accountId for the API ("Move To" overrides category)
    const { moveToAccountId, ...rest } = updates;
    const payload: Record<string, string | undefined> = { ...rest };
    if (moveToAccountId) payload.accountId = moveToAccountId;
    onUpdate(payload);
  };

  // Handle comment send
  const handleSendComment = () => {
    onUpdate({
      comment: commentText,
      assigneeId: assigneeId || undefined,
    });
    showToast(`${count} message${count !== 1 ? "s" : ""} sent`, { icon: "send" });
    setCommentText("");
    setAssigneeId("");
    setBarMode("default");
  };

  // --- Third slot config ---
  const thirdSlotConfig: Record<
    Exclude<ThirdSlot, null>,
    {
      label: string;
      options: ComboboxOption[];
      value: string | undefined;
      displayValue: string | undefined;
      placeholder: string;
      searchPlaceholder: string;
      updateKey: "departmentId" | "locationId" | "moveToAccountId";
    }
  > = {
    department: {
      label: "Department",
      options: deptOptions,
      value: effectiveDept ?? undefined,
      displayValue: deptDisplay,
      placeholder: "No Department",
      searchPlaceholder: "Find department...",
      updateKey: "departmentId",
    },
    location: {
      label: "Location",
      options: locationOptions,
      value: effectiveLocation ?? undefined,
      displayValue: locationDisplay,
      placeholder: "No Location",
      searchPlaceholder: "Find location...",
      updateKey: "locationId",
    },
    moveTo: {
      label: "Move to",
      options: moveToOptions,
      value: effectiveMoveTo,
      displayValue: undefined,
      placeholder: "Select account...",
      searchPlaceholder: "Select or Create New",
      updateKey: "moveToAccountId",
    },
  };

  const activeConfig = activeThirdSlot ? thirdSlotConfig[activeThirdSlot] : null;

  // Icon button styling — theme-aware
  const iconBtnClass = (slot: ThirdSlot) =>
    `p-1.5 rounded-md transition-colors ${
      activeThirdSlot === slot
        ? "text-[#14b8a6] dark:text-[#2dd4bf] bg-teal-50 dark:bg-slate-600/50"
        : "text-[#94a3b8] hover:text-[#475569] dark:text-slate-400 dark:hover:text-white hover:bg-[#f1f5f9] dark:hover:bg-slate-600"
    }`;

  // ═══════════════════════════════════
  // COMMENT MODE — replaces entire bar
  // ═══════════════════════════════════
  if (barMode === "comment") {
    const promptParty = preloaded.commonPartyName;

    return (
      <div className="fixed top-0 inset-x-0 z-[100] border-b border-[#e5e7eb] dark:border-slate-700 bg-white dark:bg-slate-800 shadow-lg">
        {/* Desktop: single row */}
        <div className="hidden md:flex items-center gap-2 px-5 py-3">
          {/* Close */}
          <button
            type="button"
            onClick={() => setBarMode("default")}
            className="w-8 h-8 touch-target flex items-center justify-center rounded-full bg-red-50 dark:bg-red-900/30 hover:bg-red-100 dark:hover:bg-red-900/50 transition-colors shrink-0"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              className="text-red-500 dark:text-red-400"
            >
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
          {/* Sparkle + Message Input */}
          <div className="flex items-center gap-2 flex-2 min-w-0">
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              className="text-[#14b8a6] dark:text-[#2dd4bf] shrink-0"
            >
              <path
                d="M12 2l2.09 6.26L20 10l-5.91 1.74L12 18l-2.09-6.26L4 10l5.91-1.74L12 2z"
                fill="currentColor"
              />
              <path
                d="M19 15l1.04 3.13L23 19l-2.96.87L19 23l-1.04-3.13L15 19l2.96-.87L19 15z"
                fill="currentColor"
                opacity="0.7"
              />
            </svg>
            <input
              type="text"
              value={commentText}
              onChange={(e) => setCommentText(e.target.value)}
              placeholder={`What is this ${promptParty} transaction for?`}
              className="flex-1 bg-[#14b8a6]/8 dark:bg-[#2dd4bf]/10 border border-[#14b8a6]/25 dark:border-[#2dd4bf]/25 rounded-md px-3 py-1.5 text-base sm:text-[13px] text-[#1e293b] dark:text-white placeholder-[#94a3b8] dark:placeholder-slate-500 focus:outline-none focus:border-[#14b8a6]/50 dark:focus:border-[#2dd4bf]/50 transition-colors"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter" && commentText.trim()) handleSendComment();
              }}
            />
          </div>
          {/* Assign to */}
          <div className="flex-1 flex items-center gap-2">
            <span className="text-[12px] text-[#64748b] dark:text-slate-400 whitespace-nowrap">
              Assign to
            </span>
            <div className="flex-1">
              <Combobox
                options={memberOptions}
                value={assigneeId}
                onChange={(val) => setAssigneeId(val)}
                placeholder="Select member..."
                searchPlaceholder="Find assignee..."
              />
            </div>
          </div>
          {/* Send button */}
          <button
            type="button"
            onClick={handleSendComment}
            disabled={!commentText.trim()}
            className={`px-4 py-1.5 text-[13px] font-semibold rounded-full transition-all flex items-center gap-1.5 shrink-0 whitespace-nowrap ${
              commentText.trim()
                ? "bg-[#14b8a6] hover:bg-[#0d9488] dark:bg-[#2dd4bf] dark:hover:bg-[#248f82] text-white shadow-sm"
                : "bg-[#f1f5f9] dark:bg-slate-700 text-[#cbd5e1] dark:text-slate-500 cursor-not-allowed"
            }`}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" className="shrink-0">
              <path
                d="M12 2l2.09 6.26L20 10l-5.91 1.74L12 18l-2.09-6.26L4 10l5.91-1.74L12 2z"
                fill="currentColor"
              />
            </svg>
            Send {count} Message{count !== 1 ? "s" : ""}
          </button>
        </div>

        {/* Mobile: two rows */}
        <div className="flex flex-col gap-2.5 px-4 py-3 md:hidden">
          {/* Row 1: Sparkle + full-width input */}
          <div className="flex items-center gap-2">
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              className="text-[#14b8a6] dark:text-[#2dd4bf] shrink-0"
            >
              <path
                d="M12 2l2.09 6.26L20 10l-5.91 1.74L12 18l-2.09-6.26L4 10l5.91-1.74L12 2z"
                fill="currentColor"
              />
              <path
                d="M19 15l1.04 3.13L23 19l-2.96.87L19 23l-1.04-3.13L15 19l2.96-.87L19 15z"
                fill="currentColor"
                opacity="0.7"
              />
            </svg>
            <input
              type="text"
              value={commentText}
              onChange={(e) => setCommentText(e.target.value)}
              placeholder={`What is this ${promptParty} transaction for?`}
              className="flex-1 bg-[#14b8a6]/8 dark:bg-[#2dd4bf]/10 border border-[#14b8a6]/25 dark:border-[#2dd4bf]/25 rounded-md px-3 py-1.5 text-base sm:text-[13px] text-[#1e293b] dark:text-white placeholder-[#94a3b8] dark:placeholder-slate-500 focus:outline-none focus:border-[#14b8a6]/50 dark:focus:border-[#2dd4bf]/50 transition-colors"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter" && commentText.trim()) handleSendComment();
              }}
            />
            {/* Close */}
            <button
              type="button"
              onClick={() => setBarMode("default")}
              className="w-8 h-8 touch-target flex items-center justify-center rounded-full bg-red-50 dark:bg-red-900/30 hover:bg-red-100 dark:hover:bg-red-900/50 transition-colors shrink-0"
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                className="text-red-500 dark:text-red-400"
              >
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
          {/* Row 2: Assign to + Send */}
          <div className="flex items-center gap-2">
            <span className="text-[12px] text-[#64748b] dark:text-slate-400 whitespace-nowrap shrink-0">
              Assign to
            </span>
            <div className="flex-1 min-w-0">
              <Combobox
                options={memberOptions}
                value={assigneeId}
                onChange={(val) => setAssigneeId(val)}
                placeholder="Select member..."
                searchPlaceholder="Find assignee..."
              />
            </div>
            {/* Send */}
            <button
              type="button"
              onClick={handleSendComment}
              disabled={!commentText.trim()}
              className={`px-3 py-1.5 text-[13px] font-semibold rounded-full transition-all flex items-center gap-1.5 shrink-0 whitespace-nowrap ${
                commentText.trim()
                  ? "bg-[#14b8a6] hover:bg-[#0d9488] dark:bg-[#2dd4bf] dark:hover:bg-[#248f82] text-white shadow-sm"
                  : "bg-[#f1f5f9] dark:bg-slate-700 text-[#cbd5e1] dark:text-slate-500 cursor-not-allowed"
              }`}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" className="shrink-0">
                <path
                  d="M12 2l2.09 6.26L20 10l-5.91 1.74L12 18l-2.09-6.26L4 10l5.91-1.74L12 2z"
                  fill="currentColor"
                />
              </svg>
              Send {count} Message{count !== 1 ? "s" : ""}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ═══════════════════════════════════
  // DEFAULT MODE — pickers + actions
  // ═══════════════════════════════════

  /* ── Shared UI fragments ── */

  const closeBtn = (
    <button
      type="button"
      onClick={onClear}
      className="w-7 h-7 touch-target flex items-center justify-center rounded-full bg-red-50 dark:bg-red-900/30 hover:bg-red-100 dark:hover:bg-red-900/50 transition-colors shrink-0"
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        className="text-red-500 dark:text-red-400"
      >
        <path d="M18 6L6 18M6 6l12 12" />
      </svg>
    </button>
  );

  const countLabel = (
    <span
      data-testid="batch-count"
      className="text-[13px] font-semibold text-[#1e293b] dark:text-white whitespace-nowrap"
    >
      {count} selected
    </span>
  );

  const actionIcons = (
    <>
      {/* Move To */}
      <button
        type="button"
        className={iconBtnClass("moveTo")}
        title="Move to Account"
        data-testid="batch-move-to"
        onClick={() => toggleThirdSlot("moveTo")}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
        </svg>
      </button>
      {/* Comment */}
      <button
        type="button"
        className="p-1.5 rounded-md text-[#94a3b8] hover:text-[#475569] dark:text-slate-400 dark:hover:text-white hover:bg-[#f1f5f9] dark:hover:bg-slate-600 transition-colors"
        title="Comment on these transactions"
        data-testid="batch-comment"
        onClick={() => setBarMode("comment")}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      </button>
      {/* Department */}
      <button
        type="button"
        className={iconBtnClass("department")}
        title="Set Department"
        data-testid="batch-set-dept"
        onClick={() => toggleThirdSlot("department")}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M4 18v-.2c0-1.68 0-2.52.327-3.162a3 3 0 0 1 1.311-1.311C6.28 13 7.12 13 8.8 13h6.4c1.68 0 2.52 0 3.162.327a3 3 0 0 1 1.311 1.311C20 15.28 20 16.12 20 17.8v.2M4 18a2 2 0 1 0 0 4 2 2 0 0 0 0-4m16 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4m-8 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4m0 0V8M6 8h12c.932 0 1.398 0 1.765-.152a2 2 0 0 0 1.083-1.083C21 6.398 21 5.932 21 5s0-1.398-.152-1.765a2 2 0 0 0-1.083-1.083C19.398 2 18.932 2 18 2H6c-.932 0-1.398 0-1.765.152a2 2 0 0 0-1.083 1.083C3 3.602 3 4.068 3 5s0 1.398.152 1.765a2 2 0 0 0 1.083 1.083C4.602 8 5.068 8 6 8" />
        </svg>
      </button>
      {/* Location */}
      <button
        type="button"
        className={iconBtnClass("location")}
        title="Set Location"
        data-testid="batch-set-loc"
        onClick={() => toggleThirdSlot("location")}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
          <circle cx="12" cy="10" r="3" />
        </svg>
      </button>
      {/* Duplicate merge — only authorized roles receive onMatch. */}
      {(canMatch || matchBlockedReason) && (
        <div className="relative group">
          <button
            type="button"
            className={`p-1.5 rounded-md transition-colors ${
              canMatch
                ? "text-[#94a3b8] hover:text-emerald-600 dark:text-slate-400 dark:hover:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-900/30"
                : "text-[#94a3b8]/40 dark:text-slate-600 cursor-not-allowed"
            }`}
            title={matchBlockedReason || "Match these 2 transactions"}
            data-testid="batch-match"
            disabled={!canMatch}
            onClick={() =>
              canMatch &&
              onMatch?.([selectedTransactions[0].id, selectedTransactions[1].id] as [
                string,
                string,
              ])
            }
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
              <path d="m2 14.5 9.642 4.821c.131.066.197.098.266.111q.091.018.184 0c.069-.013.135-.045.266-.11L22 14.5m-20-5 9.642-4.821c.131-.066.197-.099.266-.111a.5.5 0 0 1 .184 0c.069.012.135.045.266.11L22 9.5l-9.642 4.821c-.131.066-.197.098-.266.111a.5.5 0 0 1-.184 0c-.069-.013-.135-.045-.266-.11z" />
            </svg>
          </button>
          {matchBlockedReason && (
            <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-3 py-2 text-[11px] leading-snug text-white bg-[#1f2937] rounded-lg w-56 text-center opacity-0 pointer-events-none group-hover:opacity-100 transition-opacity z-50 font-medium">
              Matching not available
              <div className="text-[10px] font-normal text-white/70 mt-0.5">
                {matchBlockedReason}
              </div>
              <div className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-[#1f2937]" />
            </div>
          )}
        </div>
      )}
      <div className="h-4 w-px bg-[#e2e8f0] dark:bg-slate-600 mx-0.5" />
      {/* Delete */}
      <div className="relative group">
        <button
          type="button"
          onClick={canDelete ? onDelete : undefined}
          disabled={!canDelete}
          data-testid="batch-delete"
          className={`p-1.5 rounded-md transition-colors ${
            canDelete
              ? "text-[#94a3b8] hover:text-red-500 dark:text-slate-400 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30"
              : "text-[#cbd5e1] dark:text-slate-600 cursor-not-allowed"
          }`}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="M3 6h18" />
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
          </svg>
        </button>
        {!canDelete && (
          <div className="absolute top-full right-0 mt-2 w-64 p-2 bg-[#1e293b] text-white text-xs rounded shadow-lg opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-50">
            {deleteTooltip}
          </div>
        )}
      </div>
    </>
  );

  const totalDisplay = (
    <div className="text-[13px] font-medium text-[#64748b] dark:text-slate-300 whitespace-nowrap">
      Total:{" "}
      <span className="text-[#1e293b] dark:text-white tabular-nums">
        {formatCurrency(totalAmount)}
      </span>
    </div>
  );

  const applyBtn = (
    <button
      type="button"
      onClick={handleApply}
      disabled={Object.keys(updates).length === 0}
      data-testid="batch-apply"
      className={`px-4 py-1.5 text-[13px] font-semibold rounded-full transition-all whitespace-nowrap ${
        Object.keys(updates).length > 0
          ? "bg-[#14b8a6] hover:bg-[#0d9488] dark:bg-[#2dd4bf] dark:hover:bg-[#248f82] text-white shadow-sm"
          : "bg-[#f1f5f9] dark:bg-slate-700 text-[#cbd5e1] dark:text-slate-500 cursor-not-allowed"
      }`}
    >
      Apply to {count}
    </button>
  );

  const labelClass =
    "text-[10px] text-[#94a3b8] dark:text-slate-400 font-medium tracking-wide uppercase shrink-0";

  /* ── Extracted form fields for reuse across layouts ── */
  const formFields = (
    <>
      {/* Party */}
      <div className="flex-1 min-w-[120px] flex items-center gap-1.5">
        <span className={labelClass}>Party</span>
        <div className="flex-1">
          <Combobox
            options={partyOptions}
            value={effectiveParty ?? undefined}
            displayValue={partyDisplay}
            onChange={(val) => setUpdates((prev) => ({ ...prev, partyId: val }))}
            placeholder="No Party"
            searchPlaceholder="Find party..."
          />
        </div>
      </div>
      {/* Category */}
      <div className="flex-1 min-w-[120px] flex items-center gap-1.5">
        <span className={labelClass}>Category</span>
        <div className="flex-1">
          <Combobox
            options={categoryOptions}
            value={effectiveCategory ?? ""}
            displayValue={categoryDisplay}
            onChange={(val) => setUpdates((prev) => ({ ...prev, accountId: val }))}
            placeholder="No Category"
            searchPlaceholder="Find category..."
          />
        </div>
      </div>
      {/* Dynamic third slot */}
      {activeConfig && (
        <div className="flex-1 min-w-[120px] flex items-center gap-1.5">
          <span className={labelClass}>{activeConfig.label}</span>
          <div className="flex-1">
            <Combobox
              options={activeConfig.options}
              value={activeConfig.value}
              displayValue={activeConfig.displayValue}
              onChange={(val) => setUpdates((prev) => ({ ...prev, [activeConfig.updateKey]: val }))}
              placeholder={activeConfig.placeholder}
              searchPlaceholder={activeConfig.searchPlaceholder}
            />
          </div>
        </div>
      )}
    </>
  );

  return (
    <div
      data-testid="batch-bar"
      className="fixed top-0 inset-x-0 z-[100] border-b border-[#e5e7eb] dark:border-slate-700 bg-white dark:bg-slate-800 shadow-lg"
    >
      {/* ── Desktop: two rows (≥768px) ── */}
      <div className="hidden md:block">
        {/* Row 1: close, count, actions, total, apply */}
        <div className="flex items-center gap-3 px-5 py-2.5">
          <div className="flex items-center gap-2 shrink-0">
            {closeBtn}
            {countLabel}
          </div>
          <div className="flex items-center gap-0.5">{actionIcons}</div>
          <div className="flex-1" />
          <div className="h-5 w-px bg-[#e2e8f0] dark:bg-slate-600 shrink-0" />
          <div className="flex items-center gap-3 shrink-0">
            {totalDisplay}
            {applyBtn}
          </div>
        </div>
        {/* Row 2: form fields */}
        <div className="flex items-center gap-3 px-5 pb-2.5 pt-2 border-t border-[#f1f5f9] dark:border-slate-700">
          {formFields}
        </div>
      </div>

      {/* ── Mobile: stacked rows (<768px) ── */}
      <div className="flex flex-col gap-2.5 px-4 py-3 md:hidden">
        {/* Row 1: ✕ N selected ─── action icons */}
        <div className="flex items-center gap-2">
          {closeBtn}
          {countLabel}
          <div className="flex-1" />
          <div className="flex items-center gap-0.5">{actionIcons}</div>
        </div>

        {/* Row 2: Total + Apply */}
        <div className="flex items-center justify-between border-t border-[#f1f5f9] dark:border-slate-700 pt-2">
          {totalDisplay}
          {applyBtn}
        </div>

        {/* Row 3: Party picker (full width) */}
        <div className="flex items-center gap-2">
          <span className={`${labelClass} w-16`}>Party</span>
          <div className="flex-1">
            <Combobox
              options={partyOptions}
              value={effectiveParty ?? undefined}
              displayValue={partyDisplay}
              onChange={(val) => setUpdates((prev) => ({ ...prev, partyId: val }))}
              placeholder="No Party"
              searchPlaceholder="Find party..."
            />
          </div>
        </div>

        {/* Row 4: Category (full width) */}
        <div className="flex items-center gap-2">
          <span className={`${labelClass} w-16`}>Category</span>
          <div className="flex-1">
            <Combobox
              options={categoryOptions}
              value={effectiveCategory ?? ""}
              displayValue={categoryDisplay}
              onChange={(val) => setUpdates((prev) => ({ ...prev, accountId: val }))}
              placeholder="No Category"
              searchPlaceholder="Find category..."
            />
          </div>
        </div>

        {/* Row 5: Dynamic third slot (full width) */}
        {activeConfig && (
          <div className="flex items-center gap-2">
            <span className={`${labelClass} w-16`}>{activeConfig.label}</span>
            <div className="flex-1">
              <Combobox
                options={activeConfig.options}
                value={activeConfig.value}
                displayValue={activeConfig.displayValue}
                onChange={(val) =>
                  setUpdates((prev) => ({ ...prev, [activeConfig.updateKey]: val }))
                }
                placeholder={activeConfig.placeholder}
                searchPlaceholder={activeConfig.searchPlaceholder}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
