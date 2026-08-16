/**
 * New Transaction Page — Full-page, transaction creator
 * Supports 4 types: Journal, Pay In, Pay Out, Transfer
 * Each type has a dedicated form layout accessible via left sidebar tabs.
 */
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { lazy, Suspense, useState, useMemo, useRef, useEffect, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { JournalLineInput } from "../db/validation/journals";
import { createTransaction } from "./api/-transactions";
import { createAccount } from "./api/-accounts";
import { listParties, createParty } from "./api/-parties";
import { suggestParties, type PartySuggestion } from "./api/-party-suggestions";
import { getReadPartyTypes, toPartyApiFilter } from "../lib/party-scoping";
import type { PartyType } from "../lib/party-scoping";
import { listDepartments, listLocations } from "./api/-dimensions";
import type { ComboboxOption, SuggestedItem } from "../components/ui/Combobox";
import { useIsCompactNav } from "../hooks/useBreakpoint";
import Combobox from "../components/ui/Combobox";
import { ICON_PATHS } from "../components/accounts/icons";
import DayPicker from "../components/ui/DayPicker";
import { useToast } from "../components/ui/Toast";
import NewCategoryModal from "../components/accounts/NewCategoryModal";
import type { CategoryPrefill, NewCategoryData } from "../components/accounts/NewCategoryForm";
import suggestedCategories from "../lib/suggested-categories.json";
import MultiAvatar from "../components/transactions/shared/MultiAvatar";
import type { AvatarItem } from "../components/transactions/shared/MultiAvatar";

// Shared modules (extracted)
import type { TabType, JournalLine, PayForLine } from "../components/transactions/shared/types";
import { TABS, PARTY_ICON, TYPE_LABELS } from "../components/transactions/shared/constants";
import {
  todayISO,
  formatCurrency,
  createKey,
  emptyJournalLine,
  emptyPayForLine,
} from "../components/transactions/shared/helpers";
import JournalForm from "../components/transactions/forms/JournalForm";
import PayForm from "../components/transactions/forms/PayForm";
import TransferForm from "../components/transactions/forms/TransferForm";
import AttachmentsPanel from "../components/transactions/AttachmentsPanel";
import type { StagedDocument } from "../components/transactions/AttachmentsPanel";
import type { ParsedTransactionResult } from "./api/-ai-transaction-parse";
import { useDebouncedValue } from "../hooks/useDebouncedValue";
import { useTransactionAccounts } from "../hooks/useTransactionAccounts";
import { AppErrorBoundary } from "../components/error/AppErrorBoundary";
import { Modal } from "../components/ui/Modal";
import { createLogger } from "../lib/logger";
import { keys } from "../lib/query-keys";
import { callServerFn } from "../lib/server-fn-client";
const logger = createLogger("ui.transactions");

const AIChatPanel = lazy(() => import("../components/transactions/AIChatPanel"));

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
type CategoryPrefillState = CategoryPrefill & {
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

// ============================================================================
// Route
// ============================================================================

export const Route = createFileRoute("/transactions_/new")({
  component: NewTransactionRoute,
});

function NewTransactionRoute() {
  return (
    <AppErrorBoundary contextLabel="New Transaction">
      <NewTransactionPage />
    </AppErrorBoundary>
  );
}

// ============================================================================
// Component
// ============================================================================

function NewTransactionPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  // ── Tab state ──
  const [activeTab, setActiveTab] = useState<TabType>("journal");

  // ── Shared fields ──
  const [date, setDate] = useState(todayISO());
  const [referenceNumber, setReferenceNumber] = useState("");
  const [memo, setMemo] = useState("");

  // ── Save split-button dropdown ──
  const [saveMenuOpen, setSaveMenuOpen] = useState(false);
  const [showActivityLog, setShowActivityLog] = useState(false);

  // The Activity Log has two presentations: a docked column at `lg`, and this modal below it.
  // Its trigger is `lg:hidden`, so the modal is unopenable on desktop — but a viewport that
  // *grows* past `lg` while it is open leaves the modal floating over the column it duplicates.
  const isCompactLayout = useIsCompactNav();
  useEffect(() => {
    if (!isCompactLayout) setShowActivityLog(false);
  }, [isCompactLayout]);
  const [sidebarTab, setSidebarTab] = useState<"attachments" | "ai" | "activity">("attachments");
  const [stagedDocuments, setStagedDocuments] = useState<StagedDocument[]>([]);
  const saveMenuRef = useRef<HTMLDivElement>(null);
  const submissionIdempotencyKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!saveMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (saveMenuRef.current && !saveMenuRef.current.contains(e.target as Node)) {
        setSaveMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [saveMenuOpen]);

  // ── Auto-stage document from URL params (from document detail page) ──
  // Also handle reconciliation prefill params
  const [_reconReturnId, setReconReturnId] = useState<string | null>(null);
  const [aiInitialPrompt, setAiInitialPrompt] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const docId = params.get("docId");
    const docName = params.get("docName");
    if (docId) {
      setStagedDocuments((prev) => {
        if (prev.some((d) => d.documentId === docId)) return prev;
        return [
          ...prev,
          {
            documentId: docId,
            filename: docName || "Attached Document",
            contentType: "",
            fileSizeBytes: 0,
          },
        ];
      });
      // Switch to attachments tab to show the staged doc
      setSidebarTab("attachments");
    }

    // ── Reconciliation prefill params ──
    const reconType = params.get("type") as TabType | null;
    const reconDate = params.get("date");
    const reconDesc = params.get("description");
    const reconAmount = params.get("amount");
    const reconId = params.get("reconId");
    const reconAiPrompt = params.get("aiPrompt");

    if (reconType) setActiveTab(reconType);
    if (reconDate) setDate(reconDate);
    if (reconDesc) setMemo(reconDesc);
    if (reconId) setReconReturnId(reconId);

    // Pre-fill pay-for lines for pay_out / pay_in
    if ((reconType === "pay_out" || reconType === "pay_in") && reconAmount) {
      setPayForLines([
        {
          key: crypto.randomUUID(),
          description: reconDesc || "",
          categoryId: "",
          departmentId: "",
          locationId: "",
          amount: reconAmount,
        },
      ]);
    }

    // Set AI prompt for auto-submission (switches sidebar to AI tab)
    if (reconAiPrompt) {
      setAiInitialPrompt(reconAiPrompt);
      setSidebarTab("ai");
    }
  }, []);

  // ── Validation state ──
  const [validationErrors, setValidationErrors] = useState<Set<string>>(new Set());

  // ── Journal state ──
  const [journalLines, setJournalLines] = useState<JournalLine[]>([
    emptyJournalLine(),
    emptyJournalLine(),
  ]);

  // ── Pay In / Pay Out state ──
  const [payPartyId, setPayPartyId] = useState("");
  const [payCategoryId, setPayCategoryId] = useState("");
  const [payForLines, setPayForLines] = useState<PayForLine[]>([emptyPayForLine()]);

  // ── Transfer state ──
  const [transferFromParty, setTransferFromParty] = useState("");
  const [transferFromCategory, setTransferFromCategory] = useState("");
  const [transferToParty, setTransferToParty] = useState("");
  const [transferToCategory, setTransferToCategory] = useState("");
  const [transferAmount, setTransferAmount] = useState("");
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
  const [injectedPartyOptions, setInjectedPartyOptions] = useState<ComboboxOption[]>([]);

  // ── Data ──
  const { flatAccounts, typedOverrides } = useTransactionAccounts();

  // ── Resolve categoryName URL param to account ID once flatAccounts loads ──
  const categoryNameResolved = useRef(false);
  useEffect(() => {
    if (categoryNameResolved.current || flatAccounts.length === 0) return;
    const params = new URLSearchParams(window.location.search);
    const catName = params.get("categoryName");
    if (!catName) return;
    categoryNameResolved.current = true;
    const match = flatAccounts.find((a) => a.name.toLowerCase() === catName.toLowerCase());
    if (match) {
      setPayCategoryId(match.id);
    }
  }, [flatAccounts]);

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
    queryKey: ["partySearch", debouncedPartyQuery, partyTypeFilter],
    queryFn: () =>
      callServerFn(listParties, {
        data: {
          search: debouncedPartyQuery,
          type: partyTypeFilter ?? undefined,
          limit: 50,
        },
      }),
    enabled: partyTypeFilter !== null,
    staleTime: 30 * 1000,
  });

  // Derive partyOptions from fetched parties + suggestions (no setState = no re-render loop)
  const partyOptions: ComboboxOption[] = useMemo(() => {
    if (partyTypeFilter === null) {
      // Even when party type filter isn't ready, always surface injected AI options
      return injectedPartyOptions.length > 0 ? [...injectedPartyOptions] : [];
    }

    // Filter suggestions by aggregated party types
    const allowedTypes = aggregatedPartyTypes;
    const filteredSuggestions = partySuggestions.filter(
      (s) =>
        (!allowedTypes ||
          allowedTypes.includes(s.partyType) ||
          (s.partyType === "both" &&
            (allowedTypes.includes("vendor") || allowedTypes.includes("customer")))) &&
        (!debouncedPartyQuery || s.name.toLowerCase().includes(debouncedPartyQuery.toLowerCase())),
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
    aggregatedPartyTypes,
    partySuggestions,
    fetchedParties,
    debouncedPartyQuery,
    injectedPartyOptions,
  ]);

  // Helper: derive up to 2 initials from a name
  const getInitials = (name: string): string | null => {
    const cleaned = name.replace(/^★\s*/, "").trim();
    const words = cleaned.split(/\s+/).filter(Boolean);
    if (words.length === 0) return null;
    if (words.length === 1) return words[0].charAt(0).toUpperCase();
    return (words[0].charAt(0) + words[1].charAt(0)).toUpperCase();
  };

  // Unified avatar items for the header — works across all tabs
  const avatarItems: AvatarItem[] = useMemo(() => {
    if (activeTab === "pay_in" || activeTab === "pay_out") {
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

  // ── Mutation ──
  const createMutation = useMutation({
    mutationFn: (data: {
      idempotencyKey: string;
      transactionDate: string;
      transactionType: TabType;
      memo?: string;
      partyId?: string;
      referenceNumber?: string;
      documentIds?: string[];
      lines: JournalLineInput[];
    }) =>
      callServerFn(createTransaction, {
        data,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: keys.inbox.all() });
    },
  });

  // ── Journal line helpers ──
  const updateJournalLine = (key: string, field: keyof JournalLine, value: string) => {
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
  };

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
  const updatePayForLine = (key: string, field: keyof PayForLine, value: string) => {
    setPayForLines((prev) => prev.map((l) => (l.key === key ? { ...l, [field]: value } : l)));
  };

  // ── Category creation handlers (after updateJournalLine / updatePayForLine) ──
  const openCategoryModal = useCallback((target: string, prefill?: CategoryPrefillState) => {
    setCategoryTarget(target);
    setCategoryPrefill(prefill);
    setCategoryModalOpen(true);
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

  // ── Submit handler ──
  const handleSave = (mode: "close" | "save" | "new" = "close") => {
    if (!validate()) return;
    const idempotencyKey =
      submissionIdempotencyKeyRef.current ??
      (submissionIdempotencyKeyRef.current = crypto.randomUUID());

    const onSuccessNav = async (result?: { inboxItem: { id: string } }) => {
      submissionIdempotencyKeyRef.current = null;
      await queryClient.invalidateQueries({ queryKey: keys.inbox.all() });
      showToast?.("Transaction submitted to Inbox for review.", { icon: "success" });
      if (mode === "new") {
        // Reset form
        setMemo("");
        setReferenceNumber("");
        setJournalLines([emptyJournalLine(), emptyJournalLine()]);
        setPayForLines([emptyPayForLine()]);
        setTransferAmount("");
        setValidationErrors(new Set());
        setStagedDocuments([]);
      } else {
        navigate({
          to: "/inbox" as string & {},
          search: { selected: result?.inboxItem.id },
        });
      }
    };
    const documentIds = stagedDocuments.map((document) => document.documentId);

    if (activeTab === "journal") {
      const lines: JournalLineInput[] = journalLines
        .filter((l) => l.categoryId && (l.debit || l.credit))
        .map((l, i) => ({
          accountId: l.categoryId,
          debit: l.debit ? Number.parseFloat(l.debit).toFixed(2) : undefined,
          credit: l.credit ? Number.parseFloat(l.credit).toFixed(2) : undefined,
          lineDescription: l.description || undefined,
          partyId: l.partyId || undefined,
          departmentId: l.departmentId || undefined,
          locationId: l.locationId || undefined,
          sortOrder: i,
        }));

      createMutation.mutate(
        {
          idempotencyKey,
          transactionDate: date,
          transactionType: "journal",
          memo: memo || undefined,
          referenceNumber: referenceNumber || undefined,
          documentIds,
          lines,
        },
        { onSuccess: (data) => onSuccessNav(data) },
      );
    } else if (activeTab === "pay_in" || activeTab === "pay_out") {
      const lines: JournalLineInput[] = [];
      let totalAmount = 0;

      payForLines.forEach((l, i) => {
        const amt = Number.parseFloat(l.amount) || 0;
        if (amt <= 0 || !l.categoryId) return;
        totalAmount += amt;
        lines.push({
          accountId: l.categoryId,
          ...(activeTab === "pay_in" ? { credit: amt.toFixed(2) } : { debit: amt.toFixed(2) }),
          lineDescription: l.description || undefined,
          sortOrder: i + 1,
        });
      });

      if (payCategoryId && totalAmount > 0) {
        lines.unshift({
          accountId: payCategoryId,
          ...(activeTab === "pay_in"
            ? { debit: totalAmount.toFixed(2) }
            : { credit: totalAmount.toFixed(2) }),
          sortOrder: 0,
        });
      }

      createMutation.mutate(
        {
          idempotencyKey,
          transactionDate: date,
          transactionType: activeTab,
          memo: memo || undefined,
          partyId: payPartyId || undefined,
          referenceNumber: referenceNumber || undefined,
          documentIds,
          lines,
        },
        { onSuccess: (data) => onSuccessNav(data) },
      );
    } else if (activeTab === "transfer") {
      const amt = (Number.parseFloat(transferAmount) || 0).toFixed(2);
      const lines: JournalLineInput[] = [];
      if (transferToCategory) {
        lines.push({ accountId: transferToCategory, debit: amt, sortOrder: 0 });
      }
      if (transferFromCategory) {
        lines.push({ accountId: transferFromCategory, credit: amt, sortOrder: 1 });
      }

      createMutation.mutate(
        {
          idempotencyKey,
          transactionDate: date,
          transactionType: "transfer",
          memo: memo || undefined,
          referenceNumber: referenceNumber || undefined,
          documentIds,
          lines,
        },
        { onSuccess: (data) => onSuccessNav(data) },
      );
    }
  };

  const handleCancel = () => {
    window.history.back();
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

  // ── Render ──
  const mainContent = (
    <div className="flex h-screen bg-[#f0f2f5] dark:bg-slate-950">
      {/* ── Left Sidebar — Tabs ── */}
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

      {/* ── Main Content ── */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Top bar */}
        <div className="flex items-center justify-between gap-3 px-6 py-3 bg-white dark:bg-slate-900 border-b border-[#e2e8f0] dark:border-slate-700">
          {/* Activity Log toggle — mobile only */}
          <button
            type="button"
            className="lg:hidden w-9 h-9 touch-target rounded-lg flex items-center justify-center text-[#64748b] dark:text-slate-400 hover:bg-[#f1f5f9] dark:hover:bg-slate-800 hover:text-[var(--color-app-header-teal)] transition-colors cursor-pointer"
            onClick={() => setShowActivityLog(true)}
            title="Activity Log"
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <path d="M15 3v18" />
            </svg>
          </button>
          {/* Back arrow — uses browser history */}
          <button
            type="button"
            onClick={handleCancel}
            className="w-9 h-9 touch-target rounded-lg flex items-center justify-center text-[#64748b] dark:text-slate-400 hover:bg-[#f1f5f9] dark:hover:bg-slate-800 hover:text-[#1e293b] dark:hover:text-slate-200 transition-colors"
            title="Go back"
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M19 12H5" />
              <polyline points="12 19 5 12 12 5" />
            </svg>
          </button>
          <div className="flex items-center gap-3">
            {validationErrors.size > 0 && (
              <span className="text-xs font-medium text-red-500 dark:text-red-400 animate-in fade-in duration-200">
                Please select a category for each line with an amount
              </span>
            )}
            {createMutation.isError && (
              <span className="text-xs font-medium text-red-500 dark:text-red-400 animate-in fade-in duration-200">
                Failed to save — {(createMutation.error as Error)?.message || "please try again"}
              </span>
            )}

            <div className="relative flex items-stretch" ref={saveMenuRef}>
              <button
                type="button"
                onClick={() => handleSave("close")}
                disabled={createMutation.isPending}
                className="flex items-center gap-2 px-5 py-2.5 rounded-l-lg bg-[var(--color-app-header-teal)] hover:bg-[#248f82] disabled:opacity-50 text-white text-[13px] font-medium transition-colors"
              >
                {createMutation.isPending ? "Saving..." : "Save & Close"}
              </button>
              <button
                type="button"
                onClick={() => setSaveMenuOpen((v) => !v)}
                className="flex items-center justify-center w-10 rounded-r-lg bg-[var(--color-app-header-teal)] hover:bg-[#248f82] text-white transition-colors border-l border-white/25"
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                >
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>
              {saveMenuOpen && (
                <div className="absolute right-0 top-full mt-1 w-40 bg-white dark:bg-slate-900 border border-[#e5e7eb] dark:border-slate-700 rounded-lg shadow-lg z-50 py-1">
                  <button
                    type="button"
                    onClick={() => {
                      setSaveMenuOpen(false);
                      handleSave("save");
                    }}
                    className="w-full text-left px-3 py-2 text-xs text-[#374151] dark:text-slate-300 hover:bg-[#f9fafb] dark:hover:bg-slate-800 rounded-t-lg transition-colors"
                  >
                    Save
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setSaveMenuOpen(false);
                      handleSave("new");
                    }}
                    className="w-full text-left px-3 py-2 text-xs text-[#374151] dark:text-slate-300 hover:bg-[#f9fafb] dark:hover:bg-slate-800 rounded-b-lg transition-colors"
                  >
                    Save & New
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Scrollable form area */}
        <div className="flex-1 p-6 pb-0">
          <div className="flex gap-6 h-[calc(100vh-5rem-50px)]">
            {/* Main form card */}
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
                      {activeTab !== "transfer" && activeTab !== "journal" ? (
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
                          createLabel={
                            aggregatedPartyTypes ? aggregatedPartyTypes.join(" or ") : undefined
                          }
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

            {/* ── Right sidebar — Tabbed (AI Chat / Activity Log) ── */}
            <div className="hidden lg:flex lg:flex-col w-[360px] shrink-0">
              <div className="bg-white dark:bg-[#1e293b] rounded-2xl shadow-[0_4px_24px_rgba(0,0,0,0.08)] flex flex-col h-full overflow-hidden">
                {/* Tab bar — green gradient matching entity sidebar */}
                <div className="flex justify-evenly bg-gradient-to-r from-[#1a6b3c] to-[#27ae60] dark:from-[#145a30] dark:to-[#1e8c4c] shrink-0 px-4 py-3 gap-2">
                  <button
                    type="button"
                    onClick={() => setSidebarTab("attachments")}
                    className={`w-22 h-11 flex items-center justify-center rounded-full transition-colors cursor-pointer relative ${
                      sidebarTab === "attachments"
                        ? "bg-white/20 text-white"
                        : "text-white/50 hover:text-white hover:bg-white/10"
                    }`}
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
                      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                    </svg>
                    {stagedDocuments.length > 0 && (
                      <span className="absolute -top-0.5 -right-0.5 w-4 h-4 rounded-full bg-white text-[#1a6b3c] text-[9px] font-bold flex items-center justify-center">
                        {stagedDocuments.length}
                      </span>
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => setSidebarTab("ai")}
                    className={`w-22 h-11 flex items-center justify-center rounded-full transition-colors cursor-pointer ${
                      sidebarTab === "ai"
                        ? "bg-white/20 text-white"
                        : "text-white/50 hover:text-white hover:bg-white/10"
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
                      <path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3z" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    onClick={() => setSidebarTab("activity")}
                    className={`w-22 h-11 flex items-center justify-center rounded-full transition-colors cursor-pointer ${
                      sidebarTab === "activity"
                        ? "bg-white/20 text-white"
                        : "text-white/50 hover:text-white hover:bg-white/10"
                    }`}
                  >
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                    >
                      <circle cx="12" cy="12" r="10" />
                      <polyline points="12 6 12 12 16 14" />
                    </svg>
                  </button>
                </div>

                {/* Tab content */}
                <div className="flex-1 overflow-y-auto p-3">
                  {/* All panels rendered simultaneously — hidden via display:none to preserve state */}
                  <div style={{ display: sidebarTab === "attachments" ? "block" : "none" }}>
                    <AttachmentsPanel
                      stagedDocuments={stagedDocuments}
                      onDocumentsChange={setStagedDocuments}
                      accounts={flatAccounts}
                      parties={partyOptions.map((p) => ({ id: p.value, name: p.label }))}
                      departments={departmentOptions.map((d) => ({
                        id: d.value,
                        name: d.label,
                      }))}
                      locations={locationOptions.map((l) => ({ id: l.value, name: l.label }))}
                      currentDate={date}
                      onApply={handleAIApply}
                      onEntitiesResolved={async () => {
                        await Promise.all([
                          queryClient.invalidateQueries({ queryKey: ["financial-accounts"] }),
                          queryClient.invalidateQueries({ queryKey: ["accounts"] }),
                          queryClient.invalidateQueries({ queryKey: ["parties"] }),
                        ]);
                      }}
                    />
                  </div>
                  <div style={{ display: sidebarTab === "ai" ? "block" : "none" }}>
                    <AppErrorBoundary contextLabel="AI Assistant">
                      <Suspense
                        fallback={
                          <div className="rounded-2xl border border-slate-200 bg-white/80 px-4 py-6 text-sm text-slate-500 dark:border-slate-700 dark:bg-slate-900/80 dark:text-slate-300">
                            Loading AI assistant…
                          </div>
                        }
                      >
                        <AIChatPanel
                          accounts={flatAccounts}
                          parties={partyOptions.map((p) => ({ id: p.value, name: p.label }))}
                          departments={departmentOptions.map((d) => ({
                            id: d.value,
                            name: d.label,
                          }))}
                          locations={locationOptions.map((l) => ({ id: l.value, name: l.label }))}
                          currentDate={date}
                          onApply={handleAIApply}
                          initialPrompt={aiInitialPrompt}
                        />
                      </Suspense>
                    </AppErrorBoundary>
                  </div>
                  <div style={{ display: sidebarTab === "activity" ? "block" : "none" }}>
                    <div>
                      <div className="flex items-center justify-center mb-3">
                        <svg
                          width="18"
                          height="18"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="#94a3b8"
                          strokeWidth="1.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <circle cx="12" cy="12" r="10" />
                          <polyline points="12 6 12 12 16 14" />
                        </svg>
                      </div>
                      <h3 className="text-sm font-semibold text-[#1e293b] dark:text-white text-center mb-3">
                        Activity Log
                      </h3>
                      <div className="flex items-start gap-2">
                        <div className="w-6 h-6 rounded-full bg-[var(--color-app-header-teal)] flex items-center justify-center text-white text-[10px] font-bold shrink-0">
                          U
                        </div>
                        <div>
                          <p className="text-xs text-[#1e293b] dark:text-white">
                            <span className="font-medium">User</span>{" "}
                            <span className="text-[#94a3b8] dark:text-slate-500">Just now</span>
                          </p>
                          <p className="text-[11px] text-[#64748b] dark:text-slate-400">
                            Creating transaction.
                          </p>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Mobile Activity Log — the docked column is `lg:` only, so below that it is
              presented as its own screen. */}
          <Modal
            open={showActivityLog}
            onClose={() => setShowActivityLog(false)}
            title="Activity Log"
            mobile="fullscreen"
            size="sm"
          >
            <div className="flex items-start gap-2">
              <div className="w-6 h-6 rounded-full bg-[var(--color-app-header-teal)] flex items-center justify-center text-white text-[10px] font-bold shrink-0">
                U
              </div>
              <div>
                <p className="text-sm text-[#1e293b] dark:text-white">
                  <span className="font-medium">User</span>{" "}
                  <span className="text-[#94a3b8] dark:text-slate-500">Just now</span>
                </p>
                <p className="text-xs text-[#64748b] dark:text-slate-400">Creating transaction.</p>
              </div>
            </div>
          </Modal>
        </div>
      </div>
    </div>
  );

  // ── Category creation modal (portal, outside component tree) ──
  const modalElement = (
    <NewCategoryModal
      open={categoryModalOpen}
      onClose={() => {
        setCategoryModalOpen(false);
        setCategoryPrefill(undefined);
      }}
      onSubmit={handleCreateCategorySubmit}
      prefill={categoryPrefill}
      parentCategories={flatAccounts
        .filter((a) => !a.parentId)
        .map((a) => ({ id: a.id, name: a.name, accountNumber: a.accountNumber ?? undefined }))}
    />
  );

  return (
    <>
      {mainContent}
      {modalElement}
    </>
  );
}
