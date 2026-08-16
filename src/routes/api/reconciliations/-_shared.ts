/**
 * Reconciliation API — Shared types, schemas, logger, and helpers
 */
import { z } from "zod";
import { createLogger } from "../../../lib/logger";

export const logger = createLogger("api.reconciliations");

export { formatCurrency } from "@/utils/format";

// ============================================================================
// Schemas
// ============================================================================

export const listReconciliationsSchema = z.object({
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
});

export const getReconciliationSchema = z.object({
  id: z.string().uuid(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
});

export const createReconciliationSchema = z.object({
  bankAccountId: z.string().uuid(),
  periodStart: z.string(),
  periodEnd: z.string(),
  statementBeginningBalance: z.string().optional(),
  statementEndingBalance: z.string().optional(),
});

export const matchTransactionSchema = z.object({
  reconciliationId: z.string().uuid(),
  statementLineId: z.string().uuid(),
  journalLineId: z.string().uuid().nullable(),
  action: z.enum(["match", "unmatch", "ignore"]),
});

export const finalizeReconciliationSchema = z.object({
  id: z.string().uuid(),
});

export const getTimelineSchema = z.object({
  year: z.number().int(),
});

export const reconfigureReconciliationSchema = z.object({
  id: z.string().uuid(),
  periodStart: z.string(),
  periodEnd: z.string(),
  statementEndingBalance: z.string().optional(),
  statementBeginningBalance: z.string().optional(),
  charges: z.string().optional(),
  payments: z.string().optional(),
});

export const reopenReconciliationSchema = z.object({ id: z.string().uuid() });

export const deleteReconciliationSchema = z.object({ id: z.string().uuid() });

export const generateReconciliationStatementSchema = z.object({
  reconciliationId: z.string().uuid(),
});

// ============================================================================
// Types
// ============================================================================

export interface ReconciliationListItem {
  id: string;
  bankAccountId: string;
  bankAccountName: string;
  bankAccountNumber: string | null;
  bankAccountType: string | null;
  periodStart: string;
  periodEnd: string;
  status: string;
  statementEndingBalance: string | null;
  ledgerBalance: string | null;
  matchedCount: number;
  unmatchedCount: number;
  totalStatementLines: number;
  createdAt: Date;
}

export interface ReconciliationDetail {
  id: string;
  bankAccountId: string;
  bankAccountName: string;
  bankAccountNumber: string | null;
  /** Linked Ledger Account ID (if any) */
  ledgerAccountId: string | null;
  accountType: string | null;
  periodStart: string;
  periodEnd: string;
  status: string;
  statementBeginningBalance: string | null;
  statementEndingBalance: string | null;
  ledgerBalance: string | null;
  aiAutoFinalized: boolean | null;
  finalizedAt: Date | null;
  createdAt: Date;
  statementLines: StatementLineItem[];
  flags: FlagItem[];
  ledgerTransactions: LedgerTransaction[];
  summary: ReconciliationSummary;
  statementDocumentId: string | null;
  statementPdfUrl: string | null;
  statementPreviewImageUrl: string | null;
  statementPageImageUrls: string[];
  statementPageCount: number | null;
  statementLineBoundingBoxes: {
    id: string;
    label: string;
    text?: string;
    bbox: [number, number, number, number];
    page: number;
    fieldType: "transaction";
  }[];
  statementDocument: {
    id: string;
    filename: string;
    mimeType: string | null;
    fileSizeBytes: number | null;
  } | null;
}

export interface StatementLineItem {
  id: string;
  transactionDate: string;
  description: string;
  amount: string;
  matchStatus: string;
  matchConfidence: string | null;
  matchedJournalLineId: string | null;
  matchedJournalHeaderId: string | null;
  sortOrder: number | null;
}

export interface FlagItem {
  id: string;
  flagType: string;
  suggestedAction: string | null;
  description: string | null;
  resolved: boolean;
  statementLineId: string | null;
}

export interface LedgerTransaction {
  id: string;
  journalHeaderId: string;
  transactionDate: string;
  transactionNumber: string | null;
  description: string | null;
  debit: string | null;
  credit: string | null;
  amount: number;
  partyId: string | null;
  partyName: string | null;
  accountName: string;
  accountId: string;
  categoryName: string | null;
  categoryAccountId: string | null;
  source: string | null;
  transactionType: string;
  journalStatus: string;
  departmentId: string | null;
  departmentName: string | null;
  locationId: string | null;
  locationName: string | null;
  isMatched: boolean;
}

export interface ReconciliationSummary {
  endingBankBalance: string;
  openingBankBalance: string;
  netTransactionsPerBank: string;
  unsettledTransactions: string;
  unreconciledDifference: string;
  endingLedgerBalance: string;
  totalDepositsBank: string;
  totalDepositsLedger: string;
  totalWithdrawalsBank: string;
  totalWithdrawalsLedger: string;
}

export interface TimelineEntry {
  bankAccountId: string;
  bankAccountName: string;
  bankAccountNumber: string | null;
  accountType: string | null;
  months: Array<{
    month: number;
    year: number;
    status: "finalized" | "draft" | "in_progress" | "not_started" | "no_activity";
    reconciliationId?: string;
  }>;
}
