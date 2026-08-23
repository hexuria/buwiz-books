/**
 * Reconciliation API — Read / List / Detail / Timeline / Report
 */
import { createServerFn } from "@tanstack/react-start";
import { moneyToCents } from "@/lib/money";
import {
  reconciliations,
  statementLines,
  reconciliationFlags,
} from "../../../db/schema/reconciliations";
import { financialAccounts } from "../../../db/schema/financial-accounts";
import {
  effectiveJournalPredicate,
  journalLines,
  journalHeaders,
} from "../../../db/schema/journals";
import { accounts } from "../../../db/schema/accounts";
import { parties } from "../../../db/schema/parties";
import { dimensions } from "../../../db/schema/dimensions";
import { alias } from "drizzle-orm/pg-core";
import { eq, and, desc, asc, sql, gte, lte, inArray } from "drizzle-orm";
import { documents } from "../../../db/schema/documents";
import { getPresignedDownloadUrl } from "../../../lib/storage";
import { withSessionOrgContext } from "../../../lib/server-context";
import { resolveCandidateAccountIds } from "../../../lib/resolve-candidate-accounts";
import { parseDocumentBoundingBoxes } from "../../../lib/document-types";

import { db } from "../../../db";

import {
  logger,
  formatCurrency,
  listReconciliationsSchema,
  getReconciliationSchema,
  getTimelineSchema,
  type ReconciliationListItem,
  type ReconciliationDetail,
  type LedgerTransaction,
  type ReconciliationSummary,
  type TimelineEntry,
} from "./-_shared";

/**
 * Ledger accounts subquery alias used by getReconciliationReportData.
 * Defined here (not in _shared) to avoid pulling `db` into client bundles.
 */
const ledgerAccountsAlias = db
  .select({ id: accounts.id, accountNumber: accounts.accountNumber })
  .from(accounts)
  .as("ledger_acct");

// ============================================================================
// Server Functions — Reads
// ============================================================================

/**
 * List reconciliations for the organization with bank account details
 */
export const listReconciliations = createServerFn({ method: "GET" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    return withSessionOrgContext(async ({ orgId, db }) => {
      const parsed = listReconciliationsSchema.parse(rawData ?? {});

      const conditions = [eq(reconciliations.organizationId, orgId)];
      if (parsed.dateFrom) {
        conditions.push(gte(reconciliations.periodStart, parsed.dateFrom));
      }
      if (parsed.dateTo) {
        conditions.push(lte(reconciliations.periodEnd, parsed.dateTo));
      }

      const rows = await db
        .select({
          id: reconciliations.id,
          bankAccountId: reconciliations.bankAccountId,
          bankAccountName: financialAccounts.accountName,
          bankAccountNumber: financialAccounts.lastFour,
          bankAccountType: financialAccounts.accountType,
          periodStart: reconciliations.periodStart,
          periodEnd: reconciliations.periodEnd,
          status: reconciliations.status,
          statementEndingBalance: reconciliations.statementEndingBalance,
          ledgerBalance: reconciliations.ledgerBalance,
          createdAt: reconciliations.createdAt,
        })
        .from(reconciliations)
        .innerJoin(financialAccounts, eq(reconciliations.bankAccountId, financialAccounts.id))
        .where(and(...conditions))
        .orderBy(desc(reconciliations.periodEnd));

      // Get match counts per reconciliation in a single query (eliminates N+1)
      const reconIds = rows.map((r) => r.id);
      const matchCountMap = new Map<
        string,
        { total: number; matched: number; unmatched: number }
      >();

      if (reconIds.length > 0) {
        const matchCounts = await db
          .select({
            reconciliationId: statementLines.reconciliationId,
            total: sql<number>`count(*)::int`,
            matched: sql<number>`count(*) filter (where ${statementLines.matchStatus} = 'matched')::int`,
            unmatched: sql<number>`count(*) filter (where ${statementLines.matchStatus} = 'unmatched')::int`,
          })
          .from(statementLines)
          .where(inArray(statementLines.reconciliationId, reconIds))
          .groupBy(statementLines.reconciliationId);

        for (const mc of matchCounts) {
          matchCountMap.set(mc.reconciliationId, {
            total: mc.total,
            matched: mc.matched,
            unmatched: mc.unmatched,
          });
        }
      }

      const result: ReconciliationListItem[] = rows.map((row) => {
        const counts = matchCountMap.get(row.id);
        return {
          ...row,
          matchedCount: counts?.matched ?? 0,
          unmatchedCount: counts?.unmatched ?? 0,
          totalStatementLines: counts?.total ?? 0,
        };
      });

      return result;
    });
  },
);

