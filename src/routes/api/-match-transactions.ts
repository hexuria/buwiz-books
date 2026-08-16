/**
 * Safe transaction duplicate matching.
 *
 * The caller explicitly selects the canonical journal. Neither AI nor this
 * service changes canonical accounting metadata, and neither journal is ever
 * deleted. The duplicate is excluded from effective accounting through
 * journal_headers.duplicate_of_header_id until a lossless unmatch.
 */
import { createServerFn } from "@tanstack/react-start";
import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { journalHeaders } from "@/db/schema/journals";
import { parties } from "@/db/schema/parties";
import {
  mergeDuplicateJournals,
  previewDuplicateJournalMerge,
  unmergeDuplicateJournals,
} from "@/lib/journal-merge";
import {
  withMutationPermissionOrgContext,
  withPermissionOrgContext,
  withSessionOrgContext,
} from "@/lib/server-context";

const journalPairSchema = z
  .object({
    canonicalTransactionId: z.string().uuid(),
    duplicateTransactionId: z.string().uuid(),
  })
  .refine((value) => value.canonicalTransactionId !== value.duplicateTransactionId, {
    message: "Canonical and duplicate transactions must be different.",
  });

const matchTransactionsSchema = journalPairSchema.extend({
  duplicateCaseId: z.string().uuid().optional(),
  reason: z.string().trim().min(3).max(2_000),
  idempotencyKey: z.string().trim().min(8).max(255),
});

const unmatchTransactionSchema = z.object({
  mergeId: z.string().uuid(),
  reason: z.string().trim().min(3).max(2_000),
  idempotencyKey: z.string().trim().min(8).max(255),
});

const findMatchCandidatesSchema = z.object({
  transactionId: z.string().uuid(),
  limit: z.number().int().min(1).max(20).optional().default(10),
});

/**
 * Revalidatable preview. This is advisory only: matchTransactions repeats every
 * check under stable row locks in the write transaction.
 */
export const previewTransactionMerge = createServerFn({ method: "POST" }).handler(
  async ({ data: rawData }: { data: unknown }) =>
    withPermissionOrgContext("journal", "match", async ({ orgId, db }) => {
      const parsed = journalPairSchema.parse(rawData);
      return previewDuplicateJournalMerge(
        { db, orgId },
        {
          canonicalJournalId: parsed.canonicalTransactionId,
          duplicateJournalId: parsed.duplicateTransactionId,
        },
      );
    }),
);

/**
 * Confirm a duplicate without deleting or rewriting either journal.
 *
 * Intentionally no legacy `{ transactionIds: [a, b] }` compatibility path:
 * choosing a canonical implicitly (or through AI) would undermine the explicit
 * accounting decision this API is designed to enforce.
 */
export const matchTransactions = createServerFn({ method: "POST" }).handler(
  async ({ data: rawData }: { data: unknown }) =>
    withMutationPermissionOrgContext(
      "journal",
      "match",
      { routeKey: "transaction:match", limit: 20, windowMs: 300_000 },
      async ({ orgId, userId, db }) => {
        const parsed = matchTransactionsSchema.parse(rawData);
        const result = await mergeDuplicateJournals(
          { db, orgId, userId },
          {
            canonicalJournalId: parsed.canonicalTransactionId,
            duplicateJournalId: parsed.duplicateTransactionId,
            duplicateCaseId: parsed.duplicateCaseId,
            reason: parsed.reason,
            idempotencyKey: parsed.idempotencyKey,
          },
        );
        return {
          success: result.success,
          mergeId: result.mergeId,
          canonicalTransactionId: result.canonicalJournalId,
          duplicateTransactionId: result.duplicateJournalId,
          state: result.state,
          replayed: result.replayed,
        };
      },
    ),
);

/**
 * Reverse one exact duplicate decision. Because the original journal and lines
 * were retained, this only clears lineage and marks the audit row reversed.
 */
