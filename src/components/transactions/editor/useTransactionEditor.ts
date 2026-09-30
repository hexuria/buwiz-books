/**
 * useTransactionEditor — the New transaction editor's state and behavior, moved out of
 * /transactions/new so the Inbox reading pane runs the same code.
 *
 * Holds every tab's fields, the data they need (accounts, parties, departments, locations,
 * category suggestions), tab conversion, validation, and the create-category flow. It never
 * saves: callers read `getDraft()` after `validate()` and decide what a save means.
 *
 * Party placement differs by caller. /transactions/new keeps its per-tab parties (the Pay header,
 * per-line on Journal, from/to on Transfer). An Inbox candidate has exactly one party, so the
 * `header` mode shows one party picker on every tab and hides the per-line pickers, which the
 * candidate correction could not store.
 */
import { useCallback, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createAccount } from "@/routes/api/-accounts";
import { listParties } from "@/routes/api/-parties";
import { suggestParties, type PartySuggestion } from "@/routes/api/-party-suggestions";
import { listDepartments, listLocations } from "@/routes/api/-dimensions";
import type { ParsedTransactionResult } from "@/routes/api/-ai-transaction-parse";
import { getReadPartyTypes, toPartyApiFilter, type PartyType } from "@/lib/party-scoping";
import suggestedCategories from "@/lib/suggested-categories.json";
import { createLogger } from "@/lib/logger";
import { callServerFn } from "@/lib/server-fn-client";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { useTransactionAccounts } from "@/hooks/useTransactionAccounts";
import type { ComboboxOption, SuggestedItem } from "../../ui/Combobox";
import { useToast } from "../../ui/Toast";
import { ICON_PATHS } from "../../accounts/icons";
import type { CategoryPrefill, NewCategoryData } from "../../accounts/NewCategoryForm";
import type { AvatarItem } from "../shared/MultiAvatar";
import type { JournalLine, PayForLine, TabType } from "../shared/types";
import { createKey, emptyJournalLine, emptyPayForLine } from "../shared/helpers";
import type { TransactionDraft } from "./transaction-draft";

const logger = createLogger("ui.transactions");

type PartyRecord = Awaited<ReturnType<typeof listParties>>[number];
type DimensionRecord = Awaited<ReturnType<typeof listDepartments>>[number];
type SuggestedCategoryData = {
  name: string;
  parentName?: string;
  description?: string;
  accountType?: string;
  subtype?: string;
  keywords?: string[];
};
export type CategoryPrefillState = CategoryPrefill & {
  data?: SuggestedCategoryData;
};

const EMPTY_PARTY_SUGGESTIONS: PartySuggestion[] = [];
const EMPTY_PARTIES: PartyRecord[] = [];
const suggestedCategoryCatalog: SuggestedCategoryData[] = suggestedCategories;

function isCategoryAccountType(value: string | undefined): value is NewCategoryData["accountType"] {
  return [
    "asset",
    "liability",
    "equity",
    "revenue",
    "expense",
    "cost_of_revenue",
    "other_income",
    "other_expense",
  ].includes(value ?? "");
}

// Helper: derive up to 2 initials from a name
function getInitials(name: string): string | null {
  const cleaned = name.replace(/^★\s*/, "").trim();
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  if (words.length === 1) return words[0].charAt(0).toUpperCase();
  return (words[0].charAt(0) + words[1].charAt(0)).toUpperCase();
}

export type TransactionEditorPartyMode = "per_tab" | "header";

export interface UseTransactionEditorOptions {
  initialDraft: TransactionDraft;
  /** `per_tab` (default) is /transactions/new; `header` is one party for any tab. */
  partyMode?: TransactionEditorPartyMode;
  /** Shown for the draft's party before any party search has loaded it. */
  initialPartyOption?: ComboboxOption | null;
}

