/**
 * useReconciliationData — queries and derived data for the Reconciliation Detail page.
 *
 * Encapsulates: detailQuery, activityQuery, suggestionsQuery,
 * normalized recon, filter options, filtered statement/ledger lists,
 * metrics, cross-hover lookups, and the "Not Found" overlay logic.
 */
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import type { ReconciliationDetail, LedgerTransaction } from "../routes/api/-reconciliations";
import {
  getReconciliation,
  getReconciliationActivityLog,
  listReconciliationSuggestions,
} from "../routes/api/-reconciliations";
import type { TransactionType, JournalStatus } from "../db/validation/journals";

type ServerFnCaller = (opts: { data: unknown }) => Promise<any>;
type TransactionFilter = "all" | "matched" | "unmatched" | "ignored";
type ReconStatusFilter = "all" | "reconciled" | "unsettled";

export interface ReconciliationDataParams {
  reconciliationId: string;
  hasSession: boolean;

  // Hover linking
  hoveredStatementLineId: string | null;
  hoveredLedgerTxnId: string | null;

  // Filter state
  txnFilter: TransactionFilter;
  searchQuery: string;
  reconStatusFilter: ReconStatusFilter;
  selectedStatementLineId: string | null;
  typeFilter: TransactionType[];
  statusFilter: JournalStatus[];
  matchedFilter: string[];
  partyFilter: string[];
  departmentFilter: string[];
  locationFilter: string[];
  amountMin: string;
  amountMax: string;

  // Search state for filter dropdowns
  partySearch: string;
  departmentSearch: string;
  locationSearch: string;
}