/**
 * Get a single reconciliation with all details
 */
export const getReconciliation = createServerFn({ method: "GET" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    return withSessionOrgContext(async ({ orgId, db }) => {
      const parsed = getReconciliationSchema.parse(rawData);

      // Get reconciliation with bank account info
      const [recon] = await db
        .select({
          id: reconciliations.id,
          bankAccountId: reconciliations.bankAccountId,
          ledgerAccountId: financialAccounts.ledgerAccountId,
          bankAccountName: financialAccounts.accountName,
          bankAccountNumber: financialAccounts.lastFour,
          accountType: financialAccounts.accountType,
          periodStart: reconciliations.periodStart,
          periodEnd: reconciliations.periodEnd,
          status: reconciliations.status,
          statementBeginningBalance: reconciliations.statementBeginningBalance,
          statementEndingBalance: reconciliations.statementEndingBalance,
          ledgerBalance: reconciliations.ledgerBalance,
          aiAutoFinalized: reconciliations.aiAutoFinalized,
          finalizedAt: reconciliations.finalizedAt,
          createdAt: reconciliations.createdAt,
          statementDocumentId: reconciliations.statementDocumentId,
          documentR2Key: documents.r2Key,
          previewImageR2Key: documents.previewImageR2Key,
          previewPageR2Keys: documents.previewPageR2Keys,
          docPageCount: documents.pageCount,
          ocrBoundingBoxes: documents.ocrBoundingBoxes,
          docOriginalFilename: documents.originalFilename,
          docMimeType: documents.mimeType,
          docFileSizeBytes: documents.fileSizeBytes,
        })
        .from(reconciliations)
        .innerJoin(financialAccounts, eq(reconciliations.bankAccountId, financialAccounts.id))
        .leftJoin(documents, eq(reconciliations.statementDocumentId, documents.id))
        .where(and(eq(reconciliations.id, parsed.id), eq(reconciliations.organizationId, orgId)))
        .limit(1);

      if (!recon) {
        throw new Error("Reconciliation not found");
      }

      // Generate presigned URL for statement PDF if valid
      let statementPdfUrl: string | null = null;
      if (recon.documentR2Key) {
        statementPdfUrl = await getPresignedDownloadUrl(recon.documentR2Key, { expiresIn: 3600 });
      }

      // Generate presigned URL for the preview image (PNG) for the interactive SVG viewer
      let statementPreviewImageUrl: string | null = null;
      if (recon.previewImageR2Key) {
        statementPreviewImageUrl = await getPresignedDownloadUrl(recon.previewImageR2Key, {
          expiresIn: 3600,
        });
      }

      // For PDFs missing previewPageR2Keys, regenerate multi-page previews on demand
      if (
        recon.docMimeType?.includes("pdf") &&
        !recon.previewPageR2Keys?.length &&
        recon.documentR2Key
      ) {
        try {
          const { downloadFromR2: dlFromR2 } = await import("@/lib/storage");
          const pdfBuffer = await dlFromR2(recon.documentR2Key);
          const pdfBase64 = pdfBuffer.toString("base64");

          const { generatePdfPreview } = await import("../-pdf-preview");
          await (generatePdfPreview as (opts: { data: unknown }) => Promise<any>)({
            data: {
              documentId: recon.statementDocumentId,
              pdfBase64,
              mimeType: recon.docMimeType,
            },
          });

          // Re-fetch updated preview keys
          if (recon.statementDocumentId) {
            const [updated] = await db
              .select({
                previewPageR2Keys: documents.previewPageR2Keys,
                previewImageR2Key: documents.previewImageR2Key,
                docPageCount: documents.pageCount,
              })
              .from(documents)
              .where(eq(documents.id, recon.statementDocumentId))
              .limit(1);
            if (updated) {
              recon.previewPageR2Keys = updated.previewPageR2Keys;
              recon.previewImageR2Key = updated.previewImageR2Key;
              recon.docPageCount = updated.docPageCount;
              // Also update single preview URL if needed
              if (updated.previewImageR2Key && !statementPreviewImageUrl) {
                statementPreviewImageUrl = await getPresignedDownloadUrl(
                  updated.previewImageR2Key,
                  {
                    expiresIn: 3600,
                  },
                );
              }
            }
          }
        } catch (err) {
          logger.error("Failed to generate reconciliation PDF preview pages", {
            error: err,
            reconciliationId: parsed.id,
          });
        }
      }

      // Generate presigned URLs for all preview pages (multi-page support)
      const statementPageImageUrls: string[] = [];
      const pageR2Keys = recon.previewPageR2Keys ?? [];
      for (const key of pageR2Keys) {
        if (key) {
          const url = await getPresignedDownloadUrl(key, { expiresIn: 3600 });
          if (url) statementPageImageUrls.push(url);
        }
      }
      // Fallback: if no page keys but single preview key, use it
      if (statementPageImageUrls.length === 0 && statementPreviewImageUrl) {
        statementPageImageUrls.push(statementPreviewImageUrl);
      }

      // Get statement lines (including ocrBbox for bounding box reconstruction)
      // Left-join journalLines to resolve matchedJournalHeaderId directly,
      // avoiding fragile in-memory lookups that fail when the matched line
      // isn't in the loaded ledger transactions array.
      const lines = await db
        .select({
          id: statementLines.id,
          transactionDate: statementLines.transactionDate,
          description: statementLines.description,
          amount: statementLines.amount,
          matchStatus: statementLines.matchStatus,
          matchConfidence: statementLines.matchConfidence,
          matchedJournalLineId: statementLines.matchedJournalLineId,
          matchedJournalHeaderId: journalLines.journalHeaderId,
          sortOrder: statementLines.sortOrder,
          ocrBbox: statementLines.ocrBbox,
          ocrPage: statementLines.ocrPage,
        })
        .from(statementLines)
        .leftJoin(journalLines, eq(statementLines.matchedJournalLineId, journalLines.id))
        .where(eq(statementLines.reconciliationId, parsed.id))
        .orderBy(asc(statementLines.sortOrder), asc(statementLines.transactionDate));

      // Get flags
      const flags = await db
        .select({
          id: reconciliationFlags.id,
          flagType: reconciliationFlags.flagType,
          suggestedAction: reconciliationFlags.suggestedAction,
          description: reconciliationFlags.description,
          resolved: reconciliationFlags.resolved,
          statementLineId: reconciliationFlags.statementLineId,
        })
        .from(reconciliationFlags)
        .where(eq(reconciliationFlags.reconciliationId, parsed.id));

      // Get ledger transactions for this account + period
      // Journal lines may be posted to the specific sub-account (ledgerAccountId)
      // OR to its parent group account (e.g., "Bank Accounts" #11000).
      // We query both to ensure we capture all relevant transactions.
      let ledgerTxns: any[] = [];

      if (recon.ledgerAccountId) {
        const candidateIds = await resolveCandidateAccountIds(db, recon.ledgerAccountId);

        const deptDim = alias(dimensions, "dept_dim");
        const locDim = alias(dimensions, "loc_dim");

        ledgerTxns = await db
          .select({
            id: journalLines.id,
            journalHeaderId: journalLines.journalHeaderId,
            transactionDate: journalHeaders.transactionDate,
            transactionNumber: journalHeaders.transactionNumber,
            description: journalLines.lineDescription,
            debit: journalLines.debit,
            credit: journalLines.credit,
            partyId: journalHeaders.partyId,
            partyName: parties.name,
            accountId: journalLines.accountId,
            accountName: accounts.name,
            source: journalHeaders.source,
            transactionType: journalHeaders.transactionType,
            journalStatus: journalHeaders.status,
            departmentId: journalLines.departmentId,
            departmentName: deptDim.name,
            locationId: journalLines.locationId,
            locationName: locDim.name,
          })
          .from(journalLines)
          .innerJoin(journalHeaders, eq(journalLines.journalHeaderId, journalHeaders.id))
          .innerJoin(accounts, eq(journalLines.accountId, accounts.id))
          .leftJoin(parties, eq(journalHeaders.partyId, parties.id))
          .leftJoin(deptDim, eq(journalLines.departmentId, deptDim.id))
          .leftJoin(locDim, eq(journalLines.locationId, locDim.id))
          .where(
            and(
              inArray(journalLines.accountId, candidateIds),
              eq(journalHeaders.organizationId, orgId),
              eq(journalHeaders.status, "posted"),
              effectiveJournalPredicate(),
              gte(journalHeaders.transactionDate, parsed.dateFrom ?? recon.periodStart),
              lte(journalHeaders.transactionDate, parsed.dateTo ?? recon.periodEnd),
            ),
          )
          .orderBy(asc(journalHeaders.transactionDate));
      }

      // Build matched set for quick lookup
      const matchedJournalLineIds = new Set(
        lines.filter((l) => l.matchedJournalLineId).map((l) => l.matchedJournalLineId),
      );

      // Supplementary query: fetch matched journal lines NOT already in ledgerTxns.
      // Statement lines may be matched to counterpart journal lines (expense/revenue side)
      // which are NOT on candidate bank accounts and therefore missing from ledgerTxns.
      const existingLedgerIds = new Set(ledgerTxns.map((t) => t.id));
      const missingIds = [...matchedJournalLineIds].filter(
        (id) => id && !existingLedgerIds.has(id),
      ) as string[];

      if (missingIds.length > 0) {
        const deptDim2 = alias(dimensions, "dept_dim2");
        const locDim2 = alias(dimensions, "loc_dim2");

        const missingTxns = await db
          .select({
            id: journalLines.id,
            journalHeaderId: journalLines.journalHeaderId,
            transactionDate: journalHeaders.transactionDate,
            transactionNumber: journalHeaders.transactionNumber,
            description: journalLines.lineDescription,
            debit: journalLines.debit,
            credit: journalLines.credit,
            partyId: journalHeaders.partyId,
            partyName: parties.name,
            accountId: journalLines.accountId,
            accountName: accounts.name,
            source: journalHeaders.source,
            transactionType: journalHeaders.transactionType,
            journalStatus: journalHeaders.status,
            departmentId: journalLines.departmentId,
            departmentName: deptDim2.name,
            locationId: journalLines.locationId,
            locationName: locDim2.name,
          })
          .from(journalLines)
          .innerJoin(journalHeaders, eq(journalLines.journalHeaderId, journalHeaders.id))
          .innerJoin(accounts, eq(journalLines.accountId, accounts.id))
          .leftJoin(parties, eq(journalHeaders.partyId, parties.id))
          .leftJoin(deptDim2, eq(journalLines.departmentId, deptDim2.id))
          .leftJoin(locDim2, eq(journalLines.locationId, locDim2.id))
          .where(
            and(
              inArray(journalLines.id, missingIds),
              eq(journalHeaders.organizationId, orgId),
              effectiveJournalPredicate(),
            ),
          );

        ledgerTxns = [...ledgerTxns, ...missingTxns];
      }

      // Resolve counterpart (category) accounts:
      // For each journal line, find the "other" account in the same journal entry
      const headerIds = [...new Set(ledgerTxns.map((t) => t.journalHeaderId))];
      const counterpartMap = new Map<string, { name: string; accountId: string }>();
      if (headerIds.length > 0) {
        const allLinesForHeaders = await db
          .select({
            id: journalLines.id,
            journalHeaderId: journalLines.journalHeaderId,
            accountId: journalLines.accountId,
            accountName: accounts.name,
          })
          .from(journalLines)
          .innerJoin(accounts, eq(journalLines.accountId, accounts.id))
          .where(inArray(journalLines.journalHeaderId, headerIds));

        // Group lines by header
        const linesByHeader = new Map<string, typeof allLinesForHeaders>();
        for (const line of allLinesForHeaders) {
          const arr = linesByHeader.get(line.journalHeaderId) ?? [];
          arr.push(line);
          linesByHeader.set(line.journalHeaderId, arr);
        }

        // For each ledger txn, find the counterpart (the other line in the same journal)
        for (const txn of ledgerTxns) {
          const siblingsInHeader = linesByHeader.get(txn.journalHeaderId) ?? [];
          const counterpart = siblingsInHeader.find(
            (l) => l.id !== txn.id && l.accountId !== txn.accountId,
          );
          if (counterpart) {
            counterpartMap.set(txn.id, {
              name: counterpart.accountName,
              accountId: counterpart.accountId,
            });
          }
        }
      }

      const ledgerTransactions: LedgerTransaction[] = ledgerTxns.map((t) => {
        // Integer cents (audit PR-15): amount is exact, and the summary sums
        // below accumulate cents rather than drifting floats.
        const debitCents = t.debit ? moneyToCents(t.debit, "debit") : 0;
        const creditCents = t.credit ? moneyToCents(t.credit, "credit") : 0;
        const counterpart = counterpartMap.get(t.id);
        return {
          id: t.id,
          journalHeaderId: t.journalHeaderId,
          transactionDate: t.transactionDate,
          transactionNumber: t.transactionNumber,
          description: t.description,
          debit: t.debit,
          credit: t.credit,
          amount: (debitCents - creditCents) / 100,
          partyId: t.partyId,
          partyName: t.partyName,
          accountId: t.accountId,
          accountName: t.accountName,
          categoryName: counterpart?.name ?? null,
          categoryAccountId: counterpart?.accountId ?? null,
          source: t.source,
          transactionType: t.transactionType,
          journalStatus: t.journalStatus,
          departmentId: t.departmentId,
          departmentName: t.departmentName,
          locationId: t.locationId,
          locationName: t.locationName,
          isMatched: !!matchedJournalLineIds.has(t.id),
        };
      });

      // Compute summary — all in integer cents, formatted once at the edge.
      const beginBalCents = moneyToCents(recon.statementBeginningBalance ?? "0", "balance");
      const endBalCents = moneyToCents(recon.statementEndingBalance ?? "0", "balance");
      const netTxnBankCents = endBalCents - beginBalCents;

      // Exclude ignored lines from bank-side totals — they don't represent real activity
      const activeLines = lines.filter((l) => l.matchStatus !== "ignored");
      const lineCents = (l: { amount: string }) => moneyToCents(l.amount, "amount");

      const totalDepositsBankCents = activeLines
        .filter((l) => lineCents(l) > 0)
        .reduce((sum, l) => sum + lineCents(l), 0);
      const totalWithdrawalsBankCents = activeLines
        .filter((l) => lineCents(l) < 0)
        .reduce((sum, l) => sum + Math.abs(lineCents(l)), 0);

      const totalDepositsLedgerCents = ledgerTransactions
        .filter((t) => t.amount > 0)
        .reduce((sum, t) => sum + Math.round(t.amount * 100), 0);
      const totalWithdrawalsLedgerCents = ledgerTransactions
        .filter((t) => t.amount < 0)
        .reduce((sum, t) => sum + Math.abs(Math.round(t.amount * 100)), 0);

      const unsettledCents = activeLines
        .filter((l) => l.matchStatus === "unmatched")
        .reduce((sum, l) => sum + Math.abs(lineCents(l)), 0);

      // Compute ledger balance dynamically: beginning balance + net ledger movement
      const netLedgerMovementCents = totalDepositsLedgerCents - totalWithdrawalsLedgerCents;
      const ledgerBalCents = beginBalCents + netLedgerMovementCents;
      const unreconciledDiffCents = endBalCents - ledgerBalCents;

      const summary: ReconciliationSummary = {
        endingBankBalance: formatCurrency(endBalCents / 100),
        openingBankBalance: formatCurrency(beginBalCents / 100),
        netTransactionsPerBank: formatCurrency(netTxnBankCents / 100),
        unsettledTransactions: formatCurrency(unsettledCents / 100),
        unreconciledDifference: formatCurrency(unreconciledDiffCents / 100),
        endingLedgerBalance: formatCurrency(ledgerBalCents / 100),
        totalDepositsBank: formatCurrency(totalDepositsBankCents / 100),
        totalDepositsLedger: formatCurrency(totalDepositsLedgerCents / 100),
        totalWithdrawalsBank: formatCurrency(totalWithdrawalsBankCents / 100),
        totalWithdrawalsLedger: formatCurrency(totalWithdrawalsLedgerCents / 100),
      };

      // Boxes are keyed by (page, fieldId); legacy rows encoded the page into
      // the id. Normalise once here so every consumer downstream sees a clean
      // semantic fieldId.
      const documentBoundingBoxes = parseDocumentBoundingBoxes(recon.ocrBoundingBoxes);

      // Calculate page count — prefer DB value, fallback to bounding box max page
      const pageCount =
        recon.docPageCount ??
        documentBoundingBoxes.reduce((max, box) => Math.max(max, box.page), 1) ??
        1;

      // Reconstruct viewer bounding boxes from statement lines' ocrBbox data
      // These feed the interactive SVG viewer on page load, matching the same
      // shape that the mutation `onSuccess` handlers produce.
      let statementLineBoundingBoxes = lines
        .filter((l) => l.ocrBbox && l.ocrBbox.length === 4)
        .map((l) => ({
          id: l.id,
          label: l.description,
          text: l.amount,
          bbox: l.ocrBbox as [number, number, number, number],
          page: l.ocrPage ?? 0,
          fieldType: "transaction" as const,
        }));

      // Fallback: if statement lines don't have individual ocrBbox but the document
      // has ocrBoundingBoxes (e.g. from /documents page AI detection), map those
      // line_item_N entries to statement lines by sortOrder index.
      if (
        statementLineBoundingBoxes.length === 0 &&
        documentBoundingBoxes.length > 0 &&
        lines.length > 0
      ) {
        // Extract line_item entries from ALL pages and sort by page then index
        const lineItemBoxes = documentBoundingBoxes
          .filter((b) => b.fieldId?.includes("line_item_"))
          .sort((a, b) => {
            // Sort by page first, then by line_item index within each page
            const pageDiff = (a.page ?? 0) - (b.page ?? 0);
            if (pageDiff !== 0) return pageDiff;
            const idxA = parseInt(a.fieldId.match(/line_item_(\d+)/)?.[1] ?? "0", 10);
            const idxB = parseInt(b.fieldId.match(/line_item_(\d+)/)?.[1] ?? "0", 10);
            return idxA - idxB;
          });

        // Sort statement lines by sortOrder to align with line_item indices
        const sortedLines = [...lines].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));

        statementLineBoundingBoxes = lineItemBoxes
          .map((box, i) => {
            const sl = sortedLines[i];
            if (!sl || !box.bbox || box.bbox.length !== 4) return null;
            return {
              id: sl.id,
              label: sl.description,
              text: sl.amount,
              bbox: box.bbox as [number, number, number, number],
              page: box.page ?? 0,
              fieldType: "transaction" as const,
            };
          })
          .filter(Boolean) as typeof statementLineBoundingBoxes;
      }

      return {
        ...recon,
        statementPdfUrl,
        statementPreviewImageUrl,
        statementPageImageUrls,
        statementPageCount: pageCount,
        statementLineBoundingBoxes,
        documentOcrBoundingBoxes: documentBoundingBoxes,
        statementLines: lines,
        flags,
        ledgerTransactions,
        summary,
        statementDocument: recon.statementDocumentId
          ? {
              id: recon.statementDocumentId,
              filename: recon.docOriginalFilename ?? "Statement",
              mimeType: recon.docMimeType,
              fileSizeBytes: recon.docFileSizeBytes,
            }
          : null,
      } as ReconciliationDetail;
    });
  },
);