export function useTransactionEditor({
  initialDraft,
  partyMode = "per_tab",
  initialPartyOption = null,
}: UseTransactionEditorOptions) {
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  // ── Tab state ──
  const [activeTab, setActiveTab] = useState<TabType>(initialDraft.type);

  // ── Shared fields ──
  const [date, setDate] = useState(initialDraft.date);
  const [referenceNumber, setReferenceNumber] = useState(initialDraft.referenceNumber);
  const [memo, setMemo] = useState(initialDraft.memo);

  // ── Validation state ──
  const [validationErrors, setValidationErrors] = useState<Set<string>>(new Set());

  // ── Journal state ──
  const [journalLines, setJournalLines] = useState<JournalLine[]>(initialDraft.journalLines);

  // ── Pay In / Pay Out state ──
  const [payPartyId, setPayPartyId] = useState(initialDraft.payPartyId);
  const [payCategoryId, setPayCategoryId] = useState(initialDraft.payCategoryId);
  const [payForLines, setPayForLines] = useState<PayForLine[]>(initialDraft.payForLines);

  // ── Transfer state ──
  const [transferFromParty, setTransferFromParty] = useState(initialDraft.transferFromParty);
  const [transferFromCategory, setTransferFromCategory] = useState(
    initialDraft.transferFromCategory,
  );
  const [transferToParty, setTransferToParty] = useState(initialDraft.transferToParty);
  const [transferToCategory, setTransferToCategory] = useState(initialDraft.transferToCategory);
  const [transferAmount, setTransferAmount] = useState(initialDraft.transferAmount);
  const [transferFromPartyName, setTransferFromPartyName] = useState("");
  const [transferToPartyName, setTransferToPartyName] = useState("");

  // ── Journal party names (for multi-avatar) ──
  const [journalPartyNames, setJournalPartyNames] = useState<Record<string, string>>({});
  const handleJournalPartyNameChange = useCallback((lineKey: string, name: string) => {
    setJournalPartyNames((prev) => (prev[lineKey] === name ? prev : { ...prev, [lineKey]: name }));
  }, []);

  // ── New Category Modal state ──
  const [categoryModalOpen, setCategoryModalOpen] = useState(false);
  const [categoryPrefill, setCategoryPrefill] = useState<CategoryPrefillState | undefined>();
  /** Which combobox triggered the modal — e.g. "pay", "journal-<key>", "transfer-from", "transfer-to" */
  const [categoryTarget, setCategoryTarget] = useState<string>("");

  // ── Parties ──
  const [partyQuery, setPartyQuery] = useState("");
  const debouncedPartyQuery = useDebouncedValue(partyQuery, 300);
  const [injectedPartyOptions, setInjectedPartyOptions] = useState<ComboboxOption[]>(
    initialPartyOption ? [initialPartyOption] : [],
  );

  // ── Data ──
  const { flatAccounts, typedOverrides } = useTransactionAccounts();

  // Aggregate preferred party types from ALL Pay For line categories
  // e.g. Line 1: SAFEs → shareholder, Line 2: Sales Revenue → customer
  //       → partyTypeFilter = ["shareholder", "customer"]
  // When no categories are picked, partyTypeFilter is null (don't show parties)
  const aggregatedPartyTypes = useMemo((): PartyType[] | null => {
    if (activeTab !== "pay_in" && activeTab !== "pay_out") return null;

    // Collect subtypes from all Pay For lines that have a category selected
    const linesWithCategory = payForLines.filter((l) => l.categoryId);
    if (linesWithCategory.length === 0) return null; // No categories → no parties

    const allTypes = new Set<PartyType>();
    for (const line of linesWithCategory) {
      const acct = flatAccounts.find((a) => a.id === line.categoryId);
      if (!acct) continue;
      // Walk up parent chain to resolve subtype if not directly set
      let subtype = acct.subtype ?? null;
      if (!subtype) {
        let parentAcct = flatAccounts.find((a) => a.id === acct.parentId);
        while (parentAcct && !subtype) {
          subtype = parentAcct.subtype ?? null;
          parentAcct = flatAccounts.find((a) => a.id === parentAcct!.parentId);
        }
      }
      const accountReadTypes = acct.readPartyTypes ?? null;
      const preferred = getReadPartyTypes(subtype, activeTab, typedOverrides, accountReadTypes);
      for (const t of preferred) allTypes.add(t);
    }

    return allTypes.size > 0 ? Array.from(allTypes) : null;
  }, [payForLines, flatAccounts, activeTab, typedOverrides]);

  const partyTypeFilter = useMemo(() => {
    if (!aggregatedPartyTypes) return null; // null = don't fetch at all
    return toPartyApiFilter(aggregatedPartyTypes);
  }, [aggregatedPartyTypes]);

  // Header mode on Journal / Transfer: no category decides a party type, so offer every party.
  const headerPartyForAnyType =
    partyMode === "header" && (activeTab === "journal" || activeTab === "transfer");

  // ── Party suggestions based on Pay For line categories ──
  const payForCategoryIds = useMemo(() => {
    return payForLines.filter((l) => l.categoryId).map((l) => l.categoryId);
  }, [payForLines]);

  const { data: partySuggestions = EMPTY_PARTY_SUGGESTIONS } = useQuery({
    queryKey: ["partySuggestions", payForCategoryIds],
    queryFn: () =>
      payForCategoryIds.length > 0
        ? callServerFn(suggestParties, {
            data: {
              categoryId: payForCategoryIds[0],
              transactionType: activeTab === "transfer" ? undefined : activeTab,
              limit: 5,
            },
          })
        : [],
    enabled: payForCategoryIds.length > 0,
    staleTime: 2 * 60 * 1000,
  });

  // Fetch parties via useQuery instead of useEffect to avoid re-render loops
  const { data: fetchedParties = EMPTY_PARTIES } = useQuery({
    queryKey: ["partySearch", debouncedPartyQuery, headerPartyForAnyType ? "any" : partyTypeFilter],
    queryFn: () =>
      callServerFn(listParties, {
        data: {
          search: debouncedPartyQuery,
          type: headerPartyForAnyType ? undefined : (partyTypeFilter ?? undefined),
          limit: 50,
        },
      }),
    enabled: headerPartyForAnyType || partyTypeFilter !== null,
    staleTime: 30 * 1000,
  });

  // Derive partyOptions from fetched parties + suggestions (no setState = no re-render loop)
  const partyOptions: ComboboxOption[] = useMemo(() => {
    if (partyTypeFilter === null && !headerPartyForAnyType) {
      // Even when party type filter isn't ready, always surface injected AI options
      return injectedPartyOptions.length > 0 ? [...injectedPartyOptions] : [];
    }

    // Filter suggestions by aggregated party types
    const allowedTypes = aggregatedPartyTypes;
    const filteredSuggestions = headerPartyForAnyType
      ? []
      : partySuggestions.filter(
          (s) =>
            (!allowedTypes ||
              allowedTypes.includes(s.partyType) ||
              (s.partyType === "both" &&
                (allowedTypes.includes("vendor") || allowedTypes.includes("customer")))) &&
            (!debouncedPartyQuery ||
              s.name.toLowerCase().includes(debouncedPartyQuery.toLowerCase())),
        );
    const suggestedIds = new Set(filteredSuggestions.map((s) => s.id));
    const suggestedOptions: ComboboxOption[] = filteredSuggestions.map((s) => ({
      value: s.id,
      label: `★ ${s.name}`,
    }));
    const regularOptions: ComboboxOption[] = fetchedParties
      .filter((p) => !suggestedIds.has(p.id))
      .map((p) => ({
        value: p.id,
        label: p.name,
      }));

    // Merge: injected AI options + suggestions + search results
    const merged = [...suggestedOptions, ...regularOptions];
    // Add any injected options (from AI apply) that aren't already present
    for (const opt of injectedPartyOptions) {
      if (!merged.some((m) => m.value === opt.value)) {
        merged.unshift(opt);
      }
    }
    return merged;
  }, [
    partyTypeFilter,
    headerPartyForAnyType,
    aggregatedPartyTypes,
    partySuggestions,
    fetchedParties,
    debouncedPartyQuery,
    injectedPartyOptions,
  ]);

  // Unified avatar items for the header — works across all tabs
  const avatarItems: AvatarItem[] = useMemo(() => {
    if (partyMode === "header" || activeTab === "pay_in" || activeTab === "pay_out") {
      if (!payPartyId) return [];
      const selected = partyOptions.find((p) => p.value === payPartyId);
      if (!selected) return [];
      return [{ initials: getInitials(selected.label) }];
    }
    if (activeTab === "transfer") {
      const items: AvatarItem[] = [];
      if (transferFromPartyName) items.push({ initials: getInitials(transferFromPartyName) });
      if (transferToPartyName) items.push({ initials: getInitials(transferToPartyName) });
      return items;
    }
    if (activeTab === "journal") {
      // Collect unique parties from journal lines
      const seen = new Set<string>();
      const items: AvatarItem[] = [];
      for (const line of journalLines) {
        if (!line.partyId || seen.has(line.partyId)) continue;
        seen.add(line.partyId);
        const name = journalPartyNames[line.key];
        items.push({ initials: name ? getInitials(name) : null });
      }
      return items;
    }
    return [];
  }, [
    partyMode,
    activeTab,
    payPartyId,
    partyOptions,
    transferFromPartyName,
    transferToPartyName,
    journalLines,
    journalPartyNames,
  ]);

  // ── Type conversion logic (canonical journal-line approach) ──
  // Mirrors the edit page's handleTypeChange:
  //   Step 1: Convert current tab state → canonical journal lines
  //   Step 2: Derive target tab state from canonical lines using debit/credit
  //
  // Accounting conventions:
  //   Pay Out  → Category = CREDIT line (source bank), Pay For = DEBIT lines (expenses)
  //   Pay In   → Category = DEBIT line (destination),  Pay For = CREDIT lines (revenue)
  //   Transfer → From = CREDIT line (source),          To = DEBIT line (destination)
  //   Journal  → All lines shown as-is
  const handleTabChange = useCallback(
    (newTab: TabType) => {
      if (newTab === activeTab) return;
      const oldTab = activeTab;

      // ── Step 1: Reconstruct canonical journal lines from current tab state ──
      let canonical: JournalLine[];

      if (oldTab === "journal") {
        canonical = journalLines;
      } else if (oldTab === "pay_in" || oldTab === "pay_out") {
        const isPayIn = oldTab === "pay_in";
        const total = payForLines.reduce((s, l) => s + (Number.parseFloat(l.amount) || 0), 0);
        canonical = [
          {
            key: createKey(),
            description: memo,
            categoryId: payCategoryId,
            partyId: payPartyId,
            departmentId: "",
            locationId: "",
            debit: isPayIn ? String(total) : "",
            credit: isPayIn ? "" : String(total),
          },
          ...payForLines.map((l) => ({
            key: createKey(),
            description: l.description || memo,
            categoryId: l.categoryId,
            partyId: payPartyId,
            departmentId: l.departmentId || "",
            locationId: l.locationId || "",
            debit: isPayIn ? "" : l.amount,
            credit: isPayIn ? l.amount : "",
          })),
        ];
      } else {
        // transfer → canonical
        canonical = [
          {
            key: createKey(),
            description: memo,
            categoryId: transferToCategory,
            partyId: transferToParty || payPartyId,
            departmentId: "",
            locationId: "",
            debit: transferAmount,
            credit: "",
          },
          {
            key: createKey(),
            description: memo,
            categoryId: transferFromCategory,
            partyId: transferFromParty || payPartyId,
            departmentId: "",
            locationId: "",
            debit: "",
            credit: transferAmount,
          },
        ];
      }

      // Sort canonical so debit lines come before credit lines
      canonical.sort((a, b) => {
        const aDebit = Number.parseFloat(a.debit) || 0;
        const bDebit = Number.parseFloat(b.debit) || 0;
        return bDebit - aDebit;
      });

      // Always keep journal lines in sync as the canonical form
      setJournalLines(canonical.length >= 2 ? canonical : [...canonical, emptyJournalLine()]);

      // ── Step 2: Derive target tab state from canonical lines ──
      if (newTab === "journal") {
        // Journal — canonical lines are already set above
      } else if (newTab === "pay_in" || newTab === "pay_out") {
        const isPayIn = newTab === "pay_in";

        // Find category line by debit/credit direction
        const categoryLine = canonical.find((l) =>
          isPayIn
            ? l.debit && Number.parseFloat(l.debit) > 0
            : l.credit && Number.parseFloat(l.credit) > 0,
        );

        // If no category line found (all amounts empty), default to first line
        const effectiveCategoryLine = categoryLine ?? canonical[0];
        const payLines = effectiveCategoryLine
          ? canonical.filter((l) => l !== effectiveCategoryLine)
          : [];

        setPayCategoryId(effectiveCategoryLine?.categoryId || "");

        if (!payPartyId && effectiveCategoryLine?.partyId) {
          setPayPartyId(effectiveCategoryLine.partyId);
        }

        setPayForLines(
          payLines.length > 0
            ? payLines.map((l) => ({
                key: createKey(),
                description: l.description || memo,
                categoryId: l.categoryId,
                departmentId: l.departmentId || "",
                locationId: l.locationId || "",
                amount: isPayIn ? l.credit || l.debit : l.debit || l.credit,
              }))
            : [emptyPayForLine()],
        );
      } else if (newTab === "transfer") {
        const debitLine = canonical.find((l) => l.debit && Number.parseFloat(l.debit) > 0);
        const creditLine = canonical.find((l) => l.credit && Number.parseFloat(l.credit) > 0);

        setTransferFromCategory(creditLine?.categoryId || "");
        setTransferToCategory(debitLine?.categoryId || "");
        setTransferAmount(debitLine?.debit || creditLine?.credit || "");

        if (creditLine?.partyId) setTransferFromParty(creditLine.partyId);
        if (debitLine?.partyId) setTransferToParty(debitLine.partyId);
      }

      setActiveTab(newTab);
    },
    [
      activeTab,
      memo,
      journalLines,
      payCategoryId,
      payPartyId,
      payForLines,
      transferFromCategory,
      transferFromParty,
      transferToCategory,
      transferToParty,
      transferAmount,
    ],
  );
  // Fallback icon for empty avatar
  const avatarFallbackIcon = useMemo(() => {
    switch (activeTab) {
      case "transfer":
        return ICON_PATHS.ArrowSwitch;
      case "pay_in":
        return ICON_PATHS.CoinsHand;
      case "pay_out":
        return ICON_PATHS.CoinsHand02;
      default:
        return ICON_PATHS.Journal;
    }
  }, [activeTab]);

  // ── Departments ──
  const { data: departmentsRaw = [] } = useQuery({
    queryKey: ["departments"],
    queryFn: () => callServerFn(listDepartments, { data: {} }),
    structuralSharing: false,
  });

  const departmentOptions: ComboboxOption[] = useMemo(
    () =>
      departmentsRaw
        .filter((d: DimensionRecord) => d.isActive !== false)
        .map((d: DimensionRecord) => ({ value: d.id, label: d.name })),
    [departmentsRaw],
  );

  // ── Locations ──
  const { data: locationsRaw = [] } = useQuery({
    queryKey: ["locations"],
    queryFn: () => callServerFn(listLocations, { data: {} }),
    structuralSharing: false,
  });

  const locationOptions: ComboboxOption[] = useMemo(
    () =>
      locationsRaw
        .filter((l: DimensionRecord) => l.isActive !== false)
        .map((l: DimensionRecord) => ({ value: l.id, label: l.name })),
    [locationsRaw],
  );

  // ── Category suggestions: fuzzy-match suggested-categories.json against query ──
  const filterCategorySuggestions = useCallback(
    (query: string): SuggestedItem[] => {
      if (!query || query.length < 2) return [];
      const q = query.toLowerCase();
      // Filter out suggestions that already exist in the account tree
      const existingNames = new Set(flatAccounts.map((a) => a.name.toLowerCase()));
      return suggestedCategoryCatalog
        .filter((cat) => {
          if (existingNames.has(cat.name.toLowerCase())) return false;
          if (cat.name.toLowerCase().includes(q)) return true;
          return cat.keywords?.some((kw: string) => kw.toLowerCase().includes(q));
        })
        .slice(0, 5)
        .map((cat) => ({
          label: cat.name,
          sublabel: cat.parentName,
          description: cat.description,
          data: cat,
        }));
    },
    [flatAccounts],
  );

  // Category suggestion state (query → suggestions)
  const [catSugQuery, setCatSugQuery] = useState("");
  const catSuggestions = useMemo(
    () => filterCategorySuggestions(catSugQuery),
    [catSugQuery, filterCategorySuggestions],
  );

  // ── Journal line helpers ──
  const updateJournalLine = useCallback((key: string, field: keyof JournalLine, value: string) => {
    setJournalLines((prev) => {
      const next = prev.map((l) => (l.key === key ? { ...l, [field]: value } : l));
      // Auto-mirror debit/credit for 2-line journals
      if (next.length === 2 && (field === "debit" || field === "credit")) {
        const otherIdx = next[0].key === key ? 1 : 0;
        const mirrorField = field === "debit" ? "credit" : "debit";
        next[otherIdx] = { ...next[otherIdx], [mirrorField]: value };
      }
      return next;
    });
    // Clear validation error when category is set
    if (field === "categoryId" && value) {
      setValidationErrors((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  }, []);

  const addJournalLine = () => setJournalLines((prev) => [...prev, emptyJournalLine()]);

  const addJournalLineAfter = (afterKey: string) => {
    setJournalLines((prev) => {
      const idx = prev.findIndex((l) => l.key === afterKey);
      const next = [...prev];
      next.splice(idx + 1, 0, emptyJournalLine());
      return next;
    });
  };

  const copyJournalLine = (key: string) => {
    setJournalLines((prev) => {
      const idx = prev.findIndex((l) => l.key === key);
      const source = prev[idx];
      const copy: JournalLine = { ...source, key: createKey() };
      const next = [...prev];
      next.splice(idx + 1, 0, copy);
      return next;
    });
  };

  const removeJournalLine = (key: string) => {
    setJournalLines((prev) => {
      const next = prev.filter((l) => l.key !== key);
      return next.length < 2 ? [...next, emptyJournalLine()] : next;
    });
  };

  // ── Pay For line helpers ──
  const updatePayForLine = useCallback((key: string, field: keyof PayForLine, value: string) => {
    setPayForLines((prev) => prev.map((l) => (l.key === key ? { ...l, [field]: value } : l)));
  }, []);

  // ── Category creation handlers (after updateJournalLine / updatePayForLine) ──
  const openCategoryModal = useCallback((target: string, prefill?: CategoryPrefillState) => {
    setCategoryTarget(target);
    setCategoryPrefill(prefill);
    setCategoryModalOpen(true);
  }, []);

  const closeCategoryModal = useCallback(() => {
    setCategoryModalOpen(false);
    setCategoryPrefill(undefined);
  }, []);

  const handleCreateCategorySubmit = useCallback(
    async (data: NewCategoryData) => {
      try {
        let parentId = data.parentId;
        if (!parentId && categoryPrefill?.parentId) {
          parentId = categoryPrefill.parentId;
        }
        if (!parentId && categoryPrefill?.data?.parentName) {
          const parentName = categoryPrefill.data.parentName;
          const parent = flatAccounts.find(
            (a) => a.name.toLowerCase() === parentName.toLowerCase(),
          );
          if (parent) parentId = parent.id;
        }

        const created = await callServerFn(createAccount, {
          data: {
            name: data.name,
            accountNumber: data.accountNumber,
            description: data.description,
            accountType: data.accountType,
            // Only apply the suggestion's subtype if the user did not change
            // the account type in the form. `createAccountSchema` rejects an
            // illegal (type, subtype) pair, and failing the whole submit over a
            // classification hint would be worse than creating it without one.
            subtype:
              categoryPrefill?.data?.accountType === data.accountType
                ? (categoryPrefill?.data?.subtype ?? undefined)
                : undefined,
            parentId,
          },
        });

        await queryClient.invalidateQueries({ queryKey: ["accounts"] });

        if (created?.id) {
          if (categoryTarget === "pay") {
            setPayCategoryId(created.id);
          } else if (categoryTarget.startsWith("journal-")) {
            const lineKey = categoryTarget.replace("journal-", "");
            updateJournalLine(lineKey, "categoryId", created.id);
          } else if (categoryTarget === "transfer-from") {
            setTransferFromCategory(created.id);
          } else if (categoryTarget === "transfer-to") {
            setTransferToCategory(created.id);
          } else if (categoryTarget.startsWith("payline-")) {
            const lineKey = categoryTarget.replace("payline-", "");
            updatePayForLine(lineKey, "categoryId", created.id);
          }
        }

        setCategoryModalOpen(false);
        setCategoryPrefill(undefined);
      } catch (err) {
        // The modal deliberately stays open so the user does not lose their
        // input — but it has to say why. This catch previously logged to the
        // console and nothing else, so a failed create looked like an inert
        // button and a duplicate-name/number failure was invisible.
        logger.error("Failed to create category", { error: err });
        showToast?.(
          err instanceof Error && err.message
            ? `Could not create category: ${err.message}`
            : "Could not create category. Check the name and number are not already in use.",
          { icon: "error" },
        );
      }
    },
    [
      categoryPrefill,
      categoryTarget,
      flatAccounts,
      queryClient,
      updateJournalLine,
      updatePayForLine,
      showToast,
    ],
  );

  const handleCreateCategoryFromQuery = useCallback(
    (target: string) => (query: string) => {
      openCategoryModal(target, { name: query });
    },
    [openCategoryModal],
  );

  const handleCreateCategorySuggestion = useCallback(
    (target: string) => (item: SuggestedItem) => {
      const cat = item.data as SuggestedCategoryData | undefined;
      if (!cat) return;
      openCategoryModal(target, {
        name: cat.name,
        description: cat.description,
        accountType: isCategoryAccountType(cat.accountType) ? cat.accountType : undefined,
        // Carrying the raw row is what makes `parentName` and `subtype` usable
        // at submit time. Without it both were silently dropped, so every
        // account created from a suggestion came out root-level with a NULL
        // subtype — invisible in the cash-flow statement and matching no
        // mapping fallback. No accountNumber: the server derives it from the
        // resolved parent, which is correct for THIS org's chart.
        data: cat,
      });
    },
    [openCategoryModal],
  );

  const addPayForLine = () => setPayForLines((prev) => [...prev, emptyPayForLine()]);

  const addPayForLineAfter = (afterKey: string) => {
    setPayForLines((prev) => {
      const idx = prev.findIndex((l) => l.key === afterKey);
      if (idx === -1) return prev;
      const newLines = [...prev];
      newLines.splice(idx + 1, 0, emptyPayForLine());
      return newLines;
    });
  };

  const copyPayForLine = (key: string) => {
    setPayForLines((prev) => {
      const idx = prev.findIndex((l) => l.key === key);
      if (idx === -1) return prev;
      const newLines = [...prev];
      newLines.splice(idx + 1, 0, { ...prev[idx], key: crypto.randomUUID() });
      return newLines;
    });
  };

  const removePayForLine = (key: string) => {
    setPayForLines((prev) => {
      const next = prev.filter((l) => l.key !== key);
      return next.length < 1 ? [emptyPayForLine()] : next;
    });
  };

  // ── Totals ──
  const journalTotals = useMemo(() => {
    let debit = 0;
    let credit = 0;
    for (const line of journalLines) {
      debit += Number.parseFloat(line.debit) || 0;
      credit += Number.parseFloat(line.credit) || 0;
    }
    return { debit, credit, balanced: Math.abs(debit - credit) < 0.005 };
  }, [journalLines]);

  const payForTotal = useMemo(() => {
    let total = 0;
    for (const line of payForLines) {
      total += Number.parseFloat(line.amount) || 0;
    }
    return total;
  }, [payForLines]);

  // ── Total amount for header ──
  const headerAmount = useMemo(() => {
    if (activeTab === "journal") return journalTotals.debit;
    if (activeTab === "pay_in" || activeTab === "pay_out") return payForTotal;
    if (activeTab === "transfer") return Number.parseFloat(transferAmount) || 0;
    return 0;
  }, [activeTab, journalTotals, payForTotal, transferAmount]);

  // ── Memo change ──
  const handleMemoChange = useCallback((value: string) => {
    setMemo(value);
  }, []);

  // ── Validate before save ──
  const validate = (): boolean => {
    const errors = new Set<string>();
    let errorMessage = "";

    if (activeTab === "journal") {
      // Memo required for journal entries
      if (!memo.trim()) {
        errorMessage = "Please enter a memo describing this journal entry.";
      }
      // Check lines with amounts but no category
      for (const line of journalLines) {
        if ((line.debit || line.credit) && !line.categoryId) {
          errors.add(line.key);
        }
      }
      // Check that at least 2 lines have amounts entered
      const linesWithAmounts = journalLines.filter((l) => l.categoryId && (l.debit || l.credit));
      if (linesWithAmounts.length < 2) {
        errorMessage =
          errorMessage ||
          "At least 2 journal lines with amounts are required. Please enter debit/credit amounts.";
      } else if (!journalTotals.balanced) {
        errorMessage =
          errorMessage ||
          `Debits ($${journalTotals.debit.toFixed(2)}) must equal Credits ($${journalTotals.credit.toFixed(2)})`;
      }
    } else if (activeTab === "pay_in" || activeTab === "pay_out") {
      // Memo required for pay in/out
      if (!memo.trim()) {
        errorMessage = `Please enter a memo describing this ${activeTab === "pay_in" ? "pay in" : "pay out"}.`;
      }
      for (const line of payForLines) {
        if (line.amount && !line.categoryId) {
          errors.add(line.key);
        }
      }
      const linesWithAmounts = payForLines.filter(
        (l) => l.categoryId && l.amount && Number.parseFloat(l.amount) > 0,
      );
      if (linesWithAmounts.length === 0) {
        errorMessage = errorMessage || "At least 1 line with an amount is required.";
      }
      if (!payCategoryId) {
        errorMessage =
          errorMessage ||
          `Please select a ${activeTab === "pay_in" ? "Pay In" : "Pay Out"} Category.`;
      }
    } else if (activeTab === "transfer") {
      const amt = Number.parseFloat(transferAmount) || 0;
      if (amt <= 0) {
        errorMessage = "Please enter a transfer amount.";
      }
      if (!transferFromCategory || !transferToCategory) {
        errorMessage =
          errorMessage || "Please select both Transfer From and Transfer To categories.";
      }
    }

    setValidationErrors(errors);
    if (errors.size > 0) {
      errorMessage = errorMessage || "Please select a category for each line with an amount.";
    }
    if (errorMessage) {
      showToast?.(errorMessage, { icon: "error" });
      return false;
    }
    return true;
  };

  // ── AI Assistant apply handler ──
  const handleAIApply = useCallback((result: ParsedTransactionResult) => {
    // Switch transaction type
    if (result.transactionType) {
      setActiveTab(result.transactionType);
    }

    // Set date
    if (result.date) {
      setDate(result.date);
    }

    // Set memo
    if (result.memo) {
      setMemo(result.memo);
    }

    // Set reference number
    if (result.referenceNumber) {
      setReferenceNumber(result.referenceNumber);
    }

    // Set party — inject into partyOptions so the combobox can display it immediately
    if (result.partyId) {
      setPayPartyId(result.partyId);
      if (result.partyName) {
        setInjectedPartyOptions((prev) => {
          // Don't duplicate if already present
          if (prev.some((p) => p.value === result.partyId)) return prev;
          return [{ value: result.partyId, label: result.partyName }, ...prev];
        });
      }
    }

    if (result.transactionType === "transfer") {
      // Transfer-specific fields
      if (result.amount) {
        setTransferAmount(result.amount);
      }
      if (result.transferFromCategoryId) {
        setTransferFromCategory(result.transferFromCategoryId);
      }
      if (result.transferToCategoryId) {
        setTransferToCategory(result.transferToCategoryId);
      }
    } else if (result.transactionType === "pay_in" || result.transactionType === "pay_out") {
      // Pay In / Pay Out fields
      if (result.categoryId) {
        setPayCategoryId(result.categoryId);
      }

      if (result.lines.length > 0) {
        const newPayLines: PayForLine[] = result.lines.map((line) => ({
          key: createKey(),
          description: line.description || "",
          categoryId: line.categoryId || "",
          departmentId: line.departmentId || "",
          locationId: line.locationId || "",
          amount: line.amount || "",
        }));
        setPayForLines(newPayLines);
      } else if (result.amount) {
        // Single line from header amount
        setPayForLines([
          {
            key: createKey(),
            description: result.memo || "",
            categoryId: "",
            departmentId: result.departmentId || "",
            locationId: result.locationId || "",
            amount: result.amount,
          },
        ]);
      }
    } else if (result.transactionType === "journal") {
      // Journal entry lines
      if (result.lines.length > 0) {
        const newJournalLines: JournalLine[] = result.lines.map((line) => ({
          key: createKey(),
          description: line.description || "",
          categoryId: line.categoryId || "",
          partyId: "",
          departmentId: line.departmentId || "",
          locationId: line.locationId || "",
          debit: line.debit || "",
          credit: line.credit || "",
        }));
        setJournalLines(
          newJournalLines.length >= 2 ? newJournalLines : [...newJournalLines, emptyJournalLine()],
        );
      }
    }
  }, []);

  const getDraft = useCallback(
    (): TransactionDraft => ({
      type: activeTab,
      date,
      referenceNumber,
      memo,
      journalLines,
      payPartyId,
      payCategoryId,
      payForLines,
      transferFromParty,
      transferFromCategory,
      transferToParty,
      transferToCategory,
      transferAmount,
    }),
    [
      activeTab,
      date,
      referenceNumber,
      memo,
      journalLines,
      payPartyId,
      payCategoryId,
      payForLines,
      transferFromParty,
      transferFromCategory,
      transferToParty,
      transferToCategory,
      transferAmount,
    ],
  );

  return {
    partyMode,
    // Tab + shared fields
    activeTab,
    setActiveTab,
    handleTabChange,
    date,
    setDate,
    referenceNumber,
    setReferenceNumber,
    memo,
    setMemo,
    handleMemoChange,
    validationErrors,
    setValidationErrors,
    validate,
    getDraft,
    // Journal
    journalLines,
    setJournalLines,
    updateJournalLine,
    addJournalLine,
    addJournalLineAfter,
    copyJournalLine,
    removeJournalLine,
    journalTotals,
    journalPartyNames,
    handleJournalPartyNameChange,
    // Pay In / Pay Out
    payPartyId,
    setPayPartyId,
    payCategoryId,
    setPayCategoryId,
    payForLines,
    setPayForLines,
    updatePayForLine,
    addPayForLine,
    addPayForLineAfter,
    copyPayForLine,
    removePayForLine,
    payForTotal,
    // Transfer
    transferFromParty,
    setTransferFromParty,
    transferFromCategory,
    setTransferFromCategory,
    transferToParty,
    setTransferToParty,
    transferToCategory,
    setTransferToCategory,
    transferAmount,
    setTransferAmount,
    transferFromPartyName,
    setTransferFromPartyName,
    transferToPartyName,
    setTransferToPartyName,
    // Parties
    aggregatedPartyTypes,
    partyOptions,
    setPartyQuery,
    setInjectedPartyOptions,
    avatarItems,
    avatarFallbackIcon,
    headerAmount,
    // Data
    flatAccounts,
    typedOverrides,
    departmentOptions,
    locationOptions,
    catSuggestions,
    setCatSugQuery,
    // Category creation
    categoryModalOpen,
    categoryPrefill,
    closeCategoryModal,
    handleCreateCategorySubmit,
    handleCreateCategoryFromQuery,
    handleCreateCategorySuggestion,
    // AI apply
    handleAIApply,
  };
}

export type TransactionEditorState = ReturnType<typeof useTransactionEditor>;