export function useReconciliationData(params: ReconciliationDataParams) {
  const {
    reconciliationId,
    hasSession,
    hoveredStatementLineId,
    hoveredLedgerTxnId,
    txnFilter,
    searchQuery,
    reconStatusFilter,
    selectedStatementLineId,
    typeFilter,
    statusFilter,
    matchedFilter,
    partyFilter,
    departmentFilter,
    locationFilter,
    amountMin,
    amountMax,
    partySearch,
    departmentSearch,
    locationSearch,
  } = params;

  // ── Queries ────────────────────────────────────────────────

  const detailQuery = useQuery({
    queryKey: ["reconciliations", "detail", reconciliationId],
    queryFn: () =>
      (getReconciliation as ServerFnCaller)({
        data: { id: reconciliationId },
      }),
    enabled: hasSession && !!reconciliationId,
  });

  const activityQuery = useQuery({
    queryKey: ["reconciliations", "activity", reconciliationId],
    queryFn: () =>
      (getReconciliationActivityLog as ServerFnCaller)({ data: { id: reconciliationId } }),
    enabled: hasSession && !!reconciliationId,
  });

  const suggestionsQuery = useQuery({
    queryKey: ["reconciliations", "suggestions", reconciliationId],
    queryFn: () =>
      (listReconciliationSuggestions as ServerFnCaller)({
        data: { reconciliationId },
      }),
    enabled: hasSession && !!reconciliationId,
  });

  // ── Normalize recon ────────────────────────────────────────

  const rawRecon = detailQuery.data as ReconciliationDetail | undefined;
  const recon = useMemo(() => {
    if (!rawRecon) return undefined;
    return {
      ...rawRecon,
      ledgerTransactions: rawRecon.ledgerTransactions.map((t) => ({
        ...t,
        isMatched: !!t.isMatched,
      })),
    };
  }, [rawRecon]);
  const isFinalized = recon?.status === "finalized";

  // ── Derived filter options ─────────────────────────────────

  const periodPartyOptions = useMemo(() => {
    if (!recon) return [];
    const seen = new Map<string, string>();
    for (const t of recon.ledgerTransactions) {
      if (t.partyId && t.partyName && !seen.has(t.partyId)) seen.set(t.partyId, t.partyName);
    }
    return Array.from(seen, ([id, name]) => ({ id, name, partyType: "" }));
  }, [recon]);

  const periodDepartmentOptions = useMemo(() => {
    if (!recon) return [];
    const seen = new Map<string, string>();
    for (const t of recon.ledgerTransactions) {
      if (t.departmentId && t.departmentName && !seen.has(t.departmentId))
        seen.set(t.departmentId, t.departmentName);
    }
    return Array.from(seen, ([id, name]) => ({ id, name }));
  }, [recon]);

  const periodLocationOptions = useMemo(() => {
    if (!recon) return [];
    const seen = new Map<string, string>();
    for (const t of recon.ledgerTransactions) {
      if (t.locationId && t.locationName && !seen.has(t.locationId))
        seen.set(t.locationId, t.locationName);
    }
    return Array.from(seen, ([id, name]) => ({ id, name }));
  }, [recon]);

  const filteredPartyOptions = useMemo(() => {
    if (!partySearch) return periodPartyOptions;
    const q = partySearch.toLowerCase();
    return periodPartyOptions.filter((p) => p.name.toLowerCase().includes(q));
  }, [periodPartyOptions, partySearch]);

  const filteredDepartmentOptions = useMemo(() => {
    if (!departmentSearch) return periodDepartmentOptions;
    const q = departmentSearch.toLowerCase();
    return periodDepartmentOptions.filter((d) => d.name.toLowerCase().includes(q));
  }, [periodDepartmentOptions, departmentSearch]);

  const filteredLocationOptions = useMemo(() => {
    if (!locationSearch) return periodLocationOptions;
    const q = locationSearch.toLowerCase();
    return periodLocationOptions.filter((l) => l.name.toLowerCase().includes(q));
  }, [periodLocationOptions, locationSearch]);

  // ── Cross-hover lookups ────────────────────────────────────

  const journalToStatementMap = useMemo(() => {
    if (!recon) return new Map<string, string>();
    const map = new Map<string, string>();
    for (const sl of recon.statementLines) {
      if (sl.matchedJournalLineId) {
        map.set(sl.matchedJournalLineId, sl.id);
      }
    }
    return map;
  }, [recon]);

  const unmatchedLedgerByAmount = useMemo(() => {
    if (!recon) return new Map<string, LedgerTransaction>();
    const map = new Map<string, LedgerTransaction>();
    for (const txn of recon.ledgerTransactions) {
      if (!txn.isMatched) {
        const key = Math.abs(txn.amount).toFixed(2);
        if (!map.has(key)) {
          map.set(key, txn);
        }
      }
    }
    return map;
  }, [recon]);

  const statementLinePageMap = useMemo(() => {
    if (!recon) return new Map<string, number>();
    const map = new Map<string, number>();
    const bboxes = (recon.statementLineBoundingBoxes ?? []) as Array<{
      id: string;
      page: number;
      fieldType: string;
    }>;
    for (const b of bboxes) {
      if (b.fieldType === "transaction") {
        map.set(b.id, b.page);
      }
    }
    return map;
  }, [recon]);

  const linkedLedgerTxnId = useMemo(() => {
    if (!hoveredStatementLineId || !recon) return null;
    const sl = recon.statementLines.find((s) => s.id === hoveredStatementLineId);
    return sl?.matchedJournalLineId ?? null;
  }, [hoveredStatementLineId, recon]);

  const linkedStatementLineId = useMemo(() => {
    if (!hoveredLedgerTxnId) return null;
    return journalToStatementMap.get(hoveredLedgerTxnId) ?? null;
  }, [hoveredLedgerTxnId, journalToStatementMap]);

  // ── Filtered statement lines ───────────────────────────────

  const filteredStatementLines = useMemo(() => {
    if (!recon) return [];
    let lines = recon.statementLines;
    const ledgerLookup = new Map(recon.ledgerTransactions.map((t) => [t.id, t]));

    if (reconStatusFilter === "reconciled") {
      lines = lines.filter((l) => l.matchStatus === "matched");
    } else if (reconStatusFilter === "unsettled") {
      lines = lines.filter((l) => l.matchStatus === "unmatched" || l.matchStatus === "ignored");
    }

    if (txnFilter !== "all") {
      lines = lines.filter((l) => l.matchStatus === txnFilter || l.id === selectedStatementLineId);
    }

    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      lines = lines.filter(
        (l) =>
          l.description.toLowerCase().includes(q) ||
          l.amount.includes(q) ||
          l.transactionDate.includes(q) ||
          l.id === selectedStatementLineId,
      );
    }

    if (typeFilter.length > 0) {
      lines = lines.filter((l) => {
        if (!l.matchedJournalLineId) return false;
        const txn = ledgerLookup.get(l.matchedJournalLineId);
        return txn && typeFilter.includes(txn.transactionType as TransactionType);
      });
    }

    if (statusFilter.length > 0) {
      lines = lines.filter((l) => {
        if (!l.matchedJournalLineId) return false;
        const txn = ledgerLookup.get(l.matchedJournalLineId);
        return txn && statusFilter.includes(txn.journalStatus as JournalStatus);
      });
    }

    if (matchedFilter.length > 0) {
      lines = lines.filter((l) => {
        const isMatched = l.matchStatus === "matched";
        if (matchedFilter.includes("matched") && isMatched) return true;
        if (matchedFilter.includes("unmatched") && !isMatched) return true;
        return false;
      });
    }

    if (partyFilter.length > 0) {
      lines = lines.filter((l) => {
        if (!l.matchedJournalLineId) return false;
        const txn = ledgerLookup.get(l.matchedJournalLineId);
        return txn?.partyId && partyFilter.includes(txn.partyId);
      });
    }

    if (departmentFilter.length > 0) {
      lines = lines.filter((l) => {
        if (!l.matchedJournalLineId) return false;
        const txn = ledgerLookup.get(l.matchedJournalLineId);
        return txn?.departmentId && departmentFilter.includes(txn.departmentId);
      });
    }

    if (locationFilter.length > 0) {
      lines = lines.filter((l) => {
        if (!l.matchedJournalLineId) return false;
        const txn = ledgerLookup.get(l.matchedJournalLineId);
        return txn?.locationId && locationFilter.includes(txn.locationId);
      });
    }

    const minVal = amountMin ? Number.parseFloat(amountMin) : null;
    const maxVal = amountMax ? Number.parseFloat(amountMax) : null;
    if (minVal !== null || maxVal !== null) {
      lines = lines.filter((l) => {
        const absAmount = Math.abs(Number.parseFloat(l.amount));
        if (minVal !== null && absAmount < minVal) return false;
        if (maxVal !== null && absAmount > maxVal) return false;
        return true;
      });
    }

    return lines;
  }, [
    recon,
    txnFilter,
    searchQuery,
    selectedStatementLineId,
    reconStatusFilter,
    typeFilter,
    statusFilter,
    matchedFilter,
    partyFilter,
    departmentFilter,
    locationFilter,
    amountMin,
    amountMax,
  ]);

  // ── Filtered ledger transactions ───────────────────────────

  const filteredLedgerTxns = useMemo(() => {
    if (!recon) return [];
    let txns = recon.ledgerTransactions;

    if (txnFilter === "matched") {
      txns = txns.filter((t) => t.isMatched);
    } else if (txnFilter === "unmatched") {
      txns = txns.filter((t) => !t.isMatched);
    }

    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      txns = txns.filter(
        (t) =>
          (t.description ?? "").toLowerCase().includes(q) ||
          t.accountName.toLowerCase().includes(q) ||
          (t.transactionNumber ?? "").includes(q),
      );
    }

    if (typeFilter.length > 0) {
      txns = txns.filter((t) => typeFilter.includes(t.transactionType as TransactionType));
    }

    if (statusFilter.length > 0) {
      txns = txns.filter((t) => statusFilter.includes(t.journalStatus as JournalStatus));
    }

    if (matchedFilter.length > 0) {
      txns = txns.filter((t) => {
        if (matchedFilter.includes("matched") && t.isMatched) return true;
        if (matchedFilter.includes("unmatched") && !t.isMatched) return true;
        return false;
      });
    }

    if (partyFilter.length > 0) {
      txns = txns.filter((t) => t.partyId && partyFilter.includes(t.partyId));
    }

    if (departmentFilter.length > 0) {
      txns = txns.filter((t) => t.departmentId && departmentFilter.includes(t.departmentId));
    }

    if (locationFilter.length > 0) {
      txns = txns.filter((t) => t.locationId && locationFilter.includes(t.locationId));
    }

    const minVal = amountMin ? Number.parseFloat(amountMin) : null;
    const maxVal = amountMax ? Number.parseFloat(amountMax) : null;
    if (minVal !== null || maxVal !== null) {
      txns = txns.filter((t) => {
        const absAmount = Math.abs(t.amount);
        if (minVal !== null && absAmount < minVal) return false;
        if (maxVal !== null && absAmount > maxVal) return false;
        return true;
      });
    }

    return txns;
  }, [
    recon,
    txnFilter,
    searchQuery,
    typeFilter,
    statusFilter,
    matchedFilter,
    partyFilter,
    departmentFilter,
    locationFilter,
    amountMin,
    amountMax,
  ]);

  // ── Metrics ────────────────────────────────────────────────

  const metrics = useMemo(() => {
    if (!recon)
      return {
        totalStatement: 0,
        matched: 0,
        unmatched: 0,
        ignored: 0,
        totalLedger: 0,
        ledgerMatched: 0,
        ledgerUnmatched: 0,
      };
    return {
      totalStatement: recon.statementLines.length,
      matched: recon.statementLines.filter((l) => l.matchStatus === "matched").length,
      unmatched: recon.statementLines.filter((l) => l.matchStatus === "unmatched").length,
      ignored: recon.statementLines.filter((l) => l.matchStatus === "ignored").length,
      totalLedger: recon.ledgerTransactions.length,
      ledgerMatched: recon.ledgerTransactions.filter((t) => t.isMatched).length,
      ledgerUnmatched: recon.ledgerTransactions.filter((t) => !t.isMatched).length,
    };
  }, [recon]);

  // ── Filtered ledger by status ──────────────────────────────

  const filteredLedgerByStatus = useMemo(() => {
    if (reconStatusFilter === "all") return filteredLedgerTxns;
    if (reconStatusFilter === "reconciled") return filteredLedgerTxns.filter((t) => t.isMatched);
    return filteredLedgerTxns.filter((t) => !t.isMatched);
  }, [filteredLedgerTxns, reconStatusFilter]);

  // ── "Not Found" overlay ────────────────────────────────────

  const showNotFoundOverlay = useMemo(() => {
    if (!hoveredStatementLineId || !recon) return false;
    const stmtLine = recon.statementLines.find((l) => l.id === hoveredStatementLineId);
    if (!stmtLine) return false;
    if (stmtLine.matchedJournalLineId) return false;
    const amountKey = Math.abs(Number.parseFloat(stmtLine.amount)).toFixed(2);
    if (unmatchedLedgerByAmount.has(amountKey)) return false;
    return true;
  }, [hoveredStatementLineId, recon, unmatchedLedgerByAmount]);

  return {
    // Queries
    detailQuery,
    activityQuery,
    suggestionsQuery,

    // Normalized recon
    recon,
    isFinalized,

    // Filter options
    periodPartyOptions,
    periodDepartmentOptions,
    periodLocationOptions,
    filteredPartyOptions,
    filteredDepartmentOptions,
    filteredLocationOptions,

    // Cross-hover lookups
    journalToStatementMap,
    unmatchedLedgerByAmount,
    statementLinePageMap,
    linkedLedgerTxnId,
    linkedStatementLineId,

    // Filtered lists
    filteredStatementLines,
    filteredLedgerTxns,
    filteredLedgerByStatus,

    // Metrics
    metrics,

    // Overlay
    showNotFoundOverlay,
  };
}