export const unmatchTransaction = createServerFn({ method: "POST" }).handler(
  async ({ data: rawData }: { data: unknown }) =>
    withMutationPermissionOrgContext(
      "journal",
      "unmatch",
      { routeKey: "transaction:unmatch", limit: 30, windowMs: 60_000 },
      async ({ orgId, userId, db }) => {
        const parsed = unmatchTransactionSchema.parse(rawData);
        const result = await unmergeDuplicateJournals(
          { db, orgId, userId },
          {
            mergeId: parsed.mergeId,
            reason: parsed.reason,
            idempotencyKey: parsed.idempotencyKey,
          },
        );
        return {
          success: result.success,
          mergeId: result.mergeId,
          canonicalTransactionId: result.canonicalJournalId,
          restoredTransactionId: result.duplicateJournalId,
          state: result.state,
          replayed: result.replayed,
        };
      },
    ),
);

/**
 * Lightweight candidate discovery only. It never decides that two journals are
 * duplicates and excludes journals already suppressed by a confirmed merge.
 */
export const findMatchCandidates = createServerFn({ method: "GET" }).handler(
  async ({ data: rawData }: { data: unknown }) =>
    withSessionOrgContext(async ({ orgId, db }) => {
      const parsed = findMatchCandidatesSchema.parse(rawData);

      const [source] = await db
        .select({
          id: journalHeaders.id,
          totalAmount: journalHeaders.totalAmount,
          transactionCurrency: journalHeaders.transactionCurrency,
          functionalCurrency: journalHeaders.functionalCurrency,
          transactionType: journalHeaders.transactionType,
          originalDebitTotal: sql<string>`(
            select coalesce(sum(coalesce(source_lines.original_debit, source_lines.debit, 0)), 0)::text
            from journal_lines source_lines
            where source_lines.journal_header_id = ${journalHeaders.id}
          )`,
        })
        .from(journalHeaders)
        .where(
          and(
            eq(journalHeaders.id, parsed.transactionId),
            eq(journalHeaders.organizationId, orgId),
            isNull(journalHeaders.duplicateOfHeaderId),
          ),
        )
        .limit(1);

      if (!source) throw new Error("Effective transaction not found.");
      if (!source.totalAmount) return [];

      const sourceCurrency = source.transactionCurrency ?? source.functionalCurrency;
      const candidates = await db
        .select({
          id: journalHeaders.id,
          transactionNumber: journalHeaders.transactionNumber,
          transactionDate: journalHeaders.transactionDate,
          transactionType: journalHeaders.transactionType,
          memo: journalHeaders.memo,
          totalAmount: journalHeaders.totalAmount,
          status: journalHeaders.status,
          partyId: journalHeaders.partyId,
          isMatched: journalHeaders.isMatched,
        })
        .from(journalHeaders)
        .where(
          and(
            eq(journalHeaders.organizationId, orgId),
            ne(journalHeaders.id, parsed.transactionId),
            eq(journalHeaders.status, "posted"),
            eq(journalHeaders.transactionType, source.transactionType),
            isNull(journalHeaders.duplicateOfHeaderId),
            sql`(
              select coalesce(sum(coalesce(candidate_lines.original_debit, candidate_lines.debit, 0)), 0)
              from journal_lines candidate_lines
              where candidate_lines.journal_header_id = ${journalHeaders.id}
            ) = ${source.originalDebitTotal}::numeric`,
            sql`coalesce(${journalHeaders.transactionCurrency}, ${journalHeaders.functionalCurrency}) = ${sourceCurrency}`,
          ),
        )
        .limit(parsed.limit);

      const partyIds = [
        ...new Set(candidates.flatMap((row) => (row.partyId ? [row.partyId] : []))),
      ];
      const partyRows =
        partyIds.length === 0
          ? []
          : await db
              .select({ id: parties.id, name: parties.name })
              .from(parties)
              .where(and(eq(parties.organizationId, orgId), inArray(parties.id, partyIds)));
      const partyMap = new Map(partyRows.map((party) => [party.id, party.name]));

      return candidates.map((candidate) => ({
        ...candidate,
        partyName: candidate.partyId ? (partyMap.get(candidate.partyId) ?? null) : null,
      }));
    }),
);