/**
 * Get 12-month timeline for all bank accounts (reconciliation list page)
 */
export const getReconciliationTimeline = createServerFn({ method: "GET" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    return withSessionOrgContext(async ({ orgId, db }) => {
      const parsed = getTimelineSchema.parse(rawData ?? { year: new Date().getFullYear() });
      const { year } = parsed;

      // Get all bank accounts for this org
      const bankAccounts = await db
        .select({
          id: financialAccounts.id,
          accountName: financialAccounts.accountName,
          lastFour: financialAccounts.lastFour,
          accountType: financialAccounts.accountType,
        })
        .from(financialAccounts)
        .where(
          and(eq(financialAccounts.organizationId, orgId), eq(financialAccounts.isActive, true)),
        )
        .orderBy(asc(financialAccounts.accountName));

      // Get reconciliations for this year
      const yearStart = `${year}-01-01`;
      const yearEnd = `${year}-12-31`;

      const yearRecons = await db
        .select({
          id: reconciliations.id,
          bankAccountId: reconciliations.bankAccountId,
          periodStart: reconciliations.periodStart,
          periodEnd: reconciliations.periodEnd,
          status: reconciliations.status,
        })
        .from(reconciliations)
        .where(
          and(
            eq(reconciliations.organizationId, orgId),
            gte(reconciliations.periodStart, yearStart),
            lte(reconciliations.periodEnd, yearEnd),
          ),
        );

      // Build timeline entries
      const timeline: TimelineEntry[] = bankAccounts.map((acct) => {
        const months = Array.from({ length: 12 }, (_, i) => {
          const month = i + 1;
          const recon = yearRecons.find(
            (r) =>
              r.bankAccountId === acct.id &&
              new Date(`${r.periodStart}T00:00:00`).getMonth() + 1 === month,
          );

          if (!recon) {
            return { month, year, status: "no_activity" as const };
          }

          return {
            month,
            year,
            status: recon.status as "finalized" | "draft" | "in_progress" | "not_started",
            reconciliationId: recon.id,
          };
        });

        return {
          bankAccountId: acct.id,
          bankAccountName: acct.accountName ?? "Unnamed Account",
          bankAccountNumber: acct.lastFour,
          accountType: acct.accountType,
          months,
        };
      });

      return timeline;
    });
  },
);

/**
 * Get bank accounts available for reconciliation
 */
export const getBankAccounts = createServerFn({ method: "GET" }).handler(async () =>
  withSessionOrgContext(async ({ orgId, db }) => {
    const bankAccts = await db
      .select({
        id: financialAccounts.id,
        displayName: financialAccounts.accountName,
        accountNumber: financialAccounts.lastFour,
        accountType: financialAccounts.accountType,
        institutionName: financialAccounts.institutionName,
        isActive: financialAccounts.isActive,
      })
      .from(financialAccounts)
      .where(and(eq(financialAccounts.organizationId, orgId), eq(financialAccounts.isActive, true)))
      .orderBy(asc(financialAccounts.accountName));

    return bankAccts;
  }),
);

/**
 * Get activity log entries for a reconciliation
 */
export const getReconciliationActivityLog = createServerFn({ method: "GET" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    return withSessionOrgContext(async ({ orgId, db }) => {
      const parsed = getReconciliationSchema.parse(rawData);

      // Verify reconciliation belongs to org
      const [recon] = await db
        .select({ id: reconciliations.id })
        .from(reconciliations)
        .where(and(eq(reconciliations.id, parsed.id), eq(reconciliations.organizationId, orgId)))
        .limit(1);

      if (!recon) throw new Error("Reconciliation not found");

      const { activityLogs } = await import("../../../db/schema/activity-logs");

      const logs = await db
        .select({
          id: activityLogs.id,
          action: activityLogs.action,
          actorId: activityLogs.actorId,
          changes: activityLogs.changes,
          createdAt: activityLogs.createdAt,
        })
        .from(activityLogs)
        .where(
          and(
            eq(activityLogs.entityType, "reconciliation"),
            eq(activityLogs.entityId, parsed.id),
            eq(activityLogs.organizationId, orgId),
          ),
        )
        .orderBy(desc(activityLogs.createdAt));

      return logs.map((l) => ({
        ...l,
        createdAt: l.createdAt.toISOString(),
        // eslint-disable-next-line -- jsonb field may contain arbitrary nested values
        changes: (l.changes ?? null) as Record<string, {}> | null,
      }));
    });
  },
);

export const getReconciliationReportData = createServerFn({ method: "GET" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    return withSessionOrgContext(async ({ orgId, db, session }) => {
      const parsed = getReconciliationSchema.parse(rawData);

      // Get reconciliation with bank account info + COA account number
      const [recon] = await db
        .select({
          id: reconciliations.id,
          bankAccountId: reconciliations.bankAccountId,
          ledgerAccountId: financialAccounts.ledgerAccountId,
          bankAccountName: financialAccounts.accountName,
          bankAccountLastFour: financialAccounts.lastFour,
          coaAccountNumber: ledgerAccountsAlias.accountNumber,
          periodStart: reconciliations.periodStart,
          periodEnd: reconciliations.periodEnd,
          status: reconciliations.status,
          statementBeginningBalance: reconciliations.statementBeginningBalance,
          statementEndingBalance: reconciliations.statementEndingBalance,
          ledgerBalance: reconciliations.ledgerBalance,
          createdAt: reconciliations.createdAt,
          statementDocumentId: reconciliations.statementDocumentId,
          docOriginalFilename: documents.originalFilename,
          docMimeType: documents.mimeType,
          docFileSizeBytes: documents.fileSizeBytes,
        })
        .from(reconciliations)
        .innerJoin(financialAccounts, eq(reconciliations.bankAccountId, financialAccounts.id))
        .leftJoin(
          ledgerAccountsAlias,
          eq(financialAccounts.ledgerAccountId, ledgerAccountsAlias.id),
        )
        .leftJoin(documents, eq(reconciliations.statementDocumentId, documents.id))
        .where(and(eq(reconciliations.id, parsed.id), eq(reconciliations.organizationId, orgId)))
        .limit(1);

      if (!recon) throw new Error("Reconciliation not found");

      // Get ledger transactions with party names for this account + period
      const ledgerTxns = recon.ledgerAccountId
        ? await db
            .select({
              id: journalLines.id,
              transactionDate: journalHeaders.transactionDate,
              transactionType: journalHeaders.transactionType,
              description: journalLines.lineDescription,
              headerMemo: journalHeaders.memo,
              debit: journalLines.debit,
              credit: journalLines.credit,
              partyName: parties.name,
              accountName: accounts.name,
            })
            .from(journalLines)
            .innerJoin(journalHeaders, eq(journalLines.journalHeaderId, journalHeaders.id))
            .innerJoin(accounts, eq(journalLines.accountId, accounts.id))
            .leftJoin(parties, eq(journalHeaders.partyId, parties.id))
            .where(
              and(
                eq(journalLines.accountId, recon.ledgerAccountId),
                eq(journalHeaders.organizationId, orgId),
                eq(journalHeaders.status, "posted"),
                effectiveJournalPredicate(),
                gte(journalHeaders.transactionDate, recon.periodStart),
                lte(journalHeaders.transactionDate, recon.periodEnd),
              ),
            )
            .orderBy(asc(journalHeaders.transactionDate))
        : [];

      // Map transaction type to display name
      const TYPE_LABELS: Record<string, string> = {
        pay_in: "Pay In",
        pay_out: "Pay Out",
        journal: "Journal Entry",
        transfer: "Bank Transfer",
      };

      // For a checking/bank account:
      // Debits = money coming IN (pay_in) — debit on the bank account increases it
      // Credits = money going OUT (pay_out, transfer, journal) — credit decreases it
      const credits: Array<{ date: string; type: string; payee: string; amount: number }> = [];
      const debits: Array<{ date: string; type: string; payee: string; amount: number }> = [];

      for (const txn of ledgerTxns) {
        const debitAmt = txn.debit ? moneyToCents(txn.debit, "debit") / 100 : 0;
        const creditAmt = txn.credit ? moneyToCents(txn.credit, "credit") / 100 : 0;
        const payee = txn.partyName ?? txn.description ?? txn.headerMemo ?? "Unknown";
        const typeName = TYPE_LABELS[txn.transactionType] ?? txn.transactionType;

        if (creditAmt > 0) {
          // Credit on bank account = money going out
          credits.push({ date: txn.transactionDate, type: typeName, payee, amount: creditAmt });
        }
        if (debitAmt > 0) {
          // Debit on bank account = money coming in
          debits.push({ date: txn.transactionDate, type: typeName, payee, amount: debitAmt });
        }
      }

      const sessionUser = session?.user as { name?: string; email?: string } | undefined;
      const userName = sessionUser?.name ?? sessionUser?.email ?? "System";

      return {
        accountName: recon.bankAccountName,
        accountNumber: recon.coaAccountNumber ?? recon.bankAccountLastFour,
        periodStart: recon.periodStart,
        periodEnd: recon.periodEnd,
        preparedBy: userName,
        preparedDate: new Date().toLocaleDateString("en-US", {
          month: "2-digit",
          day: "2-digit",
          year: "numeric",
        }),
        statementEndingBalance: moneyToCents(recon.statementEndingBalance ?? "0", "balance") / 100,
        ledgerBalance: moneyToCents(recon.ledgerBalance ?? "0", "balance") / 100,
        credits,
        debits,

        statementDocument: recon.statementDocumentId
          ? {
              id: recon.statementDocumentId,
              filename: recon.docOriginalFilename ?? "Statement",
              mimeType: recon.docMimeType,
              fileSizeBytes: recon.docFileSizeBytes,
            }
          : null,
      };
    });
  },
);
